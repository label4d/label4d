import { EventEmitter } from '../events/EventEmitter';

export interface SchedulerStats {
  queued: number; running: number; loaded: number; loadedBytes: number;
  reservedBytes: number; evictions: number; failures: number;
}
export interface ResourceOptions<T> {
  bytes?: (resource: T) => number;
  dispose?: (resource: T) => void;
  pinned?: boolean;
}
interface Entry {
  id: string; priority: number; bytes: number; state: 'queued' | 'running' | 'loaded';
  resource: unknown; lastUse: number; discard: boolean; pinned: boolean;
  controller: AbortController; load: (signal: AbortSignal) => Promise<unknown>;
  actualBytes?: (resource: unknown) => number; dispose?: (resource: unknown) => void;
  resolve: (value: unknown) => void; reject: (reason: unknown) => void; promise: Promise<unknown>;
}
export interface TileSchedulerOptions {
  concurrency?: number; budgetBytes?: number;
  onEvict?: (id: string, resource: unknown) => void;
}
export const cancelledError = (id: string) => Object.assign(new Error(`cancelled: ${id}`), { name: 'AbortError' });

/** Owns streamed decoded resources. Admission includes running output reservations. */
export class TileScheduler {
  readonly events = new EventEmitter<{ evicted: { id: string }; failed: { id: string; error: unknown } }>();
  private entries = new Map<string, Entry>();
  private running = 0;
  private loadedBytes = 0;
  private reservedBytes = 0;
  private evictionCount = 0;
  private failureCount = 0;
  private clock = 0;
  private disposed = false;
  private readonly concurrency: number;
  private readonly budgetBytes: number;
  constructor(private readonly options: TileSchedulerOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 6);
    this.budgetBytes = options.budgetBytes ?? Infinity;
  }

  request<T>(id: string, priority: number, bytes: number, load: (signal: AbortSignal) => Promise<T>, options: ResourceOptions<T> = {}): Promise<T> {
    if (this.disposed) return Promise.reject(cancelledError(id));
    if (!Number.isFinite(bytes) || bytes < 0) return Promise.reject(new Error('Invalid resource estimate'));
    const existing = this.entries.get(id);
    if (existing) {
      existing.lastUse = this.clock++;
      existing.priority = Math.max(existing.priority, priority);
      return existing.promise as Promise<T>;
    }
    let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => { resolve = res; reject = rej; });
    this.entries.set(id, { id, priority, bytes, load, state: 'queued', resource: undefined,
      lastUse: this.clock++, discard: false, pinned: options.pinned ?? false, controller: new AbortController(),
      actualBytes: options.bytes as Entry['actualBytes'], dispose: options.dispose as Entry['dispose'], resolve, reject, promise });
    // Batch same-turn submissions so the current frame wins over prefetch.
    queueMicrotask(() => this.pump());
    return promise as Promise<T>;
  }
  isResident(id: string, resource: unknown): boolean { const entry = this.entries.get(id); return entry?.state === 'loaded' && entry.resource === resource; }
  reprioritize(id: string, priority: number): void {
    const entry = this.entries.get(id);
    if (entry) entry.priority = priority;
  }
  pin(id: string, pinned: boolean): void { const entry = this.entries.get(id); if (entry) entry.pinned = pinned; }
  touch(id: string): void { const entry = this.entries.get(id); if (entry) entry.lastUse = this.clock++; }
  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.state === 'loaded') { this.release(id); return; }
    entry.discard = true;
    entry.controller.abort();
    if (entry.state === 'queued') { this.entries.delete(id); entry.reject(cancelledError(id)); }
  }
  release(id: string): void {
    const entry = this.entries.get(id);
    if (entry?.state === 'loaded') this.drop(entry);
  }
  dispose(): void {
    this.disposed = true;
    for (const id of [...this.entries.keys()]) this.cancel(id);
  }
  stats(): SchedulerStats {
    return { queued: [...this.entries.values()].filter((e) => e.state === 'queued').length,
      running: this.running, loaded: [...this.entries.values()].filter((e) => e.state === 'loaded').length,
      loadedBytes: this.loadedBytes, reservedBytes: this.reservedBytes,
      evictions: this.evictionCount, failures: this.failureCount };
  }
  private makeRoom(bytes: number, except?: Entry): boolean {
    while (this.loadedBytes + this.reservedBytes + bytes > this.budgetBytes) {
      const victims = [...this.entries.values()].filter((e) => e.state === 'loaded' && !e.pinned && e !== except)
        .sort((a, b) => a.priority - b.priority || a.lastUse - b.lastUse);
      if (!victims.length) return false;
      this.drop(victims[0]);
    }
    return true;
  }
  private pump(): void {
    if (this.disposed) return;
    while (this.running < this.concurrency) {
      const entry = [...this.entries.values()].filter((e) => e.state === 'queued').sort((a, b) => b.priority - a.priority)[0];
      if (!entry) return;
      if (!this.makeRoom(entry.bytes)) {
        // Running reservations may finish soon. Pinned resident data cannot be evicted.
        if (this.running && entry.bytes <= this.budgetBytes) return;
        this.entries.delete(entry.id);
        const error = new Error(`Resource budget cannot admit ${entry.id}`);
        this.failureCount++; entry.reject(error); this.events.emit('failed', { id: entry.id, error });
        continue;
      }
      entry.state = 'running'; this.running++; this.reservedBytes += entry.bytes;
      const estimate = entry.bytes;
      Promise.resolve().then(() => entry.load(entry.controller.signal)).then((resource) => {
        this.reservedBytes -= estimate;
        entry.resource = resource;
        if (entry.discard || this.disposed) {
          this.entries.delete(entry.id); this.destroy(entry); entry.reject(cancelledError(entry.id)); return;
        }
        const actual = entry.actualBytes?.(resource) ?? estimate;
        if (!Number.isFinite(actual) || actual < 0 || !this.makeRoom(actual, entry)) {
          this.entries.delete(entry.id); this.destroy(entry);
          throw new Error(`Decoded resource exceeds budget: ${entry.id}`);
        }
        entry.bytes = actual; entry.state = 'loaded'; this.loadedBytes += actual;
        entry.resolve(resource);
      }, (error) => {
        this.reservedBytes -= estimate;
        throw error;
      }).catch((error) => {
        this.entries.delete(entry.id);
        if (error?.name !== 'AbortError') { this.failureCount++; this.events.emit('failed', { id: entry.id, error }); }
        entry.reject(error);
      }).finally(() => { this.running--; this.pump(); });
    }
  }
  private destroy(entry: Entry): void {
    if (entry.dispose) entry.dispose(entry.resource);
    else this.options.onEvict?.(entry.id, entry.resource);
  }
  private drop(entry: Entry): void {
    this.loadedBytes -= entry.bytes; this.entries.delete(entry.id); this.evictionCount++;
    this.destroy(entry); this.events.emit('evicted', { id: entry.id });
  }
}

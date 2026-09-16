import { EventEmitter } from '../events/EventEmitter';

export interface SchedulerStats {
  queued: number;
  running: number;
  loaded: number;
  loadedBytes: number;
  evictions: number;
  failures: number;
}

interface Entry {
  id: string;
  priority: number;
  bytes: number;
  state: 'queued' | 'running' | 'loaded' | 'failed';
  resource: unknown;
  lastUse: number;
  discard: boolean;
  load: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  promise: Promise<unknown>;
}

export interface TileSchedulerOptions {
  concurrency?: number;
  budgetBytes?: number;
  /** Called when the budget forces eviction of a loaded resource. */
  onEvict?: (id: string, resource: unknown) => void;
}

/**
 * Single scheduler for every streamed resource (point-cloud frames, BEV
 * tiles, height tiles, potree nodes). Priorities are "higher = more urgent";
 * negative priorities are fine (e.g. -distance for prefetch).
 */
export class TileScheduler {
  readonly events = new EventEmitter<{ evicted: { id: string }; failed: { id: string; error: unknown } }>();

  private entries = new Map<string, Entry>();
  private running = 0;
  private loadedBytes = 0;
  private evictionCount = 0;
  private failureCount = 0;
  private clock = 0;
  private readonly concurrency: number;
  private readonly budgetBytes: number;
  private readonly onEvict?: (id: string, resource: unknown) => void;

  constructor(options: TileSchedulerOptions = {}) {
    this.concurrency = Math.max(1, options.concurrency ?? 6);
    this.budgetBytes = options.budgetBytes ?? Number.POSITIVE_INFINITY;
    this.onEvict = options.onEvict;
  }

  request<T>(id: string, priority: number, bytes: number, load: () => Promise<T>): Promise<T> {
    const existing = this.entries.get(id);
    if (existing) {
      existing.lastUse = this.clock++;
      if (priority > existing.priority) existing.priority = priority;
      if (existing.state === 'loaded') {
        // resource already available (eviction owner may still hold it)
        return Promise.resolve(existing.resource as T);
      }
      return existing.promise as Promise<T>;
    }

    let resolve!: (v: unknown) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const entry: Entry = {
      id,
      priority,
      bytes,
      state: 'queued',
      resource: undefined,
      lastUse: this.clock++,
      discard: false,
      load,
      resolve,
      reject,
      promise,
    };
    this.entries.set(id, entry);
    this.pump();
    return promise as Promise<T>;
  }

  /** Upgrade urgency of a queued/running request without duplicating it. */
  reprioritize(id: string, priority: number): void {
    const entry = this.entries.get(id);
    if (entry && priority > entry.priority) {
      entry.priority = priority;
      if (entry.state === 'queued') this.pump();
    }
  }

  touch(id: string): void {
    const entry = this.entries.get(id);
    if (entry) entry.lastUse = this.clock++;
  }

  cancel(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    if (entry.state === 'queued') {
      entry.reject(new Error(`cancelled: ${id}`));
      this.entries.delete(id);
    } else if (entry.state === 'running') {
      entry.discard = true; // drop as soon as it settles
    }
  }

  /** Explicitly free a loaded resource (owner drops it) — same path as LRU eviction. */
  release(id: string): void {
    const entry = this.entries.get(id);
    if (!entry || entry.state !== 'loaded') return;
    this.dropEntry(entry);
  }

  stats(): SchedulerStats {
    let queued = 0;
    let running = 0;
    let loaded = 0;
    for (const entry of this.entries.values()) {
      if (entry.state === 'queued') queued++;
      else if (entry.state === 'running') running++;
      else if (entry.state === 'loaded') loaded++;
    }
    return {
      queued,
      running,
      loaded,
      loadedBytes: this.loadedBytes,
      evictions: this.evictionCount,
      failures: this.failureCount,
    };
  }

  private pump(): void {
    while (this.running < this.concurrency) {
      let best: Entry | null = null;
      for (const entry of this.entries.values()) {
        if (entry.state !== 'queued') continue;
        if (!best || entry.priority > best.priority) best = entry;
      }
      if (!best) return;
      best.state = 'running';
      this.running++;
      best
        .load()
        .then((resource) => {
          best.resource = resource;
          best.state = 'loaded';
          if (best.discard) {
            this.dropEntry(best);
          } else {
            this.loadedBytes += best.bytes;
            this.maybeEvict();
          }
          best.resolve(resource);
        })
        .catch((error) => {
          best.state = 'failed';
          this.failureCount++;
          this.events.emit('failed', { id: best.id, error });
          best.reject(error);
          this.entries.delete(best.id);
        })
        .finally(() => {
          this.running--;
          this.pump();
        });
    }
  }

  private maybeEvict(): void {
    while (this.loadedBytes > this.budgetBytes) {
      let victim: Entry | null = null;
      for (const entry of this.entries.values()) {
        if (entry.state !== 'loaded' || entry.discard) continue;
        if (!victim || entry.lastUse < victim.lastUse) victim = entry;
      }
      if (!victim) return;
      this.dropEntry(victim);
    }
  }

  /** Evict a loaded resource: bytes freed, owner disposes via onEvict. */
  private dropEntry(entry: Entry): void {
    this.loadedBytes -= entry.bytes;
    this.entries.delete(entry.id);
    this.evictionCount++;
    this.onEvict?.(entry.id, entry.resource);
    this.events.emit('evicted', { id: entry.id });
  }
}

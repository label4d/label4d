import { EventEmitter } from '../events/EventEmitter';
import { cancelledError } from './TileScheduler';
import type { TileScheduler } from './TileScheduler';
export interface FrameProvider<T> {
  load(frame: number, signal?: AbortSignal): Promise<T>;
  bytes(item: T): number; dispose(item: T): void;
}
export interface FrameBufferOptions {
  windowAhead?: number; windowBehind?: number; budgetBytes?: number; idPrefix?: string;
  frameCount?: number; estimateBytes?: number;
}
export interface FrameBufferStats { cached: number; pending: number; bytes: number; evictions: number }
interface CacheItem<T> { item: T; bytes: number }
let bufferId = 0;

/** A cache view into scheduler-owned resources. Current and presented frames are pinned. */
export class FrameBuffer<T> {
  readonly events = new EventEmitter<{ loaded: { frame: number }; evicted: { frame: number }; failed: { frame: number; error: unknown } }>();
  private cache = new Map<number, CacheItem<T>>();
  private pending = new Map<number, Promise<T>>();
  private failures = new Map<number, unknown>();
  private current = -1;
  private presented = -1;
  private generation = 0;
  private disposed = false;
  private totalBytes = 0;
  private evictionCount = 0;
  private readonly prefix: string;
  private readonly offEvict: () => void;
  constructor(private readonly provider: FrameProvider<T>, private readonly scheduler: TileScheduler,
    private readonly options: FrameBufferOptions = {}) {
    this.prefix = `${options.idPrefix ?? 'frame'}:buffer${++bufferId}`;
    this.offEvict = scheduler.events.on('evicted', ({ id }) => {
      for (const [frame, entry] of this.cache) if (this.frameId(frame) === id) {
        this.cache.delete(frame); this.totalBytes -= entry.bytes; this.evictionCount++;
        this.events.emit('evicted', { frame }); break;
      }
    });
  }
  get currentFrame(): number { return this.current; }
  setPresented(frame: number): void {
    const old = this.presented; this.presented = frame;
    if (old >= 0) this.scheduler.pin(this.frameId(old), old === this.current || old === frame);
    if (frame >= 0) this.scheduler.pin(this.frameId(frame), true);
  }
  setFrame(frame: number): void {
    if (frame === this.current) return;
    const old = this.current; this.current = frame;
    if (old >= 0) this.scheduler.pin(this.frameId(old), old === this.presented);
    this.scheduler.pin(this.frameId(frame), true);
    this.prefetch(); this.trim();
  }
  get(frame: number): T | undefined { this.scheduler.touch(this.frameId(frame)); return this.cache.get(frame)?.item; }
  isLoaded(frame: number): boolean { return this.cache.has(frame); }
  isPending(frame: number): boolean { return this.pending.has(frame); }
  retry(frame: number): Promise<T> { this.failures.delete(frame); return this.ensure(frame); }
  ensure(frame: number): Promise<T> {
    if (this.disposed) return Promise.reject(cancelledError(this.prefix));
    if (!Number.isSafeInteger(frame) || frame < 0 || (this.options.frameCount !== undefined && frame >= this.options.frameCount)) {
      return Promise.reject(new Error('Frame out of range'));
    }
    const cached = this.cache.get(frame); if (cached) return Promise.resolve(cached.item);
    const pending = this.pending.get(frame); if (pending) return pending;
    if (this.failures.has(frame)) return Promise.reject(this.failures.get(frame));
    const generation = this.generation, id = this.frameId(frame);
    const promise = this.scheduler.request(id, frame === this.current ? 100 : -Math.abs(frame - this.current),
      this.options.estimateBytes ?? 1024 * 1024, (signal) => this.provider.load(frame, signal),
      { bytes: this.provider.bytes, dispose: this.provider.dispose, pinned: frame === this.current || frame === this.presented })
      .then((item) => {
        if (generation !== this.generation || this.disposed || !this.scheduler.isResident(id, item)) { this.scheduler.release(id); throw cancelledError(id); }
        const bytes = this.provider.bytes(item);
        this.cache.set(frame, { item, bytes }); this.totalBytes += bytes;
        this.pending.delete(frame); this.events.emit('loaded', { frame }); this.trim(); return item;
      }).catch((error) => {
        if (generation === this.generation && !this.disposed) {
          this.pending.delete(frame);
          if (error?.name !== 'AbortError') { this.failures.set(frame, error); this.events.emit('failed', { frame, error }); }
        }
        throw error;
      });
    this.pending.set(frame, promise); return promise;
  }
  stats(): FrameBufferStats { return { cached: this.cache.size, pending: this.pending.size, bytes: this.totalBytes, evictions: this.evictionCount }; }
  clear(): void {
    const ids = new Set([...this.cache.keys(), ...this.pending.keys()]);
    for (const frame of ids) this.scheduler.cancel(this.frameId(frame));
    this.generation++; this.cache.clear(); this.pending.clear(); this.failures.clear();
    this.totalBytes = 0; this.current = -1; this.presented = -1;
  }
  dispose(): void { this.disposed = true; this.clear(); this.offEvict(); this.events.clear(); }
  private frameId(frame: number): string { return `${this.prefix}:g${this.generation}:${frame}`; }
  private prefetch(): void {
    const ahead = this.options.windowAhead ?? 3, behind = this.options.windowBehind ?? 1;
    const frames = Array.from({ length: ahead + behind + 1 }, (_, i) => this.current + i - behind)
      .filter((f) => f >= 0 && (this.options.frameCount === undefined || f < this.options.frameCount))
      .sort((a, b) => Math.abs(a - this.current) - Math.abs(b - this.current));
    for (const frame of frames) { this.scheduler.reprioritize(this.frameId(frame), frame === this.current ? 100 : -Math.abs(frame - this.current)); this.ensure(frame).catch(() => {}); }
    for (const frame of this.pending.keys()) if (frame < this.current - behind || frame > this.current + ahead) {
      if (frame !== this.presented) this.scheduler.cancel(this.frameId(frame));
    }
  }
  private trim(): void {
    const budget = this.options.budgetBytes ?? 512 * 1024 * 1024;
    for (const frame of [...this.cache.keys()].sort((a, b) => Math.abs(b - this.current) - Math.abs(a - this.current))) {
      if (this.totalBytes <= budget) break;
      if (frame !== this.current && frame !== this.presented) this.scheduler.release(this.frameId(frame));
    }
  }
}

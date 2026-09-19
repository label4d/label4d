import { EventEmitter } from '../events/EventEmitter';
import type { TileScheduler } from './TileScheduler';

export interface FrameProvider<T> {
  load(frame: number): Promise<T>;
  bytes(item: T): number;
  dispose(item: T): void;
}

export interface FrameBufferOptions {
  windowAhead?: number;
  windowBehind?: number;
  budgetBytes?: number;
  /** scheduler request-id namespace; must be unique per buffer (pcd/image/...) */
  idPrefix?: string;
  /** 序列总帧数：预取不得越过末尾帧，避免请求不存在的文件 */
  frameCount?: number;
}

export interface FrameBufferStats {
  cached: number;
  pending: number;
  bytes: number;
  evictions: number;
}

interface CacheItem<T> {
  item: T;
  bytes: number;
}

/**
 * Ring-buffer style frame cache with prefetch window and byte budget.
 * Prefetch priority decays with distance from the playhead; eviction picks
 * frames farthest from the playhead first.
 */
export class FrameBuffer<T> {
  readonly events = new EventEmitter<{
    loaded: { frame: number };
    evicted: { frame: number };
    failed: { frame: number; error: unknown };
  }>();

  private cache = new Map<number, CacheItem<T>>();
  private pending = new Map<number, Promise<T>>();
  private current = -1;
  private evictionCount = 0;
  private totalBytes = 0;
  private readonly ahead: number;
  private readonly behind: number;
  private readonly budget: number;
  private readonly idPrefix: string;
  private readonly frameCount: number | null;

  constructor(
    private readonly provider: FrameProvider<T>,
    private readonly scheduler: TileScheduler,
    options: FrameBufferOptions = {}
  ) {
    this.ahead = Math.max(0, options.windowAhead ?? 45);
    this.behind = Math.max(0, options.windowBehind ?? 45);
    this.budget = options.budgetBytes ?? 512 * 1024 * 1024;
    this.idPrefix = options.idPrefix ?? 'frame';
    this.frameCount = options.frameCount ?? null;
  }

  setFrame(frame: number): void {
    if (frame === this.current) return;
    this.current = frame;
    this.prefetch();
    this.trim();
  }

  get currentFrame(): number {
    return this.current;
  }

  get(frame: number): T | undefined {
    const entry = this.cache.get(frame);
    if (!entry) return undefined;
    this.scheduler.touch(this.frameId(frame));
    return entry.item;
  }

  isLoaded(frame: number): boolean {
    return this.cache.has(frame);
  }

  isPending(frame: number): boolean {
    return this.pending.has(frame);
  }

  /** Explicit load (also used when seeking outside the window). */
  ensure(frame: number): Promise<T> {
    const cached = this.cache.get(frame);
    if (cached) return Promise.resolve(cached.item);
    const inFlight = this.pending.get(frame);
    if (inFlight) return inFlight;
    const distance = this.current >= 0 ? Math.abs(frame - this.current) : 0;
    const priority = -distance;
    // 体积估算（PCD ~60k 点 × 16B ≈ 1MB），调度器字节预算据此记账
    const estimate = 1 * 1024 * 1024;
    const promise = this.scheduler
      .request<T>(this.frameId(frame), priority, estimate, () => this.provider.load(frame))
      .then((item) => {
        const bytes = this.provider.bytes(item);
        this.cache.set(frame, { item, bytes });
        this.totalBytes += bytes;
        this.pending.delete(frame);
        this.events.emit('loaded', { frame });
        this.trim();
        return item;
      })
      .catch((error) => {
        this.pending.delete(frame);
        this.events.emit('failed', { frame, error });
        throw error;
      });
    this.pending.set(frame, promise);
    return promise;
  }

  stats(): FrameBufferStats {
    return {
      cached: this.cache.size,
      pending: this.pending.size,
      bytes: this.totalBytes,
      evictions: this.evictionCount,
    };
  }

  clear(): void {
    for (const [frame, entry] of this.cache) {
      this.provider.dispose(entry.item);
      this.scheduler.cancel(this.frameId(frame));
      this.events.emit('evicted', { frame });
    }
    this.cache.clear();
    this.totalBytes = 0;
    this.evictionCount = 0;
  }

  private frameId(frame: number): string {
    return `${this.idPrefix}:${frame}`;
  }

  private prefetch(): void {
    const lastFrame = this.frameCount !== null ? this.frameCount - 1 : Infinity;
    for (let d = -this.behind; d <= this.ahead; d++) {
      const frame = this.current + d;
      if (frame < 0 || frame > lastFrame) continue;
      if (this.cache.has(frame) || this.pending.has(frame)) continue;
      this.ensure(frame).catch(() => undefined); // failures surface via events
    }
    // cancel far out-of-window pending requests
    for (const frame of this.pending.keys()) {
      if (Math.abs(frame - this.current) > Math.max(this.ahead, this.behind) * 2) {
        this.scheduler.cancel(this.frameId(frame));
      }
    }
  }

  private trim(): void {
    if (this.totalBytes <= this.budget) return;
    const byDistance = [...this.cache.keys()].sort(
      (a, b) => Math.abs(b - this.current) - Math.abs(a - this.current)
    );
    for (const frame of byDistance) {
      if (this.totalBytes <= this.budget) break;
      if (frame === this.current) continue;
      const entry = this.cache.get(frame);
      if (!entry) continue;
      this.cache.delete(frame);
      this.totalBytes -= entry.bytes;
      this.provider.dispose(entry.item);
      // release 释放已加载资源（cancel 只管排队/运行中，对已加载无效）
      this.scheduler.release(this.frameId(frame));
      this.evictionCount++;
      this.events.emit('evicted', { frame });
    }
  }
}

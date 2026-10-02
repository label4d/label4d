import { EventEmitter } from '../events/EventEmitter';
import { clamp } from '../geometry/math';

export interface PlayheadEvents {
  frame: { frame: number };
  playing: { playing: boolean };
}

export type RafFn = (cb: (timestamp: number) => void) => number;
export type CancelRafFn = (id: number) => void;

export const browserRaf: RafFn = (cb) => requestAnimationFrame(cb);
export const browserCancelRaf: CancelRafFn = (id) => cancelAnimationFrame(id);

const fallbackRaf: RafFn = (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number;
const fallbackCancel: CancelRafFn = (id) => clearTimeout(id);

/**
 * Frame clock. Playback pauses on any editing intent (session pauses before
 * applying edit commands) so the editor frame never drifts under the cursor.
 */
export class Playhead {
  readonly events = new EventEmitter<PlayheadEvents>();

  canAdvance: () => boolean = () => true;
  fps = 10;
  speed = 1;
  loop = true;

  private _frame = 0;
  private _playing = false;
  private accumulator = 0;
  private lastTimestamp = 0;
  private rafId: number | null = null;
  private readonly raf: RafFn;
  private readonly cancelRaf: CancelRafFn;

  constructor(
    private frameCount: number,
    raf?: RafFn,
    cancelRaf?: CancelRafFn
  ) {
    this.raf = raf ?? (typeof requestAnimationFrame !== 'undefined' ? browserRaf : fallbackRaf);
    this.cancelRaf = cancelRaf ?? (typeof cancelAnimationFrame !== 'undefined' ? browserCancelRaf : fallbackCancel);
  }

  get frame(): number {
    return this._frame;
  }

  get playing(): boolean {
    return this._playing;
  }

  setFrameCount(count: number): void {
    this.frameCount = Math.max(1, count);
    if (this._frame > this.last) this.setFrame(this.last);
  }

  get last(): number {
    return Math.max(0, this.frameCount - 1);
  }

  setFrame(frame: number): void {
    const next = clamp(Math.round(frame), 0, this.last);
    if (next === this._frame) return;
    this._frame = next;
    this.events.emit('frame', { frame: next });
  }

  step(delta: number): void {
    this.setFrame(this._frame + delta);
  }

  play(): void {
    if (this._playing) return;
    if (this._frame >= this.last && this.loop) this.setFrame(0);
    this._playing = true;
    this.accumulator = 0;
    this.lastTimestamp = performance.now();
    this.events.emit('playing', { playing: true });
    this.scheduleTick();
  }

  pause(): void {
    if (!this._playing) return;
    this._playing = false;
    if (this.rafId !== null) {
      this.cancelRaf(this.rafId);
      this.rafId = null;
    }
    this.events.emit('playing', { playing: false });
  }

  toggle(): void {
    if (this._playing) this.pause();
    else this.play();
  }

  dispose(): void {
    this.pause();
    this.events.clear();
  }

  private scheduleTick(): void {
    this.rafId = this.raf(this.tick);
  }

  private tick = (timestamp: number): void => {
    if (!this._playing) return;
    const dt = Math.min(0.25, (timestamp - this.lastTimestamp) / 1000);
    this.lastTimestamp = timestamp;
    if (!this.canAdvance()) { this.accumulator = 0; this.scheduleTick(); return; }
    this.accumulator += dt * this.speed;
    const frameDuration = 1 / Math.max(1, this.fps);
    let advanced = false;
    if (this.accumulator >= frameDuration) {
      this.accumulator -= frameDuration;
      const next = this._frame + 1;
      if (next > this.last) {
        if (this.loop) {
          this._frame = 0;
          advanced = true;
        } else {
          this.pause();
          return;
        }
      } else {
        this._frame = next;
        advanced = true;
      }
    }
    if (advanced) this.events.emit('frame', { frame: this._frame });
    this.scheduleTick();
  };
}

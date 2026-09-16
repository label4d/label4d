import { EventEmitter } from '../events/EventEmitter';
import { normalizeYaw, vec3 } from '../geometry/math';
import type { Vec3 } from '../geometry/math';

export type ToolId = 'select' | 'box' | 'polyline' | 'polygon' | 'vertexEdit' | 'measure';

export type ScreenPoint = { x: number; y: number };

export type ToolState =
  | { name: 'idle' }
  | { name: 'marquee'; start: ScreenPoint; current: ScreenPoint }
  | { name: 'move'; startWorld: Vec3; lastWorld: Vec3 }
  | { name: 'rotate'; pivot: Vec3; startWorld: Vec3; lastWorld: Vec3 }
  | { name: 'drawBox'; stage: 'heading' | 'width'; origin: Vec3; heading: number; length: number; cursor: Vec3 }
  | { name: 'drawLine'; points: Vec3[]; closed: boolean; cursor: Vec3 | null }
  | { name: 'vertexEdit'; target: string; index: number; cursor: Vec3 }
  | { name: 'measure'; kind: MeasureKind; points: Vec3[]; cursor: Vec3 | null };

export type MeasureKind = 'distance' | 'height' | 'angle';

export interface PointerGesture {
  world: Vec3;
  screen: ScreenPoint;
  button: number;
  shift: boolean;
  alt: boolean;
}

export interface ToolContext {
  pickedId: string | null;
  vertexHit: { id: string; index: number } | null;
  rotateHandleHit: { id: string; pivot: Vec3 } | null;
  selection: string[];
}

export type ToolIntent =
  | { type: 'select'; ids: string[]; mode: 'replace' | 'add' | 'toggle' }
  | { type: 'selectRect'; rect: { x0: number; y0: number; x1: number; y1: number }; mode: 'replace' | 'add' }
  | { type: 'createBox'; center: Vec3; yaw: number; length: number; width: number }
  | { type: 'createGeometry'; closed: boolean; vertices: Vec3[] }
  | { type: 'moveGeometryVertex'; id: string; index: number; pos: Vec3 }
  | { type: 'deleteGeometryVertex'; id: string; index: number }
  | { type: 'moveSelection'; delta: Vec3 }
  | { type: 'rotateSelection'; pivot: Vec3; dyaw: number }
  | { type: 'measureDone'; kind: MeasureKind; points: Vec3[] }
  | { type: 'none' };

export interface ToolMachineEvents {
  changed: { tool: ToolId; state: ToolState };
}

/**
 * Explicit interaction state machine. Views adapt raw pointer events into
 * gestures; the machine produces intents, never mutations. Illegal
 * transitions are rejected (documented per-case below), not silently
 * guarded with booleans.
 */
export class ToolMachine {
  readonly events = new EventEmitter<ToolMachineEvents>();

  activeTool: ToolId = 'select';
  state: ToolState = { name: 'idle' };
  /** world-units; drags below this count as clicks */
  clickThreshold = 0.2;

  private downWorld: Vec3 | null = null;
  private downScreen: ScreenPoint | null = null;
  private dragged = false;

  setTool(tool: ToolId): void {
    if (tool === this.activeTool && this.state.name === 'idle') return;
    this.activeTool = tool;
    this.reset(); // rule: switching tools cancels in-progress gestures
    this.emit();
  }

  cancel(): void {
    this.reset();
    this.emit();
  }

  get cursor(): Vec3 | null {
    switch (this.state.name) {
      case 'drawBox':
        return this.state.cursor;
      case 'drawLine':
        return this.state.cursor;
      case 'measure':
        return this.state.cursor;
      case 'vertexEdit':
        return this.state.cursor;
      default:
        return null;
    }
  }

  /** Live preview delta for selection drag (render layer applies visually). */
  movePreviewDelta(): Vec3 | null {
    if (this.state.name !== 'move') return null;
    return vec3(
      this.state.lastWorld.x - this.state.startWorld.x,
      0,
      this.state.lastWorld.z - this.state.startWorld.z
    );
  }

  rotatePreviewDelta(): { pivot: Vec3; dyaw: number } | null {
    if (this.state.name !== 'rotate') return null;
    const start = Math.atan2(-(this.state.startWorld.z - this.state.pivot.z), this.state.startWorld.x - this.state.pivot.x);
    const last = Math.atan2(-(this.state.lastWorld.z - this.state.pivot.z), this.state.lastWorld.x - this.state.pivot.x);
    return { pivot: this.state.pivot, dyaw: normalizeYaw(last - start) };
  }

  marqueeRect(): { x0: number; y0: number; x1: number; y1: number } | null {
    if (this.state.name !== 'marquee') return null;
    const { start, current } = this.state;
    return { x0: start.x, y0: start.y, x1: current.x, y1: current.y };
  }

  pointerDown(g: PointerGesture, ctx: ToolContext): ToolIntent {
    this.downWorld = g.world;
    this.downScreen = g.screen;
    this.dragged = false;

    if (this.activeTool === 'select') {
      if (ctx.rotateHandleHit && g.button === 0) {
        this.state = { name: 'rotate', pivot: ctx.rotateHandleHit.pivot, startWorld: g.world, lastWorld: g.world };
        this.emit();
        return { type: 'none' };
      }
      if (ctx.pickedId && g.button === 0) {
        this.state = { name: 'move', startWorld: g.world, lastWorld: g.world };
        this.emit();
        return { type: 'none' };
      }
      this.state = { name: 'marquee', start: g.screen, current: g.screen };
      this.emit();
      return { type: 'none' };
    }

    if (this.activeTool === 'box') {
      if (this.state.name === 'idle') {
        this.state = { name: 'drawBox', stage: 'heading', origin: g.world, heading: 0, length: 0, cursor: g.world };
        this.emit();
        return { type: 'none' };
      }
      return { type: 'none' }; // mid-box: ignore extra downs
    }

    if (this.activeTool === 'polyline' || this.activeTool === 'polygon') {
      const closed = this.activeTool === 'polygon';
      if (this.state.name === 'drawLine' && this.state.closed === closed) {
        // close polygon by clicking near the first vertex
        if (closed && this.state.points.length >= 3) {
          const first = this.state.points[0];
          if (Math.hypot(first.x - g.world.x, first.z - g.world.z) < this.clickThreshold * 2) {
            return this.finishGeometry();
          }
        }
        this.state.points.push(g.world);
        this.emit();
        return { type: 'none' };
      }
      this.state = { name: 'drawLine', points: [g.world], closed, cursor: g.world };
      this.emit();
      return { type: 'none' };
    }

    if (this.activeTool === 'vertexEdit') {
      // Alt+Click deletes the vertex; plain drag moves it
      if (ctx.vertexHit && g.alt && g.button === 0) {
        const intent: ToolIntent = { type: 'deleteGeometryVertex', id: ctx.vertexHit.id, index: ctx.vertexHit.index };
        this.reset();
        this.emit();
        return intent;
      }
      if (ctx.vertexHit) {
        this.state = { name: 'vertexEdit', target: ctx.vertexHit.id, index: ctx.vertexHit.index, cursor: g.world };
        this.emit();
      }
      return { type: 'none' };
    }

    if (this.activeTool === 'measure') {
      if (this.state.name === 'measure' && this.state.kind === this.measureKind) {
        this.state.points.push(g.world);
        if (this.state.points.length >= this.requiredMeasurePoints(this.measureKind)) {
          const intent: ToolIntent = { type: 'measureDone', kind: this.measureKind, points: [...this.state.points] };
          this.reset();
          this.emit();
          return intent;
        }
      } else {
        this.state = { name: 'measure', kind: this.measureKind, points: [g.world], cursor: g.world };
      }
      this.emit();
      return { type: 'none' };
    }

    return { type: 'none' };
  }

  pointerMove(g: PointerGesture): void {
    if (this.downWorld) {
      this.dragged = Math.hypot(g.world.x - this.downWorld.x, g.world.z - this.downWorld.z) > this.clickThreshold ||
        Math.hypot(g.screen.x - (this.downScreen?.x ?? g.screen.x), g.screen.y - (this.downScreen?.y ?? g.screen.y)) > 4;
    }
    switch (this.state.name) {
      case 'move':
        this.state.lastWorld = g.world;
        break;
      case 'rotate':
        this.state.lastWorld = g.world;
        break;
      case 'marquee':
        this.state.current = g.screen;
        break;
      case 'drawBox': {
        this.state.cursor = g.world;
        const dx = g.world.x - this.state.origin.x;
        const dz = g.world.z - this.state.origin.z;
        if (this.state.stage === 'heading') {
          let heading = Math.hypot(dx, dz) > 1e-6 ? Math.atan2(-dz, dx) : 0;
          // Shift constrains heading to 90° steps
          if (g.shift) heading = Math.round(heading / (Math.PI / 2)) * (Math.PI / 2);
          this.state.heading = normalizeYaw(heading);
          this.state.length = Math.hypot(dx, dz);
        }
        break;
      }
      case 'drawLine':
        this.state.cursor = g.world;
        break;
      case 'vertexEdit':
        this.state.cursor = g.world;
        break;
      case 'measure':
        this.state.cursor = g.world;
        break;
      default:
        break;
    }
    this.emit();
  }

  pointerUp(g: PointerGesture, ctx: ToolContext): ToolIntent {
    const state = this.state;
    let intent: ToolIntent = { type: 'none' };

    if (state.name === 'move') {
      if (this.dragged && ctx.selection.length > 0) {
        intent = {
          type: 'moveSelection',
          delta: vec3(state.lastWorld.x - state.startWorld.x, 0, state.lastWorld.z - state.startWorld.z),
        };
      } else if (!this.dragged) {
        intent = { type: 'select', ids: ctx.pickedId ? [ctx.pickedId] : [], mode: g.shift ? 'toggle' : 'replace' };
      }
    } else if (state.name === 'rotate') {
      if (this.dragged && ctx.selection.length > 0) {
        const start = Math.atan2(-(state.startWorld.z - state.pivot.z), state.startWorld.x - state.pivot.x);
        const last = Math.atan2(-(state.lastWorld.z - state.pivot.z), state.lastWorld.x - state.pivot.x);
        intent = { type: 'rotateSelection', pivot: state.pivot, dyaw: normalizeYaw(last - start) };
      }
    } else if (state.name === 'marquee') {
      if (this.dragged) {
        intent = {
          type: 'selectRect',
          rect: { x0: state.start.x, y0: state.start.y, x1: state.current.x, y1: state.current.y },
          mode: g.shift ? 'add' : 'replace',
        };
      } else {
        intent = { type: 'select', ids: ctx.pickedId ? [ctx.pickedId] : [], mode: g.shift ? 'toggle' : 'replace' };
      }
    } else if (state.name === 'drawLine' || state.name === 'measure') {
      // click-accumulating tools: pointerup must NOT reset the collected points
      return intent;
    } else if (state.name === 'drawBox') {
      if (state.stage === 'heading') {
        if (state.length > this.clickThreshold) {
          state.stage = 'width'; // second drag sets width
          this.emit();
          this.downWorld = g.world;
          return { type: 'none' };
        }
        this.reset(); // too short: treat as misclick
        this.emit();
        return { type: 'none' };
      }
      // stage === 'width': perpendicular offset of the cursor from the heading axis
      const axisX = Math.cos(state.heading);
      const axisZ = -Math.sin(state.heading);
      const dx = g.world.x - state.origin.x;
      const dz = g.world.z - state.origin.z;
      const width = Math.max(0.4, Math.abs(-dx * axisZ + dz * axisX));
      const length = Math.max(0.4, state.length);
      // origin is the rear-center; box extends along heading
      const center = vec3(state.origin.x + (axisX * length) / 2, 0, state.origin.z + (axisZ * length) / 2);
      intent = { type: 'createBox', center, yaw: state.heading, length, width };
      this.reset();
      this.emit();
      return intent;
    } else if (state.name === 'vertexEdit') {
      intent = { type: 'moveGeometryVertex', id: state.target, index: state.index, pos: state.cursor };
      this.reset();
      this.emit();
      return intent;
    }

    this.reset();
    this.emit();
    return intent;
  }

  /** Double-click / Enter finish for polyline & polygon tools. */
  finishGeometry(): ToolIntent {
    if (this.state.name !== 'drawLine' || this.state.points.length < 2) {
      this.reset();
      this.emit();
      return { type: 'none' };
    }
    const intent: ToolIntent = {
      type: 'createGeometry',
      closed: this.state.closed,
      vertices: [...this.state.points],
    };
    this.reset();
    this.emit();
    return intent;
  }

  measureKind: MeasureKind = 'distance';

  private requiredMeasurePoints(kind: MeasureKind): number {
    return kind === 'angle' ? 3 : 2;
  }

  /** Distance helper reused by the measure HUD. */
  static measureValue(kind: MeasureKind, points: Vec3[]): number | null {
    if (kind === 'distance' && points.length === 2) {
      return Math.hypot(points[1].x - points[0].x, points[1].z - points[0].z);
    }
    if (kind === 'height' && points.length === 2) {
      return points[1].y - points[0].y;
    }
    if (kind === 'angle' && points.length === 3) {
      const [a, b, c] = points;
      const v1 = { x: a.x - b.x, z: a.z - b.z };
      const v2 = { x: c.x - b.x, z: c.z - b.z };
      const dot = v1.x * v2.x + v1.z * v2.z;
      const mag = Math.hypot(v1.x, v1.z) * Math.hypot(v2.x, v2.z);
      if (mag < 1e-9) return null;
      return (Math.acos(Math.max(-1, Math.min(1, dot / mag))) * 180) / Math.PI;
    }
    return null;
  }

  /** Nearest geometry vertex within tolerance (world XZ distance). */
  static vertexNear(world: Vec3, vertices: Float32Array, tolerance: number): number | null {
    let best = -1;
    let bestDist = tolerance;
    for (let i = 0; i * 3 < vertices.length; i++) {
      const direct = Math.hypot(world.x - vertices[i * 3], world.z - vertices[i * 3 + 2]);
      if (direct < bestDist) {
        bestDist = direct;
        best = i;
      }
    }
    return best >= 0 ? best : null;
  }

  private reset(): void {
    this.state = { name: 'idle' };
    this.downWorld = null;
    this.downScreen = null;
    this.dragged = false;
  }

  private emit(): void {
    this.events.emit('changed', { tool: this.activeTool, state: this.state });
  }
}

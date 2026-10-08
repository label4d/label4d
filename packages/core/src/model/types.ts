import type { Vec3 } from '../geometry/math';

export type TrackId = string;
export type GeometryId = string;

export type AttributeType = 'enum' | 'number' | 'text' | 'bool';

export interface AttributeDef {
  key: string;
  type: AttributeType;
  options?: string[];
  min?: number;
  max?: number;
  step?: number;
  default?: string | number | boolean;
  /** per-frame attribute (e.g. occlusion, moving state) instead of track-level */
  perFrame?: boolean;
}

export interface LabelDef {
  name: string;
  color: string;
  /** dynamic = tracked 3D box object; static = sequence-wide geometry (lane, curb, ...) */
  dynamic: boolean;
  /** default box size [length(x), height(y), width(z)] in meters for dynamic labels */
  defaultSize?: [number, number, number];
  /** schema driving in-view badges and the property editor */
  attributeSchema?: AttributeDef[];
}

export interface TrackMeta {
  id: TrackId;
  label: string;
  /** inclusive existence range */
  startFrame: number;
  endFrame: number;
  interpolation: 'linear' | 'hold';
  source: 'human' | 'model';
  confidence?: number;
  attributes: Record<string, string | number | boolean>;
}

/** Structure-of-arrays keyframe columns, sorted by frames. */
export interface KeyframeData {
  frames: Int32Array;
  pos: Float32Array; // 3k, xyz
  yaw: Float32Array; // k
  size: Float32Array; // 3k, [length(x), height(y), width(z)]
}

export interface ResolvedState {
  /** Read-only source observation pose; never serialized into yaw-only v1. */
  boxToWorld?: readonly number[];
  pos: Vec3;
  yaw: number;
  size: Vec3;
  atKeyframe: boolean;
}

export type GeometryKind =
  | 'lane'
  | 'curb'
  | 'stopline'
  | 'crosswalk'
  | 'zone'
  | 'polyline'
  | 'polygon';

export interface GeometryMeta {
  id: GeometryId;
  kind: GeometryKind;
  label: string;
  closed: boolean;
  /** inclusive time range; defaults to the whole sequence for static elements */
  startFrame: number;
  endFrame: number;
  attributes: Record<string, string | number | boolean>;
}

// ---- JSON-friendly shapes (commands, oplog, import/export) ----

export interface SerializedKeyframes {
  frames: number[];
  pos: number[];
  yaw: number[];
  size: number[];
}

export interface SerializedTrack {
  meta: TrackMeta;
  keyframes: SerializedKeyframes;
  /** per-frame attribute overrides (e.g. occlusion/truncation/moving state) */
  frameAttributes?: Array<{ frame: number; attrs: Record<string, string | number | boolean> }>;
}

export interface SerializedGeometry {
  meta: GeometryMeta;
  vertices: number[];
}

export interface KeyframeState {
  pos: Vec3;
  yaw: number;
  size: Vec3;
}

export const DEFAULT_LABELS: LabelDef[] = [
  {
    name: 'Car',
    color: '#4fa3ff',
    dynamic: true,
    defaultSize: [4.5, 1.6, 2.0],
    attributeSchema: [
      { key: 'color', type: 'enum', options: ['white', 'black', 'red', 'silver', 'blue'], default: 'white' },
      { key: 'brakeLight', type: 'bool', default: false, perFrame: true },
    ],
  },
  { name: 'Truck', color: '#ffb84f', dynamic: true, defaultSize: [8.0, 2.5, 3.5] },
  {
    name: 'Pedestrian',
    color: '#54ff7d',
    dynamic: true,
    defaultSize: [0.7, 1.75, 0.7],
    attributeSchema: [
      { key: 'pose', type: 'enum', options: ['moving', 'standing'], default: 'moving', perFrame: true },
      { key: 'occlusion', type: 'enum', options: ['0', '1', '2'], default: '0', perFrame: true },
    ],
  },
  { name: 'Cyclist', color: '#ff5aa5', dynamic: true, defaultSize: [1.8, 1.7, 0.7] },
  { name: 'Lane', color: '#ffe94f', dynamic: false },
  { name: 'Curb', color: '#b8b8b8', dynamic: false },
  { name: 'StopLine', color: '#ff5555', dynamic: false },
  { name: 'Crosswalk', color: '#f2f6ff', dynamic: false },
  { name: 'DrivableArea', color: '#7fd4ff', dynamic: false },
];

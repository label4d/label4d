import type { SequenceManifest, CameraConfig, BevImageConfig } from '../io/manifest';
import type { PointCloudFrame } from '../io/pcd';
import type { FrameProvider } from '../stream/FrameBuffer';
import type { LabelDef, ResolvedState } from '../model/types';
import type { TrackRecord } from '../model/TrackStore';

/** Presentation description, deliberately distinct from a serializable v1 manifest. */
export interface NormalizedRuntimeSequence {
  schema: 'labelfaster.browser-observations/1';
  id: string;
  frameCount: number;
  fps: number; // summary only; playback uses timeMicros
  cameras: CameraConfig[];
  labels: LabelDef[];
  bev: { image: BevImageConfig; tileset?: never };
  potree?: { url: string };
}
export type RuntimeSequence = SequenceManifest | NormalizedRuntimeSequence;

/** Source observations have exact frame existence, not interpolated v1 keyframes. */
export interface ObservationSource {
  records: Map<string, TrackRecord>;
  states: Map<string, Map<number, ResolvedState>>;
  active: string[][];
}

export interface SourceRectangle { id: string; hull: number[] }
export interface DatasetProvider {
  readonly description: NormalizedRuntimeSequence;
  readonly timeMicros: readonly number[];
  readonly egoPoses: Float64Array;
  readonly observations: ObservationSource;
  readonly cloud: FrameProvider<PointCloudFrame>;
  imageUrl(cameraId: string, frame: number): string;
  imageChecksum(cameraId: string, frame: number): string;
  cameraSourceId(cameraId: string): number;
  cameraPose(cameraId: string, frame: number): readonly number[];
  cameraPoseTime(cameraId: string, frame: number): number;
  cameraBoxes(cameraId: string, frame: number): readonly SourceRectangle[];
  dispose(): void;
}

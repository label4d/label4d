// events / entity
export { EventEmitter } from './events/EventEmitter';
export { EntityStore } from './entity/EntityStore';

// geometry
export {
  vec3, clamp, lerp, normalizeYaw, lerpYaw, yawQuaternion,
  composeBoxMatrix, boxCorners, mat4Multiply, mat4Invert, transformPoint,
  rayGround, rayOBB, pointInPolygon, convexHull, bilinear, pointSegmentDistance,
} from './geometry/math';
export type { Vec3 } from './geometry/math';

// model
export { TrackStore } from './model/TrackStore';
export type { TrackRecord, GeometryRecord, StoreChange } from './model/TrackStore';
export { SelectionSet } from './model/SelectionSet';
export type { SelectionMode } from './model/SelectionSet';
export {
  DEFAULT_LABELS,
} from './model/types';
export type {
  TrackId, GeometryId, LabelDef, TrackMeta, KeyframeData, KeyframeState,
  ResolvedState, GeometryKind, GeometryMeta, SerializedKeyframes,
  SerializedTrack, SerializedGeometry, AttributeDef, AttributeType,
} from './model/types';

// commands
export { History, Transaction, OpLog } from './command/History';
export type { Command, OpRecord, SnapshotEnvelope } from './command/History';
export {
  AddTrackCommand, DeleteTracksCommand, SetKeyframeCommand, RemoveKeyframeCommand,
  SetTrackMetaCommand, SetFrameAttributeCommand, TransformTracksCommand,
  SplitTrackCommand, MergeTracksCommand, AddGeometryCommand, UpdateGeometryCommand,
  DeleteGeometryCommand, createCommand, stateToJSON, jsonToState,
} from './command/commands';
export type { StateJSON, TransformDelta } from './command/commands';

// io
export {
  parseEgoPoses, manifestLabels, substituteFrame,
} from './io/manifest';
export type {
  SequenceManifest, CameraConfig, CameraModelType, PointCloudSource,
  TilesetConfig, HeightSource,
} from './io/manifest';
export {
  serializeStore, applySnapshot, countSnapshotStats,
  bytesToBase64, base64ToBytes,
} from './io/snapshot';
export type { SnapshotDocument, SnapshotTrack, SnapshotQA } from './io/snapshot';
export { parsePcd } from './io/pcd';
export type { PointCloudFrame } from './io/pcd';
export { exportNuScenesAnnotations } from './io/formats';
export type { NuScenesExport, NuScenesExportOptions } from './io/formats';

// streaming
export { TileScheduler } from './stream/TileScheduler';
export type { SchedulerStats, TileSchedulerOptions } from './stream/TileScheduler';
export { FrameBuffer } from './stream/FrameBuffer';
export type { FrameProvider, FrameBufferOptions, FrameBufferStats } from './stream/FrameBuffer';
export { BevPyramid, levelCount } from './stream/BevPyramid';
export type { TileCoord, WorldRect } from './stream/BevPyramid';
export {
  HeightField, decodePackedHeights, encodeHeightsToRGBA,
} from './stream/HeightField';
export type { RgbaImage, ImageFetcher, ImageDecoder } from './stream/HeightField';
export { PotreeOverlay, defaultNetClient } from './stream/PotreeOverlay';
export type {
  PotreeNode, PotreeMetadata, PotreeDecodedChunk, LazDecoder, NetClient,
} from './stream/PotreeOverlay';

// playback
export { Playhead } from './playback/Playhead';
export type { RafFn, CancelRafFn } from './playback/Playhead';

// projection
export {
  EgoTrack, CameraProjector, createProjectionModel, registerProjectionModel,
} from './projection/projection';
export type {
  ProjectionModel, ProjectionModelFactory, Intrinsics, PixelPoint,
  BoxProjection, VerticesProjection,
} from './projection/projection';

// interaction
export { ToolMachine } from './interaction/ToolMachine';
export type {
  ToolId, ToolState, ToolIntent, ToolContext, PointerGesture, MeasureKind,
} from './interaction/ToolMachine';

// assist
export { applyCandidates, candidateToSerialized } from './assist/AssistAdapter';
export type { AssistAdapter, AssistCandidate, AssistInput } from './assist/AssistAdapter';

// render (three.js layer)
export { TrackInstanceRenderer } from './render/TrackInstanceRenderer';
export type { InstancePreview } from './render/TrackInstanceRenderer';
export { AttributeBadgeRenderer } from './render/AttributeBadgeRenderer';
export { PointCloudFrameView } from './render/PointCloudFrameView';
export { BevTileRenderer } from './render/BevTileRenderer';
export { CameraImageView } from './render/CameraImageView';
export type { CameraPickResult, CameraViewOptions } from './render/CameraImageView';
export { ThreeViewPanel } from './render/ThreeViewPanel';
export type { ThreeViewAxis, ViewRect } from './render/ThreeViewPanel';
export {
  colorForLabel, makeDynamicLines, TextBadge, disposeObject, srgbToLinear,
  rgbBytesToLinearColors, BOX_EDGES, paintBadge,
} from './render/shared';
export type { DynamicLines } from './render/shared';

// session
export { EditorSession } from './session/EditorSession';
export type { SessionEvents, SessionDeps } from './session/EditorSession';
export { WorldCloudOverlay } from './render/WorldCloudOverlay';
export type { WorldCloudIndex } from './render/WorldCloudOverlay';

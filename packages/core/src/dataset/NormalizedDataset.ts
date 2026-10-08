import { unzipSync } from 'fflate';
import { validTransform } from '../io/manifest';
import { parsePcd } from '../io/pcd';
import type { PointCloudFrame } from '../io/pcd';
import type { ResolvedState, LabelDef } from '../model/types';
import type { DatasetProvider, NormalizedRuntimeSequence, ObservationSource, SourceRectangle } from './DatasetProvider';

interface Sensor {
  id: string; kind: 'camera' | 'lidar'; sourceId: number; name: string; sensorToEgo: number[];
  model?: string; width?: number; height?: number; intrinsics?: number[]; distortion?: number[];
}
interface Sample {
  sensorId: string; status: string; sampleId: string; referenceTimeMicros: number;
  poseTimeMicros: number; cameraToWorld: number[]; image: string; imageSha256: string;
  returnId?: number; pointOffset?: number; pointCount?: number;
}
interface Frame {
  schema: string; sequenceId: string; index: number; timeMicros: number; egoToWorld: number[];
  samples: Sample[];
  boxObservations: Array<{ objectId: string; label: number; source: string; size: number[]; boxToWorld: number[] }>;
  sourceComponents: { projected_lidar_box?: Record<string, unknown>[] };
  pointCloud: { path: string; format: string; pointCount: number; sha256: string; attributes: string; attributesSha256: string; attributeSchema: string };
}
const names = ['Unknown', 'Vehicle', 'Pedestrian', 'Sign', 'Cyclist'];
const labels: LabelDef[] = names.map((name, i) => ({ name, dynamic: true, color: ['#b8b8b8', '#4fa3ff', '#54ff7d', '#ffe94f', '#ff5aa5'][i] }));
const hashPattern = /^[a-f0-9]{64}$/;
const safeTime = (n: number) => Number.isSafeInteger(n) && n >= 0;
function requireValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Normalized dataset: ${message}`);
}

/** Resolve only literal, dataset-local paths; encoded escapes and URL templates are rejected. */
export function datasetUrl(root: string, path: string): string {
  requireValid(typeof path === 'string' && path.length > 0 && !/[\\%?#:{}]/.test(path) &&
    !path.startsWith('/') && path.split('/').every((s) => s !== '..' && s !== '.' && s.length > 0), 'unsafe resource path');
  return new URL(path, root).href;
}
export async function checkSha256(bytes: ArrayBuffer, expected: string): Promise<void> {
  requireValid(hashPattern.test(expected), 'missing resource checksum');
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const hash = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  requireValid(hash === expected, 'resource SHA256 mismatch');
}

/** Strict little-endian, C-order Int32 [N,6] NPY profile from the Python importer. */
export function decodeCameraReferences(bytes: ArrayBuffer, count: number): Int32Array {
  const files = unzipSync(new Uint8Array(bytes), { filter: (file) => {
    requireValid(file.originalSize <= 64 * 1024 * 1024, 'oversized point attributes');
    return file.name === 'camera_projection.npy';
  } });
  const data = files['camera_projection.npy'];
  requireValid(data && data[0] === 0x93 && new TextDecoder().decode(data.subarray(1, 6)) === 'NUMPY', 'missing camera_projection NPY');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  requireValid(data[6] === 1 || data[6] === 2, 'unsupported NPY version');
  const start = data[6] === 1 ? 10 : 12;
  const headerLength = data[6] === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const header = new TextDecoder().decode(data.subarray(start, start + headerLength));
  const shape = /'shape':\s*\(\s*(\d+)\s*,\s*6\s*,?\s*\)/.exec(header);
  requireValid(/'descr':\s*'<i4'/.test(header) && /'fortran_order':\s*False/.test(header) && shape && Number(shape[1]) === count, 'camera projection point-order shape mismatch');
  const offset = start + headerLength;
  requireValid(data.byteLength - offset === count * 24, 'camera projection payload size mismatch');
  const out = new Int32Array(count * 6);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt32(offset + i * 4, true);
  return out;
}

/** Adapter for the offline contract. No v1 manifest/snapshot is manufactured. */
export async function openNormalizedDataset(input: unknown, sequenceUrl: string, signal: AbortSignal): Promise<DatasetProvider> {
  const s = input as { schema: string; id: string; coordinateSystem: Record<string, unknown>; time: Record<string, unknown>;
    sensors: Sensor[]; frames: Array<{ index: number; timeMicros: number; path: string }>;
    potree?: { path: string; encoding: string; frameCount: number; pointCount: number; policy: string; boxPaddingMeters: number; files: Array<{ path: string; sha256: string }> };
    provenance: { dataset: string }; bev: { path: string; originX: number; originZ: number; metersPerPixel: number; width: number; height: number } };
  requireValid(s?.schema === 'labelfaster.normalized-sequence/1' && typeof s.id === 'string' && s.id, 'unsupported schema or identity');
  const c = s.coordinateSystem, t = s.time;
  requireValid(c?.handedness === 'right' && c.up === 'Y' && c.unit === 'meter' && c.matrixOrder === 'column-major' && validTransform(c.sourceWorldToLocal), 'unsupported coordinates');
  requireValid(t?.unit === 'microsecond' && t.matchingPolicy === 'exact-frame-key' && t.missingPolicy === 'reject' && typeof t.sourceOriginMicros === 'string' && /^\d+$/.test(t.sourceOriginMicros), 'unsupported time/matching policy');
  // Bounded metadata initialization for source browsing, not a production streaming index.
  requireValid(Array.isArray(s.frames) && s.frames.length > 0 && s.frames.length <= 10000, 'invalid or oversized frame index');
  s.frames.forEach((f, i) => requireValid(f.index === i && safeTime(f.timeMicros) && (i === 0 ? f.timeMicros === 0 : f.timeMicros > s.frames[i - 1].timeMicros), 'invalid time index'));
  requireValid(Array.isArray(s.sensors) && s.sensors.length > 0, 'missing sensors');
  const ids = new Set<string>();
  for (const sensor of s.sensors) {
    requireValid(typeof sensor.id === 'string' && !ids.has(sensor.id) && ['camera', 'lidar'].includes(sensor.kind) && Number.isSafeInteger(sensor.sourceId) && sensor.sourceId > 0 && validTransform(sensor.sensorToEgo), 'invalid sensor');
    ids.add(sensor.id);
    if (sensor.kind === 'camera') requireValid(sensor.model === 'pinhole-brown-conrady' &&
      Number.isSafeInteger(sensor.width) && sensor.width! > 0 && Number.isSafeInteger(sensor.height) && sensor.height! > 0 &&
      sensor.intrinsics?.length === 4 && sensor.intrinsics.every(Number.isFinite) && sensor.intrinsics[0] > 0 && sensor.intrinsics[1] > 0 &&
      sensor.distortion?.length === 5 && sensor.distortion.every(Number.isFinite), 'unsupported camera calibration');
  }
  // Source enum and projected component mapping are adapter-specific, never scattered in views.
  requireValid(s.provenance?.dataset === 'waymo-perception', 'no observation label adapter for this source');
  const root = new URL('.', sequenceUrl).href;
  const cameras = s.sensors.filter((sensor) => sensor.kind === 'camera');
  const frames: Frame[] = new Array(s.frames.length);
  const rectangles: Map<string, SourceRectangle[]>[] = new Array(s.frames.length);
  let cursor = 0, metadataBytes = 0;
  const workers = Array.from({ length: Math.min(6, frames.length) }, async () => {
    while (cursor < frames.length) {
      signal.throwIfAborted();
      const i = cursor++;
      const response = await fetch(datasetUrl(root, s.frames[i].path), { signal });
      requireValid(response.ok && response.headers.get('content-type')?.includes('application/json'), `frame ${i} metadata HTTP ${response.status}`);
      const text = await response.text(); metadataBytes += text.length * 2;
      requireValid(metadataBytes <= 128 * 1024 * 1024, 'metadata budget exceeded');
      const f = JSON.parse(text) as Frame;
      requireValid(f.schema === 'labelfaster.normalized-frame/1' && f.sequenceId === s.id && f.index === i && f.timeMicros === s.frames[i].timeMicros && validTransform(f.egoToWorld), `frame ${i} identity or pose mismatch`);
      requireValid(Array.isArray(f.samples) && Array.isArray(f.boxObservations), 'missing samples/observations');
      const sampleIds = new Set<string>(), presentCameras = new Set<string>(), spans: Sample[] = [];
      for (const sample of f.samples) {
        requireValid(ids.has(sample.sensorId) && sample.status === 'available' && typeof sample.sampleId === 'string' && !sampleIds.has(sample.sampleId) && sample.referenceTimeMicros === f.timeMicros, 'sample identity mismatch');
        sampleIds.add(sample.sampleId);
        const sensor = s.sensors.find((a) => a.id === sample.sensorId)!;
        if (sensor.kind === 'camera') {
          requireValid(!presentCameras.has(sample.sensorId) && validTransform(sample.cameraToWorld) && Number.isSafeInteger(sample.poseTimeMicros) && hashPattern.test(sample.imageSha256), 'invalid camera sample');
          presentCameras.add(sample.sensorId); datasetUrl(root, sample.image);
        } else spans.push(sample);
      }
      requireValid(presentCameras.size === cameras.length, 'incomplete camera samples');
      const pc = f.pointCloud;
      requireValid(pc?.format === 'pcd-xyzi-binary' && safeTime(pc.pointCount) && pc.attributeSchema === 'labelfaster.point-attributes/1' && hashPattern.test(pc.sha256) && hashPattern.test(pc.attributesSha256), 'invalid cloud descriptor');
      datasetUrl(root, pc.path); datasetUrl(root, pc.attributes);
      let offset = 0; const returns = new Set<string>();
      for (const sample of spans) {
        const key = `${sample.sensorId}:${sample.returnId}`;
        requireValid([1, 2].includes(sample.returnId!) && !returns.has(key) && sample.pointOffset === offset && safeTime(sample.pointCount!), 'invalid lidar point span');
        returns.add(key); offset += sample.pointCount!;
      }
      requireValid(offset === pc.pointCount && s.sensors.filter((a) => a.kind === 'lidar').every((a) => returns.has(`${a.id}:1`) && returns.has(`${a.id}:2`)), 'incomplete lidar samples');
      const objects = new Set<string>();
      for (const b of f.boxObservations) {
        requireValid(typeof b.objectId === 'string' && b.objectId && !objects.has(b.objectId) && b.source === 'human-observation' && Number.isInteger(b.label) && b.label >= 0 && b.label < names.length && b.size?.length === 3 && b.size.every((n) => Number.isFinite(n) && n > 0) && validTransform(b.boxToWorld), 'invalid box observation');
        objects.add(b.objectId);
      }
      const rects = new Map<string, SourceRectangle[]>();
      for (const row of f.sourceComponents?.projected_lidar_box ?? []) {
        const sensor = cameras.find((a) => a.sourceId === row['key.camera_name']);
        const id = row['key.laser_object_id'];
        if (!sensor || typeof id !== 'string' || !objects.has(id)) continue;
        const prefix = '[ProjectedLiDARBoxComponent].box.';
        const [x, y, w, h] = ['center.x', 'center.y', 'size.x', 'size.y'].map((k) => row[prefix + k] as number);
        requireValid([x, y, w, h].every(Number.isFinite) && w > 0 && h > 0, 'invalid source projected rectangle');
        const list = rects.get(sensor.id) ?? [];
        list.push({ id, hull: [x-w/2,y-h/2,x+w/2,y-h/2,x+w/2,y+h/2,x-w/2,y+h/2] }); rects.set(sensor.id, list);
      }
      rectangles[i] = rects;
      // Discard opaque source fields after validation; offline data remains the source of truth.
      frames[i] = { ...f, sourceComponents: {}, samples: f.samples.map((a) => ({ sensorId: a.sensorId, status: a.status, sampleId: a.sampleId, referenceTimeMicros: a.referenceTimeMicros, poseTimeMicros: a.poseTimeMicros, cameraToWorld: a.cameraToWorld, image: a.image, imageSha256: a.imageSha256 })), boxObservations: f.boxObservations.map((b) => ({ objectId: b.objectId, source: b.source, label: b.label, size: b.size, boxToWorld: b.boxToWorld })) };
    }
  });
  await Promise.all(workers); signal.throwIfAborted();
  const observations: ObservationSource = { records: new Map(), states: new Map(), active: [] };
  const egoPoses = new Float64Array(frames.length * 16);
  for (const f of frames) {
    egoPoses.set(f.egoToWorld, f.index * 16);
    observations.active[f.index] = f.boxObservations.map((b) => b.objectId);
    for (const b of f.boxObservations) {
      const m = b.boxToWorld;
      const state: ResolvedState = { pos: { x: m[12], y: m[13], z: m[14] }, yaw: Math.atan2(-m[2], m[0]), size: { x: b.size[0], y: b.size[1], z: b.size[2] }, atKeyframe: true, boxToWorld: m };
      const states = observations.states.get(b.objectId) ?? new Map();
      states.set(f.index, state); observations.states.set(b.objectId, states);
      const record = observations.records.get(b.objectId);
      requireValid(!record || record.meta.label === names[b.label], 'object label changed');
      if (!record) observations.records.set(b.objectId, { meta: { id: b.objectId, label: names[b.label], startFrame: f.index, endFrame: f.index, interpolation: 'hold', source: 'human', attributes: {} }, kf: { frames: new Int32Array(), pos: new Float32Array(), yaw: new Float32Array(), size: new Float32Array() }, frameAttrs: new Map() });
      observations.records.get(b.objectId)!.meta.endFrame = f.index;
    }
  }
  for (const [id, record] of observations.records) {
    const entries = [...observations.states.get(id)!];
    // Columns support the existing timeline/property presentation only, never serialization.
    record.kf = { frames: Int32Array.from(entries.map(([f]) => f)), pos: Float32Array.from(entries.flatMap(([, a]) => [a.pos.x, a.pos.y, a.pos.z])), yaw: Float32Array.from(entries.map(([, a]) => a.yaw)), size: Float32Array.from(entries.flatMap(([, a]) => [a.size.x, a.size.y, a.size.z])) };
  }
  if (s.potree) {
    const p = s.potree;
    requireValid(p.encoding === 'UNCOMPRESSED' && p.frameCount === frames.length && Number.isSafeInteger(p.pointCount) && p.pointCount > 0 &&
      p.policy === 'all-observed-boxes-excluded' && Number.isFinite(p.boxPaddingMeters) && p.boxPaddingMeters >= 0 &&
      Array.isArray(p.files) && p.files.length === 3 && new Set(p.files.map((f) => f.path)).size === 3 &&
      p.files.every((f) => ['metadata.json', 'hierarchy.bin', 'octree.bin'].includes(f.path) && hashPattern.test(f.sha256)), 'invalid Potree descriptor');
    const response = await fetch(datasetUrl(root, `${p.path}/metadata.json`), { signal });
    requireValid(response.ok, 'missing Potree metadata');
    const bytes = await response.arrayBuffer();
    await checkSha256(bytes, p.files.find((f) => f.path === 'metadata.json')!.sha256);
    const metadata = JSON.parse(new TextDecoder().decode(bytes));
    requireValid(metadata.version === '2.0' && metadata.encoding === p.encoding && metadata.points === p.pointCount, 'Potree metadata mismatch');
  }
  const b = s.bev;
  requireValid(b && [b.originX,b.originZ,b.metersPerPixel].every(Number.isFinite) && b.metersPerPixel > 0 && Number.isSafeInteger(b.width) && b.width > 0 && Number.isSafeInteger(b.height) && b.height > 0, 'invalid BEV extent');
  const timeMicros = s.frames.map((f) => f.timeMicros);
  const description: NormalizedRuntimeSequence = { schema: 'labelfaster.browser-observations/1', id: s.id, frameCount: frames.length, fps: frames.length > 1 ? (frames.length - 1) * 1e6 / timeMicros[timeMicros.length-1] : 10,
    labels, potree: s.potree ? { url: datasetUrl(root, s.potree.path) } : undefined, bev: { image: { ...b, url: datasetUrl(root, b.path) } }, cameras: cameras.map((a) => ({ id: a.id, model: 'pinhole', width: a.width!, height: a.height!, intrinsics: { fx: a.intrinsics![0], fy: a.intrinsics![1], cx: a.intrinsics![2], cy: a.intrinsics![3] }, distortion: a.distortion, cameraToEgo: a.sensorToEgo, imageTemplate: '' })) };
  let disposed = false;
  const cameraSample = (id: string, frame: number) => frames[frame].samples.find((a) => a.sensorId === id)!;
  return { description, timeMicros, egoPoses, observations,
    imageUrl: (id, frame) => datasetUrl(root, cameraSample(id, frame).image),
    imageChecksum: (id, frame) => cameraSample(id, frame).imageSha256,
    cameraSourceId: (id) => cameras.find((a) => a.id === id)!.sourceId,
    cameraPose: (id, frame) => cameraSample(id, frame).cameraToWorld,
    cameraPoseTime: (id, frame) => cameraSample(id, frame).poseTimeMicros,
    cameraBoxes: (id, frame) => rectangles[frame].get(id) ?? [],
    cloud: { load: async (frame, loadSignal) => {
      requireValid(!disposed, 'provider disposed');
      const pc = frames[frame].pointCloud;
      const fetchBytes = async (path: string, hash: string) => {
        const r = await fetch(datasetUrl(root, path), { signal: loadSignal });
        requireValid(r.ok, `cloud HTTP ${r.status}`);
        const bytes = await r.arrayBuffer(); await checkSha256(bytes, hash); return bytes;
      };
      const [pcd, npz] = await Promise.all([fetchBytes(pc.path, pc.sha256), fetchBytes(pc.attributes, pc.attributesSha256)]);
      const cloud = parsePcd(pcd); requireValid(cloud.count === pc.pointCount, 'PCD count mismatch');
      cloud.cameraReferences = decodeCameraReferences(npz, cloud.count);
      requireValid(!disposed && !loadSignal?.aborted, 'obsolete resource'); return cloud;
    }, bytes: (a: PointCloudFrame) => a.positions.byteLength + (a.intensity?.byteLength ?? 0) + (a.cameraReferences?.byteLength ?? 0), dispose: () => undefined },
    dispose: () => { disposed = true; },
  };
}

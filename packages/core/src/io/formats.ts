import type { TrackStore } from '../model/TrackStore';
import { parseEgoPoses } from './manifest';

/**
 * Format converters. The native format is the snapshot document; this module
 * maps to/from ecosystem formats (nuScenes today).
 */

export interface NuScenesExportOptions {
  /** emit an annotation every N frames (nuScenes "key samples"; default 5 = 2Hz @10Hz) */
  sampleStep?: number;
  sceneName?: string;
}

export interface NuScenesExport {
  scene: { token: string; name: string; description: string; nbr_samples: number };
  samples: Array<{ token: string; timestamp: number; scene_token: string; prev: string | null; next: string | null }>;
  instance: Array<{ token: string; category_token: string; nbr_annotations: number; first_annotation_token: string; last_annotation_token: string }>;
  sample_annotation: Array<{
    token: string;
    sample_token: string;
    instance_token: string;
    translation: [number, number, number];
    size: [number, number, number]; // nuScenes order: [width, height, length]
    rotation: [number, number, number, number]; // [w, x, y, z]
    num_lidar_pts: number;
    attribute_tokens: string[];
    prev: string | null;
    next: string | null;
  }>;
}

const token = (...parts: (string | number)[]): string =>
  parts.join('_').replace(/[^A-Za-z0-9_-]/g, '');

/**
 * Exports the annotation store in a nuScenes-compatible layout. Coordinates
 * are passed through in the storage frame (global, Y-up); apply a frame
 * transform externally if your nuScenes consumer expects z-up.
 */
export function exportNuScenesAnnotations(
  store: TrackStore,
  info: { sequenceId: string; frameCount: number },
  options: NuScenesExportOptions = {}
): NuScenesExport {
  const step = Math.max(1, options.sampleStep ?? 5);
  const sceneToken = token(info.sequenceId);
  const sampleTokens: string[] = [];
  const samples: NuScenesExport['samples'] = [];
  for (let f = 0; f < info.frameCount; f += step) {
    const st = token(sceneToken, 'sample', f);
    sampleTokens.push(st);
    samples.push({ token: st, timestamp: f, scene_token: sceneToken, prev: null, next: null });
  }
  for (let i = 0; i < samples.length; i++) {
    samples[i].prev = i > 0 ? samples[i - 1].token : null;
    samples[i].next = i < samples.length - 1 ? samples[i + 1].token : null;
  }

  const sample_annotation: NuScenesExport['sample_annotation'] = [];
  const instance: NuScenesExport['instance'] = [];
  for (const record of store.listTracks()) {
    const instanceToken = token(sceneToken, record.meta.id);
    const annotationTokens: string[] = [];
    for (let s = 0; s < sampleTokens.length; s++) {
      const frame = s * step;
      if (frame < record.meta.startFrame || frame > record.meta.endFrame) continue;
      const state = store.resolveState(record.meta.id, frame);
      if (!state) continue;
      const half = state.yaw / 2;
      const annToken = token(instanceToken, frame);
      annotationTokens.push(annToken);
      sample_annotation.push({
        token: annToken,
        sample_token: sampleTokens[s],
        instance_token: instanceToken,
        translation: [state.pos.x, state.pos.y, state.pos.z],
        size: [state.size.z, state.size.y, state.size.x],
        rotation: [Math.cos(half), 0, Math.sin(half), 0],
        num_lidar_pts: 0,
        attribute_tokens: Object.entries(record.frameAttrs.get(frame) ?? {}).map(([k, v]) => `${k}:${String(v)}`),
        prev: null,
        next: null,
      });
    }
    if (annotationTokens.length > 0) {
      instance.push({
        token: instanceToken,
        category_token: record.meta.label,
        nbr_annotations: annotationTokens.length,
        first_annotation_token: annotationTokens[0],
        last_annotation_token: annotationTokens[annotationTokens.length - 1],
      });
    }
  }
  // second pass to link annotation prev/next per instance
  const byInstance = new Map<string, typeof sample_annotation>();
  for (const ann of sample_annotation) {
    const list = byInstance.get(ann.instance_token) ?? [];
    list.push(ann);
    byInstance.set(ann.instance_token, list);
  }
  for (const list of byInstance.values()) {
    for (let i = 0; i < list.length; i++) {
      list[i].prev = i > 0 ? list[i - 1].token : null;
      list[i].next = i < list.length - 1 ? list[i + 1].token : null;
    }
  }

  return {
    scene: {
      token: sceneToken,
      name: options.sceneName ?? info.sequenceId,
      description: `Labelfaster export ${info.sequenceId}`,
      nbr_samples: samples.length,
    },
    samples,
    instance,
    sample_annotation,
  };
}

export function loadEgoPosesFromJSON(json: unknown, frameCount: number): Float64Array | null {
  return parseEgoPoses(json, frameCount);
}

import type { SequenceManifest } from '../io/manifest';
import { validateManifest, parseEgoPoses, substituteFrame } from '../io/manifest';
import { parsePcd } from '../io/pcd';
import { EgoTrack } from '../projection/projection';
import { mat4Multiply } from '../geometry/math';
import type { DatasetProvider, DatasetImage } from './DatasetProvider';
import type { NetClient } from '../stream/PotreeOverlay';
import type { ImageFetcher } from '../stream/HeightField';

/** v1 resource adapter, including KITTI. Editable documents remain owned by the session. */
export async function openManifestDataset(input: SequenceManifest, deps: { net: NetClient; fetchImage: ImageFetcher }, signal: AbortSignal): Promise<DatasetProvider> {
  const description = validateManifest(input);
  let egoPoses: Float64Array = new Float64Array(description.frameCount * 16);
  if (description.egoPoses) {
    let poses: unknown = description.egoPoses;
    if (typeof poses === 'string') {
      const data = await deps.net.fetchJson(poses);
      poses = data && typeof data === 'object' && 'poses' in data ? (data as { poses: unknown }).poses : data;
    }
    const parsed = parseEgoPoses(poses, description.frameCount);
    if (!parsed) throw new Error('Invalid or incomplete ego trajectory');
    egoPoses = parsed;
  } else {
    const identity = EgoTrack.identity(description.frameCount);
    for (let f = 0; f < description.frameCount; f++) egoPoses.set(identity.poseAt(f), f * 16);
  }
  signal.throwIfAborted();
  let disposed = false;
  const active = (loadSignal?: AbortSignal) => {
    signal.throwIfAborted(); loadSignal?.throwIfAborted();
    if (disposed) throw new Error('Dataset provider disposed');
  };
  const camera = (id: string) => {
    const config = description.cameras?.find((c) => c.id === id);
    if (!config) throw new Error(`Unknown camera: ${id}`);
    return config;
  };
  const pointCloud = description.pointCloud;
  return {
    description, capabilities: { editing: true, projection: 'calibrated', imageFailure: 'optional' },
    timeMicros: null, egoPoses, observations: null, sourceProjection: null,
    imageUrl: (id, frame) => substituteFrame(camera(id).imageTemplate, frame),
    image: (id) => {
      const config = camera(id);
      return {
        load: async (frame, loadSignal) => {
          active(loadSignal);
          const image = await deps.fetchImage(substituteFrame(config.imageTemplate, frame), loadSignal);
          try { active(loadSignal); } catch (error) { if ('close' in image) image.close(); throw error; }
          return image;
        },
        bytes: (image: DatasetImage) => image.width * image.height * 4,
        dispose: (image: DatasetImage) => { if ('close' in image) image.close(); },
      };
    },
    cameraPose: (id, frame) => {
      const pose = new Float64Array(16);
      mat4Multiply(egoPoses.subarray(frame * 16, frame * 16 + 16), camera(id).cameraToEgo, pose);
      return pose;
    },
    cameraPoseTime: (_id, frame) => frame / description.fps * 1e6,
    cloud: pointCloud ? {
      load: async (frame, loadSignal) => {
        active(loadSignal);
        const bytes = await deps.net.fetchBinary(substituteFrame(pointCloud.urlTemplate, frame), { signal: loadSignal });
        active(loadSignal); return parsePcd(bytes);
      },
      bytes: (cloud) => cloud.positions.byteLength + (cloud.intensity?.byteLength ?? 0) + (cloud.rgb?.byteLength ?? 0),
      dispose: () => undefined,
    } : null,
    dispose: () => { disposed = true; },
  };
}

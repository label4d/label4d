import { AddTrackCommand } from '../command/commands';
import { Transaction } from '../command/History';
import type { TrackStore } from '../model/TrackStore';
import type { SerializedTrack, TrackMeta } from '../model/types';

export interface AssistCandidate {
  label: string;
  confidence: number;
  startFrame: number;
  endFrame: number;
  keyframes: Array<{ frame: number; pos: [number, number, number]; yaw: number; size: [number, number, number] }>;
  attributes?: Record<string, string | number | boolean>;
}

export interface AssistInput {
  frameCount: number;
  fps: number;
}

/**
 * Adapter seam for 2026-style model-assisted annotation: offline detectors /
 * online trackers publish candidate tracks; humans review. Implementations
 * might call a served model, read pre-computed inference files, or wrap an
 * in-browser ONNX session.
 */
export interface AssistAdapter {
  readonly name: string;
  generate(input: AssistInput): Promise<AssistCandidate[]>;
}

export function candidateToSerialized(candidate: AssistCandidate, id: string): SerializedTrack {
  const frames: number[] = [];
  const pos: number[] = [];
  const yaw: number[] = [];
  const size: number[] = [];
  for (const kf of candidate.keyframes) {
    frames.push(kf.frame);
    pos.push(kf.pos[0], kf.pos[1], kf.pos[2]);
    yaw.push(kf.yaw);
    size.push(kf.size[0], kf.size[1], kf.size[2]);
  }
  const meta: TrackMeta = {
    id,
    label: candidate.label,
    startFrame: candidate.startFrame,
    endFrame: candidate.endFrame,
    interpolation: 'linear',
    source: 'model',
    confidence: candidate.confidence,
    attributes: { ...(candidate.attributes ?? {}) },
  };
  return { meta, keyframes: { frames, pos, yaw, size } };
}

/**
 * Batch-imports candidates above the confidence threshold as ONE transaction
 * (single undo step), exactly the human-review workflow: import all, reject
 * with one cmd+z, then fix individuals.
 */
export function applyCandidates(
  store: TrackStore,
  history: { pushTransaction(children: import('../command/History').Command[]): Transaction },
  candidates: AssistCandidate[],
  options: { minConfidence?: number } = {}
): Transaction {
  const min = options.minConfidence ?? 0.5;
  const accepted = candidates.filter((c) => c.confidence >= min && c.keyframes.length > 0);
  const commands = accepted.map(
    (candidate) => new AddTrackCommand(store, candidateToSerialized(candidate, store.nextTrackId()))
  );
  return history.pushTransaction(commands);
}

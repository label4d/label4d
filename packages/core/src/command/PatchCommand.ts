import type { Command } from './History';
import type { TrackStore, StorePatch } from '../model/TrackStore';
import type { SnapshotQA } from '../io/snapshot';

/** A captured edit is replayed from data, including its inverse; no model/service is re-run. */
export class PatchCommand implements Command {
  readonly name = 'patch';
  readonly payload: { patch: StorePatch; inverse: StorePatch; review: SnapshotQA; inverseReview: SnapshotQA };
  constructor(private readonly store: TrackStore, patch: StorePatch, inverse: StorePatch,
    review: SnapshotQA, inverseReview: SnapshotQA, private readonly setReview: (review: SnapshotQA) => void) {
    this.payload = structuredClone({ patch, inverse, review, inverseReview });
  }
  apply(): void { this.store.applyPatch(this.payload.patch); this.setReview(this.payload.review); }
  undo(): void { this.store.applyPatch(this.payload.inverse); this.setReview(this.payload.inverseReview); }
}

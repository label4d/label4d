import { MoveAnnotationsCommand } from '../history/commands/MoveAnnotationsCommand';
import { HistoryManager } from '../history/HistoryManager';
import { AnnotationStore } from '../models/AnnotationStore';
import { SelectionSet } from '../models/SelectionSet';

interface MoveState {
  active: boolean;
  cumulative: { x: number; y: number; z: number };
}

export class MoveController {
  private state: MoveState = {
    active: false,
    cumulative: { x: 0, y: 0, z: 0 },
  };

  constructor(
    private readonly store: AnnotationStore,
    private readonly selection: SelectionSet,
    private readonly history: HistoryManager
  ) {}

  begin(): void {
    this.state = {
      active: true,
      cumulative: { x: 0, y: 0, z: 0 },
    };
  }

  update(delta: { x: number; y: number; z: number }): void {
    if (!this.state.active) {
      return;
    }
    this.selection.translate(delta);
    this.state.cumulative = {
      x: this.state.cumulative.x + delta.x,
      y: this.state.cumulative.y + delta.y,
      z: this.state.cumulative.z + delta.z,
    };
    for (const annotation of this.selection.list()) {
      this.store.update(annotation);
    }
  }

  end(): void {
    if (!this.state.active) {
      return;
    }
    const ids = this.selection.list().map((annotation) => annotation.id);
    const command = new MoveAnnotationsCommand(this.store, ids, this.state.cumulative);
    this.state = { active: false, cumulative: { x: 0, y: 0, z: 0 } };
    if (ids.length > 0) {
      this.history.push(command);
    }
  }

  cancel(): void {
    this.state = { active: false, cumulative: { x: 0, y: 0, z: 0 } };
  }
}

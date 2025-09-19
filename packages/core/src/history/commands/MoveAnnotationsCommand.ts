import type { Annotation } from '../../annotations/Annotation';
import type { AnnotationStore } from '../../models/AnnotationStore';
import type { Command } from '../Command';

export class MoveAnnotationsCommand implements Command {
  readonly description: string;
  private readonly previousStates = new Map<string, Annotation>();

  constructor(
    private readonly store: AnnotationStore,
    private readonly annotationIds: string[],
    private readonly delta: { x: number; y: number; z: number }
  ) {
    this.description = `Move ${annotationIds.length} annotations`;
  }

  execute(): void {
    this.previousStates.clear();
    for (const id of this.annotationIds) {
      const annotation = this.store.get(id);
      if (!annotation) {
        continue;
      }
      this.previousStates.set(id, annotation.clone());
      annotation.translate(this.delta);
      this.store.update(annotation);
    }
  }

  undo(): void {
    for (const [id, snapshot] of this.previousStates.entries()) {
      const current = this.store.get(id);
      if (!current) {
        this.store.add(snapshot.clone());
        continue;
      }
      current.setVertices(snapshot.getVertices());
      current.metadata = { ...snapshot.metadata };
      this.store.update(current);
    }
  }
}

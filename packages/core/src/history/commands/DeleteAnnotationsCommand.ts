import type { Annotation } from '../../annotations/Annotation';
import type { AnnotationStore } from '../../models/AnnotationStore';
import type { Command } from '../Command';

export class DeleteAnnotationsCommand implements Command {
  readonly description: string;
  private readonly snapshot: Annotation[] = [];

  constructor(private readonly store: AnnotationStore, private readonly annotationIds: string[]) {
    this.description = `Delete ${annotationIds.length} annotations`;
  }

  execute(): void {
    this.snapshot.length = 0;
    for (const id of this.annotationIds) {
      const removed = this.store.remove(id);
      if (removed) {
        this.snapshot.push(removed.clone());
      }
    }
  }

  undo(): void {
    for (const annotation of this.snapshot) {
      this.store.add(annotation);
    }
  }
}

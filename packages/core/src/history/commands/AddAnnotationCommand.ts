import type { Annotation } from '../../annotations/Annotation';
import type { AnnotationStore } from '../../models/AnnotationStore';
import type { Command } from '../Command';

export class AddAnnotationCommand implements Command {
  readonly description: string;

  constructor(private readonly store: AnnotationStore, private readonly annotation: Annotation) {
    this.description = `Add ${annotation.type}`;
  }

  execute(): void {
    this.store.add(this.annotation);
  }

  undo(): void {
    this.store.remove(this.annotation.id);
  }
}

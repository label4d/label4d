import type { Annotation } from '../../annotations/Annotation';
import type { AnnotationStore } from '../../models/AnnotationStore';
import type { AnnotationVertex } from '../../types/geometry';
import type { Command } from '../Command';

export class UpdateVertexCommand implements Command {
  readonly description: string;

  constructor(
    private readonly store: AnnotationStore,
    private readonly annotationId: string,
    private readonly vertexIndex: number,
    private readonly before: AnnotationVertex,
    private readonly after: AnnotationVertex
  ) {
    this.description = `Update vertex ${vertexIndex}`;
  }

  execute(): void {
    const annotation = this.requireAnnotation();
    annotation.updateVertex(this.vertexIndex, this.after);
    this.store.update(annotation, [this.vertexIndex]);
  }

  undo(): void {
    const annotation = this.requireAnnotation();
    annotation.updateVertex(this.vertexIndex, this.before);
    this.store.update(annotation, [this.vertexIndex]);
  }

  private requireAnnotation(): Annotation {
    const annotation = this.store.get(this.annotationId);
    if (!annotation) {
      throw new Error(`Annotation ${this.annotationId} not found`);
    }
    return annotation;
  }
}

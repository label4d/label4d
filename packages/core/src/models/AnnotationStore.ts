import type { Annotation } from '../annotations/Annotation';
import { events } from '../events/EventDispatcher';

export class AnnotationStore {
  private readonly annotations = new Map<string, Annotation>();

  add(annotation: Annotation): void {
    this.annotations.set(annotation.id, annotation);
    events.emit('annotationAdded', { id: annotation.id });
  }

  update(annotation: Annotation, changedVertices?: number[]): void {
    if (!this.annotations.has(annotation.id)) {
      throw new Error(`Annotation ${annotation.id} not found`);
    }
    this.annotations.set(annotation.id, annotation);
    events.emit('annotationUpdated', { id: annotation.id, changedVertices });
  }

  remove(annotationId: string): Annotation | undefined {
    const annotation = this.annotations.get(annotationId);
    if (annotation) {
      this.annotations.delete(annotationId);
      events.emit('annotationRemoved', { id: annotationId });
    }
    return annotation;
  }

  get(annotationId: string): Annotation | undefined {
    return this.annotations.get(annotationId);
  }

  list(): Annotation[] {
    return Array.from(this.annotations.values());
  }
}

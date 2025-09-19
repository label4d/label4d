import type { Annotation } from '../annotations/Annotation';

export class SelectionSet {
  private readonly selected = new Map<string, Annotation>();

  add(annotation: Annotation): void {
    this.selected.set(annotation.id, annotation);
    annotation.isSelected = true;
  }

  remove(annotationId: string): void {
    const target = this.selected.get(annotationId);
    if (target) {
      target.isSelected = false;
      this.selected.delete(annotationId);
    }
  }

  clear(): void {
    for (const annotation of this.selected.values()) {
      annotation.isSelected = false;
    }
    this.selected.clear();
  }

  has(annotationId: string): boolean {
    return this.selected.has(annotationId);
  }

  list(): Annotation[] {
    return Array.from(this.selected.values());
  }

  translate(delta: { x: number; y: number; z: number }): void {
    for (const annotation of this.selected.values()) {
      annotation.translate(delta);
    }
  }
}

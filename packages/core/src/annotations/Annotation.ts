import type { AnnotationType, AnnotationVertex } from '../types/geometry';
import { generateId } from '../utils/id';

export interface AnnotationProps {
  id?: string;
  type: AnnotationType;
  vertices?: AnnotationVertex[];
  metadata?: Record<string, unknown>;
}

export abstract class Annotation {
  readonly id: string;
  readonly type: AnnotationType;
  protected vertices: AnnotationVertex[];
  metadata: Record<string, unknown>;
  isSelected = false;

  protected constructor({ id, type, vertices = [], metadata = {} }: AnnotationProps) {
    this.id = id ?? generateId();
    this.type = type;
    this.vertices = vertices.map((vertex) => ({ ...vertex }));
    this.metadata = { ...metadata };
  }

  getVertices(): AnnotationVertex[] {
    return this.vertices.map((vertex) => ({ ...vertex }));
  }

  setVertices(vertices: AnnotationVertex[]): void {
    this.vertices = vertices.map((vertex) => ({ ...vertex }));
    this.updateGeometry();
  }

  addVertex(vertex: AnnotationVertex, index?: number): void {
    if (typeof index === 'number') {
      this.vertices.splice(index, 0, { ...vertex });
    } else {
      this.vertices.push({ ...vertex });
    }
    this.updateGeometry();
  }

  updateVertex(index: number, vertex: AnnotationVertex): void {
    if (!this.vertices[index]) {
      throw new Error(`Vertex index ${index} out of bounds`);
    }
    this.vertices[index] = { ...vertex };
    this.updateGeometry();
  }

  removeVertex(index: number): AnnotationVertex {
    if (!this.vertices[index]) {
      throw new Error(`Vertex index ${index} out of bounds`);
    }
    const [removed] = this.vertices.splice(index, 1);
    this.updateGeometry();
    return removed;
  }

  translate(delta: { x: number; y: number; z: number }): void {
    this.vertices = this.vertices.map((vertex) => ({
      ...vertex,
      x: vertex.x + delta.x,
      y: vertex.y + delta.y,
      z: vertex.z + delta.z,
    }));
    this.updateGeometry();
  }

  clone(): Annotation {
    const copy = this.instantiate({
      id: this.id,
      type: this.type,
      vertices: this.getVertices(),
      metadata: { ...this.metadata },
    });
    copy.isSelected = this.isSelected;
    return copy;
  }

  protected abstract instantiate(props: AnnotationProps): Annotation;

  protected abstract updateGeometry(): void;
}

import type { Annotation } from '../annotations/Annotation';
import { PolygonAnnotation } from '../annotations/PolygonAnnotation';
import { PolylineAnnotation } from '../annotations/PolylineAnnotation';
import { RectangleAnnotation } from '../annotations/RectangleAnnotation';
import { AddAnnotationCommand } from '../history/commands/AddAnnotationCommand';
import { HistoryManager } from '../history/HistoryManager';
import { AnnotationStore } from '../models/AnnotationStore';
import { HeightMapService } from '../services/HeightMapService';
import { PreviewService } from '../services/PreviewService';
import type { AnnotationType, AnnotationVertex } from '../types/geometry';

const registry = {
  polyline: PolylineAnnotation,
  rectangle: RectangleAnnotation,
  polygon: PolygonAnnotation,
};

type AnnotationConstructor = typeof PolylineAnnotation;

export class DrawController {
  private activeAnnotation: Annotation | null = null;
  private readonly vertices: AnnotationVertex[] = [];

  constructor(
    private readonly store: AnnotationStore,
    private readonly history: HistoryManager,
    private readonly preview: PreviewService,
    private readonly heightMap: HeightMapService
  ) {}

  begin(type: AnnotationType, start: AnnotationVertex): void {
    if (this.activeAnnotation) {
      this.cancel();
    }
    const annotation = this.instantiate(type);
    const vertex = this.withHeight(start);
    annotation.addVertex(vertex);
    this.vertices.length = 0;
    this.vertices.push(vertex);
    this.activeAnnotation = annotation;
    this.preview.setVertices(this.vertices);
  }

  update(next: AnnotationVertex): void {
    if (!this.activeAnnotation) {
      return;
    }
    const vertex = this.withHeight(next);
    this.preview.setPending(vertex);
  }

  commit(point: AnnotationVertex, close = false): void {
    if (!this.activeAnnotation) {
      return;
    }
    const vertex = this.withHeight(point);
    this.activeAnnotation.addVertex(vertex);
    this.vertices.push(vertex);
    this.preview.setVertices(this.vertices);
    this.preview.setPending(null);

    const minVertices = this.requiredVertexCount(this.activeAnnotation.type, close);
    if (this.vertices.length >= minVertices && close) {
      this.finish();
    }
  }

  finish(): void {
    if (!this.activeAnnotation) {
      return;
    }
    const command = new AddAnnotationCommand(this.store, this.activeAnnotation);
    this.history.push(command);
    this.reset();
  }

  cancel(): void {
    this.reset();
  }

  private reset(): void {
    this.activeAnnotation = null;
    this.vertices.length = 0;
    this.preview.reset();
  }

  private instantiate(type: AnnotationType): Annotation {
    const ctor = registry[type] as AnnotationConstructor | undefined;
    if (!ctor) {
      throw new Error(`Unsupported annotation type: ${type}`);
    }
    return new ctor({ type });
  }

  private requiredVertexCount(type: AnnotationType, close: boolean): number {
    if (type === 'rectangle') {
      return 4;
    }
    if (type === 'polygon') {
      return close ? 3 : 0;
    }
    return close ? 2 : 0;
  }

  private withHeight(vertex: AnnotationVertex): AnnotationVertex {
    if (!this.heightMap.isLoaded()) {
      return vertex;
    }
    const height = this.heightMap.sample(vertex.x, vertex.y);
    return { ...vertex, z: height };
  }
}

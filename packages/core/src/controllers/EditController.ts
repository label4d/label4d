import type { Annotation } from '../annotations/Annotation';
import { UpdateVertexCommand } from '../history/commands/UpdateVertexCommand';
import { HistoryManager } from '../history/HistoryManager';
import { AnnotationStore } from '../models/AnnotationStore';
import { HeightMapService } from '../services/HeightMapService';
import type { AnnotationVertex } from '../types/geometry';

interface DragState {
  annotation: Annotation;
  vertexIndex: number;
  original: AnnotationVertex;
}

export class EditController {
  private dragState: DragState | null = null;

  constructor(
    private readonly store: AnnotationStore,
    private readonly history: HistoryManager,
    private readonly heightMap: HeightMapService
  ) {}

  beginDrag(annotationId: string, vertexIndex: number): void {
    const annotation = this.requireAnnotation(annotationId);
    const vertices = annotation.getVertices();
    const vertex = vertices[vertexIndex];
    if (!vertex) {
      throw new Error(`Vertex ${vertexIndex} not found`);
    }
    this.dragState = {
      annotation,
      vertexIndex,
      original: { ...vertex },
    };
  }

  updateDrag(position: AnnotationVertex): void {
    if (!this.dragState) {
      return;
    }
    const target = this.dragState.annotation;
    const withHeight = this.applyHeight(position);
    target.updateVertex(this.dragState.vertexIndex, withHeight);
    this.store.update(target, [this.dragState.vertexIndex]);
  }

  endDrag(position: AnnotationVertex): void {
    if (!this.dragState) {
      return;
    }
    const target = this.dragState.annotation;
    const updated = this.applyHeight(position);
    const before = this.dragState.original;
    const command = new UpdateVertexCommand(
      this.store,
      target.id,
      this.dragState.vertexIndex,
      before,
      updated
    );
    this.dragState = null;
    this.history.push(command);
  }

  cancelDrag(): void {
    if (!this.dragState) {
      return;
    }
    const target = this.dragState.annotation;
    target.updateVertex(this.dragState.vertexIndex, this.dragState.original);
    this.store.update(target, [this.dragState.vertexIndex]);
    this.dragState = null;
  }

  private requireAnnotation(annotationId: string): Annotation {
    const annotation = this.store.get(annotationId);
    if (!annotation) {
      throw new Error(`Annotation ${annotationId} not found`);
    }
    return annotation;
  }

  private applyHeight(vertex: AnnotationVertex): AnnotationVertex {
    if (!this.heightMap.isLoaded()) {
      return vertex;
    }
    return {
      ...vertex,
      z: this.heightMap.sample(vertex.x, vertex.y),
    };
  }
}

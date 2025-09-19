import type { AnnotationVertex } from '../types/geometry';
import { events } from '../events/EventDispatcher';

interface PreviewState {
  vertices: AnnotationVertex[];
  pending: AnnotationVertex | null;
}

export class PreviewService {
  private state: PreviewState = { vertices: [], pending: null };

  reset(): void {
    this.state = { vertices: [], pending: null };
    this.emit();
  }

  setVertices(vertices: AnnotationVertex[]): void {
    this.state = { ...this.state, vertices: vertices.map((vertex) => ({ ...vertex })) };
    this.emit();
  }

  setPending(vertex: AnnotationVertex | null): void {
    this.state = { ...this.state, pending: vertex ? { ...vertex } : null };
    this.emit();
  }

  getState(): PreviewState {
    return {
      vertices: this.state.vertices.map((vertex) => ({ ...vertex })),
      pending: this.state.pending ? { ...this.state.pending } : null,
    };
  }

  private emit(): void {
    events.emit('previewChanged', {
      vertices: this.state.vertices.map((vertex) => ({ ...vertex })),
      pending: this.state.pending ? { ...this.state.pending } : null,
    });
  }
}

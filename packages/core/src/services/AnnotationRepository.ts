import type { Annotation } from '../annotations/Annotation';
import { PolygonAnnotation } from '../annotations/PolygonAnnotation';
import { PolylineAnnotation } from '../annotations/PolylineAnnotation';
import { RectangleAnnotation } from '../annotations/RectangleAnnotation';
import type { AnnotationVertex } from '../types/geometry';

interface SerializedAnnotation {
  id: string;
  type: string;
  vertices: AnnotationVertex[];
  metadata?: Record<string, unknown>;
}

const registry = {
  polyline: PolylineAnnotation,
  rectangle: RectangleAnnotation,
  polygon: PolygonAnnotation,
};

type AnnotationConstructor = typeof PolylineAnnotation;

export class AnnotationRepository {
  serialize(annotations: Annotation[]): SerializedAnnotation[] {
    return annotations.map((annotation) => ({
      id: annotation.id,
      type: annotation.type,
      vertices: annotation.getVertices(),
      metadata: { ...annotation.metadata },
    }));
  }

  deserialize(payload: SerializedAnnotation[]): Annotation[] {
    return payload.map((item) => this.instantiate(item));
  }

  private instantiate(payload: SerializedAnnotation): Annotation {
    const ctor = registry[payload.type as keyof typeof registry] as AnnotationConstructor | undefined;
    if (!ctor) {
      throw new Error(`Unsupported annotation type: ${payload.type}`);
    }
    return new ctor({
      id: payload.id,
      type: payload.type as never,
      vertices: payload.vertices,
      metadata: payload.metadata,
    });
  }
}

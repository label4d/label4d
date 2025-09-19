export type Vector3Tuple = [number, number, number];

export interface Vector3Like {
  x: number;
  y: number;
  z: number;
}

export type AnnotationType = 'polyline' | 'rectangle' | 'polygon';

export interface AnnotationVertex extends Vector3Like {
  meta?: Record<string, unknown>;
}

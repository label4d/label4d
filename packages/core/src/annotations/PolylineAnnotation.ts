import type { AnnotationProps } from './Annotation';
import { Annotation } from './Annotation';

export class PolylineAnnotation extends Annotation {
  constructor(props: AnnotationProps) {
    super({ ...props, type: 'polyline' });
  }

  protected instantiate(props: AnnotationProps): Annotation {
    return new PolylineAnnotation(props);
  }

  protected updateGeometry(): void {
    // Geometry updates handled in view layer; no-op for core representation.
  }
}

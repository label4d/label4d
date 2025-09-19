import type { AnnotationProps } from './Annotation';
import { Annotation } from './Annotation';

export class PolygonAnnotation extends Annotation {
  constructor(props: AnnotationProps) {
    super({ ...props, type: 'polygon' });
  }

  protected instantiate(props: AnnotationProps): Annotation {
    return new PolygonAnnotation(props);
  }

  protected updateGeometry(): void {
    if (this.getVertices().length < 3) {
      throw new Error('Polygon requires at least 3 vertices');
    }
  }
}

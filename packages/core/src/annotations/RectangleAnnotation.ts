import type { AnnotationProps } from './Annotation';
import { Annotation } from './Annotation';

export class RectangleAnnotation extends Annotation {
  constructor(props: AnnotationProps) {
    super({ ...props, type: 'rectangle' });
    if (this.getVertices().length && this.getVertices().length !== 4) {
      throw new Error('Rectangle must have exactly 4 vertices');
    }
  }

  protected instantiate(props: AnnotationProps): Annotation {
    return new RectangleAnnotation(props);
  }

  protected updateGeometry(): void {
    if (this.getVertices().length !== 4) {
      throw new Error('Rectangle must maintain exactly 4 vertices');
    }
  }
}

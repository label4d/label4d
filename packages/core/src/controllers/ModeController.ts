export type ToolMode = 'idle' | 'draw' | 'edit' | 'select' | 'move' | 'highlight';
export type DrawShape = 'polyline' | 'rectangle' | 'polygon';

export class ModeController {
  private mode: ToolMode = 'idle';
  private drawShape: DrawShape = 'polyline';

  setMode(mode: ToolMode): void {
    this.mode = mode;
  }

  getMode(): ToolMode {
    return this.mode;
  }

  is(mode: ToolMode): boolean {
    return this.mode === mode;
  }

  setDrawMode(shape: DrawShape): void {
    this.mode = 'draw';
    this.drawShape = shape;
  }

  getDrawShape(): DrawShape {
    return this.drawShape;
  }
}

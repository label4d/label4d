import { describe, expect, it } from 'vitest';
import { CameraImageView } from '../src/render/CameraImageView';
import { CameraProjector, EgoTrack } from '../src/projection/projection';

const view = () => {
  const v = new CameraImageView([]);
  v.attachProjector(CameraProjector.create({ id: 'camera', model: 'pinhole', width: 960, height: 540,
    intrinsics: { fx: 800, fy: 800, cx: 480, cy: 270 }, imageTemplate: '',
    cameraToEgo: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  }, EgoTrack.identity(1)));
  return v;
};
describe('Camera viewport aspect and picking', () => {
  it.each([[600, 150], [180, 300]])('preserves image proportions at %s × %s and maps the center', (w, h) => {
    const v = view(); v.setViewportSize(w, h);
    expect((v.camera.right - v.camera.left) / (v.camera.top - v.camera.bottom)).toBeCloseTo(w / h);
    expect(v.toImagePixel(w / 2, h / 2, w, h)).toEqual({ x: 480, y: 270 });
    const a = v.toImagePixel(0, 0, w, h), b = v.toImagePixel(w, h, w, h);
    expect((b.x - a.x) / w).toBeCloseTo((b.y - a.y) / h);
    v.dispose();
  });
  it('keeps the image coordinate under the cursor fixed when zooming after letterboxing', () => {
    const v = view(); v.setViewportSize(600, 150);
    const before = v.toImagePixel(370, 90, 600, 150);
    v.zoomAtCursor(before.x, 540 - before.y, 2);
    expect(v.toImagePixel(370, 90, 600, 150).x).toBeCloseTo(before.x);
    expect(v.toImagePixel(370, 90, 600, 150).y).toBeCloseTo(before.y);
    v.dispose();
  });
});

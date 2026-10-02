import { describe, expect, it } from 'vitest';
import { Vector3 } from 'three';
import { ThreeViewPanel } from '../src/render/ThreeViewPanel';

describe('Orthographic panel projection and navigation', () => {
  it.each(['top', 'front', 'side'] as const)('%s keeps rendering and picking aligned in a wide panel', (axis) => {
    const panel = new ThreeViewPanel(axis, []);
    const center = { x: 12, y: 0.8, z: -4 };
    panel.fit(center, 5, 2.4);
    panel.zoomBy(2);
    panel.panByFraction(0.1, -0.2);
    panel.fit(center, 5, 2.4);
    const world = panel.screenToPlane(180, 30, 240, 100);
    const projected = new Vector3(world.x, world.y, 0).project(panel.camera);
    expect((projected.x + 1) * 120).toBeCloseTo(180);
    expect((1 - projected.y) * 50).toBeCloseTo(30);
    expect((panel.camera.right - panel.camera.left) / (panel.camera.top - panel.camera.bottom)).toBeCloseTo(2.4);
    panel.dispose();
  });
});

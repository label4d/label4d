import { describe, expect, it } from 'vitest';
import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from 'three';
import { EgoCameraFollow } from '../src/render/EgoCameraFollow';

const pose = (position: Vector3, angles: Euler) => new Matrix4().compose(position, new Quaternion().setFromEuler(angles), new Vector3(1, 1, 1));

describe('Ego-relative orbit camera', () => {
  it('preserves position, orientation and look-at target through translation, turns and slopes', () => {
    const follow = new EgoCameraFollow(), camera = new PerspectiveCamera();
    const first = pose(new Vector3(3, 2, -5), new Euler(.1, .3, -.05));
    const target = new Vector3(3, 2, -5);
    camera.position.set(33, 37, 25); camera.lookAt(target); camera.updateMatrix();
    const relativeCamera = first.clone().invert().multiply(camera.matrix);
    const relativeTarget = target.clone().applyMatrix4(first.clone().invert());
    follow.capture(first.elements, camera, target);
    for (const next of [pose(new Vector3(70, 9, 12), new Euler(-.15, Math.PI / 2, .08)), first]) {
      follow.apply(next.elements, camera, target); camera.updateMatrix();
      const actual = next.clone().invert().multiply(camera.matrix);
      actual.elements.forEach((value, i) => expect(value).toBeCloseTo(relativeCamera.elements[i], 9));
      expect(target.clone().applyMatrix4(next.clone().invert()).distanceTo(relativeTarget)).toBeLessThan(1e-9);
    }
  });

  it('keeps a newly adjusted orbit offset after recapture at the current frame', () => {
    const follow = new EgoCameraFollow(), camera = new PerspectiveCamera(), target = new Vector3();
    camera.position.set(10, 20, 30); camera.lookAt(target);
    follow.capture(new Matrix4().elements, camera, target);
    const current = pose(new Vector3(40, 3, -10), new Euler(0, 1, 0));
    follow.apply(current.elements, camera, target);
    camera.position.add(new Vector3(3, 5, -8)); camera.lookAt(target); camera.updateMatrix();
    const adjusted = current.clone().invert().multiply(camera.matrix);
    follow.capture(current.elements, camera, target);
    const next = pose(new Vector3(80, 8, -20), new Euler(.2, 2, 0));
    follow.apply(next.elements, camera, target); camera.updateMatrix();
    next.clone().invert().multiply(camera.matrix).elements.forEach((value, i) => expect(value).toBeCloseTo(adjusted.elements[i], 9));
  });
});

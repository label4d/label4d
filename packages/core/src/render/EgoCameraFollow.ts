import { Camera, Matrix4, Vector3 } from 'three';

/** Keep an orbit camera and its look-at target rigidly attached to the ego pose. */
export class EgoCameraFollow {
  private readonly localCamera = new Matrix4();
  private readonly localTarget = new Vector3();
  private readonly localUp = new Vector3();
  private readonly scratch = new Matrix4();
  private captured = false;

  capture(egoPose: ArrayLike<number>, camera: Camera, target: Vector3): void {
    this.scratch.fromArray(egoPose).invert();
    camera.updateMatrix();
    this.localCamera.multiplyMatrices(this.scratch, camera.matrix);
    this.localTarget.copy(target).applyMatrix4(this.scratch);
    this.localUp.copy(camera.up).transformDirection(this.scratch);
    this.captured = true;
  }

  apply(egoPose: ArrayLike<number>, camera: Camera, target: Vector3): void {
    if (!this.captured) return;
    this.scratch.fromArray(egoPose);
    target.copy(this.localTarget).applyMatrix4(this.scratch);
    camera.up.copy(this.localUp).transformDirection(this.scratch);
    this.scratch.multiply(this.localCamera).decompose(camera.position, camera.quaternion, camera.scale);
    camera.updateMatrixWorld();
  }
}

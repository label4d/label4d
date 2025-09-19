import { Matrix4, Vector3 } from 'three';
import type { Vector3Tuple } from '../types/geometry';

export interface CoordinateTransforms {
  imageToWorld?: Matrix4;
  worldToImage?: Matrix4;
  bevToWorld?: Matrix4;
  worldToBev?: Matrix4;
}

export class CoordinateService {
  private imageToWorld = new Matrix4();
  private worldToImage = new Matrix4();
  private bevToWorld = new Matrix4();
  private worldToBev = new Matrix4();

  configure({ imageToWorld, worldToImage, bevToWorld, worldToBev }: CoordinateTransforms): void {
    if (imageToWorld) {
      this.imageToWorld = imageToWorld.clone();
      this.worldToImage = imageToWorld.clone().invert();
    }
    if (worldToImage) {
      this.worldToImage = worldToImage.clone();
      this.imageToWorld = worldToImage.clone().invert();
    }
    if (bevToWorld) {
      this.bevToWorld = bevToWorld.clone();
      this.worldToBev = bevToWorld.clone().invert();
    }
    if (worldToBev) {
      this.worldToBev = worldToBev.clone();
      this.bevToWorld = worldToBev.clone().invert();
    }
  }

  imageToWorldPoint(point: Vector3Tuple): Vector3Tuple {
    return this.transformPoint(point, this.imageToWorld);
  }

  worldToImagePoint(point: Vector3Tuple): Vector3Tuple {
    return this.transformPoint(point, this.worldToImage);
  }

  bevToWorldPoint(point: Vector3Tuple): Vector3Tuple {
    return this.transformPoint(point, this.bevToWorld);
  }

  worldToBevPoint(point: Vector3Tuple): Vector3Tuple {
    return this.transformPoint(point, this.worldToBev);
  }

  private transformPoint(point: Vector3Tuple, matrix: Matrix4): Vector3Tuple {
    const vector = new Vector3(point[0], point[1], point[2]);
    vector.applyMatrix4(matrix);
    return [vector.x, vector.y, vector.z];
  }
}

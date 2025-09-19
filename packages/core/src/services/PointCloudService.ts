import type { BufferGeometry } from 'three';
import { events } from '../events/EventDispatcher';

export interface PointCloudLoader {
  load(url: string): Promise<BufferGeometry>;
}

export class PointCloudService {
  private geometry: BufferGeometry | null = null;

  constructor(private readonly loader: PointCloudLoader) {}

  async load(url: string): Promise<BufferGeometry> {
    const geometry = await this.loader.load(url);
    this.geometry = geometry;
    events.emit('pointCloudLoaded', { url, geometry });
    return geometry;
  }

  getGeometry(): BufferGeometry | null {
    return this.geometry;
  }

  clear(): void {
    this.geometry = null;
  }
}

import * as THREE from 'three';
import { BevPyramid } from '../stream/BevPyramid';
import type { TileCoord, WorldRect } from '../stream/BevPyramid';
import type { TileScheduler } from '../stream/TileScheduler';

type AnyImage = ImageBitmap | HTMLImageElement;

interface TileEntry {
  mesh: THREE.Mesh | null;
}

function disposeMesh(mesh: THREE.Mesh): void {
  mesh.geometry.dispose();
  const material = mesh.material as THREE.MeshBasicMaterial;
  const image = material.map?.source.data;
  if (image && 'close' in image) image.close();
  material.map?.dispose();
  material.dispose();
}

/**
 * BEV tile pyramid rendering onto ground planes. The coarsest level is kept
 * as a permanent overview layer so the view is never blank while tiles load.
 * Texture contract: decoded with imageOrientation:'flipY' and uploaded with
 * flipY=false → PNG top row lands at world minZ (originZ) edge.
 */
let nextRenderer = 0;
export class BevTileRenderer {
  readonly group = new THREE.Group();

  private tiles = new Map<string, TileEntry>();
  private desired = new Set<string>();
  private overviewReady = false;
  private disposed = false;
  private readonly prefix = `bev:${++nextRenderer}:`;
  private failures = new Set<string>();

  constructor(
    private readonly pyramid: BevPyramid,
    private readonly scheduler: TileScheduler,
    private readonly loadImage: (url: string) => Promise<AnyImage>
  ) {}

  async loadOverview(): Promise<boolean> {
    if (this.overviewReady) return true;
    const rect = this.pyramid.tileWorldRect(0, 0, 0);
    try {
      const key = `${this.prefix}overview`;
      const mesh = await this.scheduler.request(key, 80, this.pyramid.tileBytesEstimate(), () =>
        this.loadImage(this.pyramid.tileUrl(0, 0, 0)).then((image) => this.buildMesh(key, 0, rect, image)),
        { pinned: true, dispose: (mesh) => { this.group.remove(mesh); disposeMesh(mesh); }, bytes: (mesh) => this.meshBytes(mesh) });
      if (this.disposed || !this.scheduler.isResident(key, mesh)) { this.scheduler.release(key); return false; }
      this.group.add(mesh);
      this.overviewReady = true;
      return true;
    } catch {
      // overview unavailable; streaming tiles still work
      return false;
    }
  }

  updateView(rect: WorldRect, screenMpp: number): void {
    if (this.disposed || this.pyramid.singleImage) return;
    const level = this.pyramid.levelForMpp(screenMpp);
    const coords: TileCoord[] = this.pyramid.tilesForRect(rect, level);

    this.desired.clear();
    for (const coord of coords) {
      const key = `${this.prefix}${coord.level}:${coord.x}:${coord.y}`;
      this.desired.add(key);
      const entry = this.tiles.get(key);
      if (!entry && !this.failures.has(key)) {
        this.request(key, coord.level, coord.x, coord.y);
      } else if (entry) {
        this.scheduler.touch(key);
      }
    }

    for (const [key] of this.tiles) {
      if (!this.desired.has(key)) {
        this.scheduler.cancel(key); this.tiles.delete(key);
      }
    }
  }

  /** Dispatcher target for TileScheduler onEvict (LRU or explicit release). */
  evictResource(key: string, resource: unknown): void {
    const mesh = resource as THREE.Mesh;
    this.group.remove(mesh);
    disposeMesh(mesh);
    this.tiles.delete(key);
  }

  dispose(): void {
    this.disposed = true;
    for (const [key] of this.tiles) this.scheduler.cancel(key);
    this.scheduler.cancel(`${this.prefix}overview`);
    this.tiles.clear(); this.desired.clear();
  }

  private request(key: string, level: number, x: number, y: number): void {
    const entry: TileEntry = { mesh: null };
    this.tiles.set(key, entry);
    const rect = this.pyramid.tileWorldRect(level, x, y);
    const loadImage = this.loadImage;
    const url = this.pyramid.tileUrl(level, x, y);
    this.scheduler
      .request<THREE.Mesh>(key, -1, this.pyramid.tileBytesEstimate(), () =>
        loadImage(url).then((image) => this.buildMesh(key, level, rect, image)),
        { dispose: (mesh) => this.evictResource(key, mesh), bytes: (mesh) => this.meshBytes(mesh) }
      )
      .then((mesh) => {
        if (this.disposed || !this.desired.has(key) || !this.scheduler.isResident(key, mesh)) {
          this.scheduler.release(key);
          return;
        }
        entry.mesh = mesh;
        this.group.add(mesh);
      })
      .catch((error) => {
        if (error?.name !== 'AbortError') this.failures.add(key);
        this.tiles.delete(key);
      });
  }

  private meshBytes(mesh: THREE.Mesh): number {
    const image = (mesh.material as THREE.MeshBasicMaterial).map!.source.data;
    return image.width * image.height * 4 + (mesh.geometry.getAttribute('position').array.byteLength);
  }

  private buildMesh(key: string, level: number, rect: WorldRect, image: AnyImage): THREE.Mesh {
    const sizeX = rect.maxX - rect.minX;
    const sizeZ = rect.maxZ - rect.minZ;
    const geometry = new THREE.PlaneGeometry(sizeX, sizeZ);
    geometry.rotateX(-Math.PI / 2);
    const texture = new THREE.Texture(image);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.flipY = false;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.needsUpdate = true; // required: manual Texture starts at version 0
    // A ground-plane map is a background; downhill annotations may have negative Y.
    const material = new THREE.MeshBasicMaterial({ map: texture, depthWrite: false });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set((rect.minX + rect.maxX) / 2, -0.05 + level * 0.002, (rect.minZ + rect.maxZ) / 2);
    mesh.renderOrder = -50 + level;
    mesh.userData.bevKey = key;
    return mesh;
  }
}

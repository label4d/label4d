import type { Vec3 } from '../geometry/math';
import type { TileScheduler } from './TileScheduler';

export interface PotreeDecodedChunk {
  positions: Float32Array; // xyz, chunk-local (add node box min offset externally)
  count: number;
}

/** LAZ/octree.bin point decoder, injected (laz-perf / potree-core adapter). */
export type LazDecoder = (buffer: ArrayBuffer, pointCount: number, bytesPerPoint: number) => PotreeDecodedChunk;

export interface PotreeNode {
  name: string;
  level: number;
  numPoints: number;
  isLeaf: boolean;
  boxMin: Vec3;
  boxMax: Vec3;
  /** byte offset into octree.bin (derived from DFS order + numPoints) */
  byteOffset: number;
}

export interface PotreeMetadata {
  version: string;
  octree: { level: number };
  boundingBox: { min: number[]; max: number[] };
  attributes: Array<{ name: string; size: number; type: string }>;
  hierarchy?: { firstChunkSize?: number; stepSize?: number; depth?: number };
}

interface HierarchyRecord {
  type: number; // 1 = inner (8 children follow), 2 = leaf, 0 = absent
  numPoints: number;
}

export type NetClient = {
  fetchJson: (url: string) => Promise<unknown>;
  fetchBinary: (url: string, init?: RequestInit) => Promise<ArrayBuffer>;
};

export const defaultNetClient: NetClient = {
  fetchJson: (url) => fetch(url).then((r) => r.json()),
  fetchBinary: (url, init) => fetch(url, init).then((r) => r.arrayBuffer()),
};

/**
 * Adapter over Potree 2.x octrees (PotreeConverter output) for static
 * mega-point-cloud overlays. Scheduling: nodes sorted by distance to a query
 * point, loaded via HTTP Range requests on octree.bin, decoded by the
 * injected LazDecoder.
 *
 * NOTE: hierarchy record layout (5-byte [type u8][numPoints u32], DFS order)
 * and derived byte offsets follow the Potree 2.0 format; validate against a
 * real converter dump when wiring a dataset and adjust here only.
 */
export class PotreeOverlay {
  nodes = new Map<string, PotreeNode>();
  metadata: PotreeMetadata | null = null;
  rootBox: { min: Vec3; max: Vec3 } | null = null;
  bytesPerPoint = 12;

  private initPromise: Promise<void> | null = null;

  constructor(
    private readonly baseUrl: string,
    private readonly scheduler: TileScheduler,
    private readonly decoder: LazDecoder,
    private readonly net: NetClient = defaultNetClient
  ) {}

  initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.doInitialize();
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const base = this.baseUrl.replace(/\/$/, '');
    const metadata = (await this.net.fetchJson(`${base}/metadata.json`)) as PotreeMetadata;
    this.metadata = metadata;
    this.bytesPerPoint = metadata.attributes.reduce((sum, a) => sum + a.size, 0) || 12;
    this.rootBox = {
      min: { x: metadata.boundingBox.min[0], y: metadata.boundingBox.min[1], z: metadata.boundingBox.min[2] },
      max: { x: metadata.boundingBox.max[0], y: metadata.boundingBox.max[1], z: metadata.boundingBox.max[2] },
    };
    const hierarchyBuffer = await this.net.fetchBinary(`${base}/hierarchy.bin`);
    this.parseHierarchy(new DataView(hierarchyBuffer), this.rootBox);
  }

  private parseHierarchy(view: DataView, root: { min: Vec3; max: Vec3 }): void {
    let offset = 0;
    let byteCursor = 0;
    const stack: Array<{ name: string; level: number; min: Vec3; max: Vec3 }> = [
      { name: 'r', level: 0, min: root.min, max: root.max },
    ];
    const total = view.byteLength;
    while (offset + 5 <= total && stack.length > 0) {
      const parent = stack.shift() as { name: string; level: number; min: Vec3; max: Vec3 };
      const type = view.getUint8(offset);
      const numPoints = view.getUint32(offset + 1, true);
      offset += 5;
      const node: PotreeNode = {
        name: parent.name,
        level: parent.level,
        numPoints,
        isLeaf: type === 2,
        boxMin: parent.min,
        boxMax: parent.max,
        byteOffset: byteCursor,
      };
      byteCursor += numPoints * this.bytesPerPoint;
      this.nodes.set(node.name, node);
      if (type === 1) {
        // children occupy octants 1..8 (x,y,z bits), pushed in DFS order
        const mid = {
          x: (parent.min.x + parent.max.x) / 2,
          y: (parent.min.y + parent.max.y) / 2,
          z: (parent.min.z + parent.max.z) / 2,
        };
        const children: Array<{ name: string; level: number; min: Vec3; max: Vec3 }> = [];
        for (let octant = 1; octant <= 8; octant++) {
          const dx = octant & 1 ? 1 : 0;
          const dy = octant & 2 ? 1 : 0;
          const dz = octant & 4 ? 1 : 0;
          children.push({
            name: `${parent.name}${octant}`,
            level: parent.level + 1,
            min: { x: dx ? mid.x : parent.min.x, y: dy ? mid.y : parent.min.y, z: dz ? mid.z : parent.min.z },
            max: { x: dx ? parent.max.x : mid.x, y: dy ? parent.max.y : mid.y, z: dz ? parent.max.z : mid.z },
          });
        }
        // DFS: children immediately follow the parent record
        stack.unshift(...children);
      }
    }
  }

  /**
   * Requests up to `maxNodes` leaf nodes nearest to `center`, skipping nodes
   * above `maxLevel`. Returns load promises for progress tracking.
   */
  requestNear(center: Vec3, maxNodes = 64, maxLevel = Infinity): Array<Promise<PotreeDecodedChunk>> {
    const candidates = [...this.nodes.values()]
      .filter((n) => n.isLeaf && n.level <= maxLevel && n.numPoints > 0)
      .sort(
        (a, b) =>
          this.nodeDistance(a, center) - this.nodeDistance(b, center)
      )
      .slice(0, maxNodes);
    return candidates.map((node) =>
      this.scheduler
        .request<PotreeDecodedChunk>(
          `potree:${node.name}`,
          -this.nodeDistance(node, center),
          node.numPoints * this.bytesPerPoint,
          () => this.loadNode(node)
        )
        .catch(() => ({ positions: new Float32Array(0), count: 0 }))
    );
  }

  private nodeDistance(node: PotreeNode, p: Vec3): number {
    const mid = {
      x: (node.boxMin.x + node.boxMax.x) / 2,
      y: (node.boxMin.y + node.boxMax.y) / 2,
      z: (node.boxMin.z + node.boxMax.z) / 2,
    };
    return Math.hypot(mid.x - p.x, mid.y - p.y, mid.z - p.z);
  }

  private async loadNode(node: PotreeNode): Promise<PotreeDecodedChunk> {
    const base = this.baseUrl.replace(/\/$/, '');
    const start = node.byteOffset;
    const end = start + node.numPoints * this.bytesPerPoint - 1;
    const buffer = await this.net.fetchBinary(`${base}/octree.bin`, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    return this.decoder(buffer, node.numPoints, this.bytesPerPoint);
  }
}

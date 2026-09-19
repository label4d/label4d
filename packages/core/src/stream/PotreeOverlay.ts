import type { Vec3 } from '../geometry/math';
import type { TileScheduler } from './TileScheduler';

export interface PotreeDecodedChunk {
  positions: Float32Array; // xyz，已应用 scale/offset 的世界坐标
  count: number;
}

/** Potree 2.0 非压缩点解码上下文：元数据顶层 scale/offset。 */
export interface PotreeDecodeContext {
  scale: Vec3;
  offset: Vec3;
}

/**
 * Potree 2.0 点记录解码器（注入式，可替换为 Worker/LAZ 版本）。
 * 输入为单个节点的 octree.bin 字节段，attributes 顺序布局，
 * position 字段为 int32×3，位于记录起始处。
 */
export type PotreeDecoder = (
  buffer: ArrayBuffer,
  pointCount: number,
  bytesPerPoint: number,
  ctx: PotreeDecodeContext
) => PotreeDecodedChunk;

/** 内置解码器：UNCOMPRESSED 编码，只取 position（int32×3 @0），应用 scale/offset。 */
export const potreeUncompressedDecoder: PotreeDecoder = (buffer, pointCount, bytesPerPoint, ctx) => {
  const positions = new Float32Array(pointCount * 3);
  const view = new DataView(buffer);
  for (let i = 0; i < pointCount; i++) {
    const base = i * bytesPerPoint;
    positions[i * 3] = view.getInt32(base, true) * ctx.scale.x + ctx.offset.x;
    positions[i * 3 + 1] = view.getInt32(base + 4, true) * ctx.scale.y + ctx.offset.y;
    positions[i * 3 + 2] = view.getInt32(base + 8, true) * ctx.scale.z + ctx.offset.z;
  }
  return { positions, count: pointCount };
};

export interface PotreeNode {
  name: string;
  level: number;
  numPoints: number;
  isLeaf: boolean;
  isProxy: boolean;
  /** octree.bin 内的字节段（代理节点在解析目标块后回填） */
  byteOffset: number;
  byteSize: number;
  boxMin: Vec3;
  boxMax: Vec3;
}

export interface PotreeMetadata {
  version: string;
  points: number;
  scale: number[];
  offset: number[];
  boundingBox: { min: number[]; max: number[] };
  attributes: Array<{ name: string; size: number; type: string }>;
  hierarchy: { firstChunkSize: number; stepSize: number; depth: number };
  encoding?: string;
}

export type NetClient = {
  fetchJson: (url: string) => Promise<unknown>;
  fetchBinary: (url: string, init?: RequestInit) => Promise<ArrayBuffer>;
};

export const defaultNetClient: NetClient = {
  fetchJson: (url) => fetch(url).then((r) => r.json()),
  fetchBinary: (url, init) => fetch(url, init).then((r) => r.arrayBuffer()),
};

const BYTES_PER_NODE = 22; // [type u8][childMask u8][numPoints u32][byteOffset i64][byteSize i64]

const TYPE_NORMAL = 0;
const TYPE_LEAF = 1;
const TYPE_PROXY = 2;

/**
 * Potree 2.x（PotreeConverter master）静态八叉树适配器。
 *
 * hierarchy.bin 记录为 22 字节 [type][childMask][numPoints][byteOffset][byteSize]，
 * 块内节点按 BFS 展开顺序排列（记录 i 对应展开数组第 i 项）；type=2 的代理节点
 * 指向 hierarchy.bin 内的子块，子块首记录即代理节点本身。
 * octree.bin 中节点字节段由记录显式给出（byteOffset/byteSize）。
 * 点坐标 = int32 原始值 × 元数据顶层 scale + 顶层 offset。
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
    private readonly decoder: PotreeDecoder,
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
    const hierarchy = await this.net.fetchBinary(`${base}/hierarchy.bin`);
    this.parseHierarchy(new DataView(hierarchy));
  }

  /** 与官方 loader 一致的扁平数组解析：记录 i 依序对应展开数组第 i 项。 */
  private parseHierarchy(view: DataView): void {
    const scale = this.metadata!.scale;
    const offset = this.metadata!.offset;
    const rootMin = this.rootBox!.min;
    const rootMax = this.rootBox!.max;

    const decodeContext: Array<{
      node: PotreeNode;
      start: number;
      size: number;
    }> = [];

    const root: PotreeNode = {
      name: 'r',
      level: 0,
      numPoints: 0,
      isLeaf: false,
      isProxy: false,
      byteOffset: 0,
      byteSize: 0,
      boxMin: rootMin,
      boxMax: rootMax,
    };
    this.nodes.set(root.name, root);
    decodeContext.push({ node: root, start: 0, size: this.metadata!.hierarchy.firstChunkSize });

    while (decodeContext.length > 0) {
      const { node: chunkRoot, start, size } = decodeContext.shift()!;
      const arr: PotreeNode[] = [chunkRoot];
      let arrIdx = 0;
      let i = start;
      const end = start + size;
      while (i + BYTES_PER_NODE <= end) {
        if (arrIdx >= arr.length) break; // 记录数与展开数不一致，防御性截断
        const current = arr[arrIdx++];
        const type = view.getUint8(i);
        const childMask = view.getUint8(i + 1);
        const numPoints = view.getUint32(i + 2, true);
        const byteOffset = Number(view.getBigInt64(i + 6, true));
        const byteSize = Number(view.getBigInt64(i + 14, true));
        i += BYTES_PER_NODE;

        if (type === TYPE_PROXY) {
          current.isProxy = true;
          current.numPoints = numPoints;
          // byteOffset/byteSize 此时指向 hierarchy 内子块，解析后回填
          decodeContext.push({ node: current, start: byteOffset, size: byteSize });
          continue;
        }
        current.numPoints = numPoints;
        current.byteOffset = byteOffset;
        current.byteSize = byteSize;
        current.isProxy = false; // 代理节点在其目标块首记录处转正
        current.isLeaf = childMask === 0;
        this.nodes.set(current.name, current);

        const mid = {
          x: (current.boxMin.x + current.boxMax.x) / 2,
          y: (current.boxMin.y + current.boxMax.y) / 2,
          z: (current.boxMin.z + current.boxMax.z) / 2,
        };
        for (let c = 0; c < 8; c++) {
          if ((childMask & (1 << c)) === 0) continue;
          const dx = (c >> 2) & 1;
          const dy = (c >> 1) & 1;
          const dz = c & 1;
          const child: PotreeNode = {
            name: `${current.name}${c}`,
            level: current.level + 1,
            numPoints: 0,
            isLeaf: false,
            isProxy: false,
            byteOffset: 0,
            byteSize: 0,
            boxMin: { x: dx ? mid.x : current.boxMin.x, y: dy ? mid.y : current.boxMin.y, z: dz ? mid.z : current.boxMin.z },
            boxMax: { x: dx ? current.boxMax.x : mid.x, y: dy ? current.boxMax.y : mid.y, z: dz ? current.boxMax.z : mid.z },
          };
          arr.push(child);
        }
      }
    }
    void scale;
    void offset;
  }

  /** 请求距 `center` 最近的最多 `maxNodes` 个节点（旧接口，保留兼容）。 */
  requestNear(center: Vec3, maxNodes = 96): Array<{ name: string; done: Promise<PotreeDecodedChunk> }> {
    return this.requestView(center, maxNodes);
  }

  /**
   * 按屏幕空间收益调度：近处加载细粒度节点（高层级），远处加载概览级节点，
   * 保证整条轨迹都有可见覆盖。level 上限随距离增大而收紧。
   */
  requestView(camera: Vec3, maxNodes = 160): Array<{ name: string; done: Promise<PotreeDecodedChunk> }> {
    const scored: Array<{ node: PotreeNode; dist: number; levelCap: number }> = [];
    for (const node of this.nodes.values()) {
      if (node.isProxy || node.numPoints === 0) continue;
      const dist = this.nodeDistance(node, camera);
      // 距离越远，允许加载的层级越低（越粗），确保远处也有内容
      const levelCap = dist < 30 ? 10 : dist < 80 ? 8 : dist < 160 ? 6 : dist < 320 ? 4 : 2;
      if (node.level > levelCap) continue;
      scored.push({ node, dist, levelCap });
    }
    scored.sort((a, b) => a.dist - b.dist);
    const picked = scored.slice(0, maxNodes);
    return picked.map(({ node, dist }) => ({
      name: node.name,
      done: this.scheduler
        .request<PotreeDecodedChunk>(
          `potree:${node.name}`,
          -dist,
          node.byteSize,
          () => this.loadNode(node)
        )
        .catch(() => ({ positions: new Float32Array(0), count: 0 })),
    }));
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
    const end = start + node.byteSize - 1;
    const buffer = await this.net.fetchBinary(`${base}/octree.bin`, {
      headers: { Range: `bytes=${start}-${end}` },
    });
    const metadata = this.metadata!;
    const ctx: PotreeDecodeContext = {
      scale: { x: metadata.scale[0], y: metadata.scale[1], z: metadata.scale[2] },
      offset: { x: metadata.offset[0], y: metadata.offset[1], z: metadata.offset[2] },
    };
    return this.decoder(buffer, node.numPoints, this.bytesPerPoint, ctx);
  }
}

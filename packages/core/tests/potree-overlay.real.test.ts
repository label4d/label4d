import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PotreeOverlay, potreeUncompressedDecoder } from '../src/stream/PotreeOverlay';
import type { NetClient } from '../src/stream/PotreeOverlay';
import type { TileScheduler } from '../src/stream/TileScheduler';

/**
 * 针对真实 PotreeConverter 产物的集成测试（数据 gitignored，缺失时跳过）。
 * 数据：apps/web-ui/public/kitti/potree（KITTI 2200 万点拼接云，Potree 2.0 格式）。
 */
const FIXTURE = join(__dirname, '../../../apps/web-ui/public/kitti/potree');
const hasFixture = existsSync(join(FIXTURE, 'metadata.json'));

describe.skipIf(!hasFixture)('PotreeOverlay against real PotreeConverter output', () => {
  it('parses hierarchy, resolves proxies, exposes explicit node byte ranges', async () => {
    const file = (name: string) => readFileSync(join(FIXTURE, name));
    const net: NetClient = {
      fetchJson: async (url) => JSON.parse(file(url.endsWith('metadata.json') ? 'metadata.json' : 'metadata.json').toString('utf8')),
      fetchBinary: async (url) => {
        const name = url.includes('hierarchy') ? 'hierarchy.bin' : 'octree.bin';
        return file(name).buffer.slice(file(name).byteOffset, file(name).byteOffset + file(name).byteLength);
      },
    };
    const scheduler = {
      request: (_id: string, _p: number, _b: number, load: () => Promise<unknown>) => load(),
    } as unknown as TileScheduler;
    const overlay = new PotreeOverlay('kitti/potree', scheduler, potreeUncompressedDecoder, net);
    await overlay.initialize();

    const metadata = overlay.metadata!;
    expect(metadata.version).toBe('2.0');
    const totalPoints = metadata.points;
    expect(totalPoints).toBeGreaterThan(0);

    // 全部真实节点点数之和 == 总点数（代理不含数据）
    let sum = 0;
    let proxies = 0;
    let maxLevel = 0;
    for (const node of overlay.nodes.values()) {
      if (node.isProxy) proxies++;
      else sum += node.numPoints;
      maxLevel = Math.max(maxLevel, node.level);
    }
    expect(sum).toBe(totalPoints);
    expect(proxies).toBe(0); // 全量解析后所有代理都已转正
    expect(overlay.nodes.size).toBeGreaterThan(10000);
    expect(maxLevel).toBeGreaterThanOrEqual(8);

    // 根节点字节段合法且在 octree.bin 范围内
    const root = overlay.nodes.get('r')!;
    expect(root.numPoints).toBeGreaterThan(0);
    expect(root.byteOffset + root.byteSize).toBeLessThanOrEqual(metadata.points * overlay.bytesPerPoint);
  });

  it('decodes node points that fall inside the node bounding box', async () => {
    const file = (name: string) => readFileSync(join(FIXTURE, name));
    const octree = file('octree.bin');
    const net: NetClient = {
      fetchJson: async () => JSON.parse(file('metadata.json').toString('utf8')),
      fetchBinary: async (url, init) => {
        // hierarchy（无 Range）与 octree Range 切片都走真实文件
        if (!init?.headers) return file('hierarchy.bin').buffer.slice(0, file('hierarchy.bin').byteLength);
        const range = new Headers(init.headers).get('Range')!;
        const [a, b] = range.replace('bytes=', '').split('-').map(Number);
        const sliced = octree.subarray(a, b + 1);
        return sliced.buffer.slice(sliced.byteOffset, sliced.byteOffset + sliced.byteLength);
      },
    };
    const scheduler = {
      request: (_id: string, _p: number, _b: number, load: () => Promise<unknown>) => load(),
    } as unknown as TileScheduler;
    const overlay = new PotreeOverlay('kitti/potree', scheduler, potreeUncompressedDecoder, net);
    await overlay.initialize();

    // 取一个较深节点附近的最近节点，解码并校验点落在其包围盒内
    const deep = [...overlay.nodes.values()]
      .filter((n) => !n.isProxy && n.numPoints > 1000)
      .sort((a, b) => b.level - a.level || b.numPoints - a.numPoints)[0];
    expect(deep).toBeTruthy();
    const [{ name, done }] = overlay.requestNear(deep.boxMin, 1, deep.level);
    const node = overlay.nodes.get(name)!;
    const chunk = await done;
    expect(chunk.count).toBe(node.numPoints);

    let inside = 0;
    for (let i = 0; i < chunk.count; i++) {
      const x = chunk.positions[i * 3];
      const y = chunk.positions[i * 3 + 1];
      const z = chunk.positions[i * 3 + 2];
      if (
        x >= node.boxMin.x - 0.01 && x <= node.boxMax.x + 0.01 &&
        y >= node.boxMin.y - 0.01 && y <= node.boxMax.y + 0.01 &&
        z >= node.boxMin.z - 0.01 && z <= node.boxMax.z + 0.01
      ) inside++;
    }
    expect(inside / chunk.count).toBeGreaterThan(0.97);
  });
});

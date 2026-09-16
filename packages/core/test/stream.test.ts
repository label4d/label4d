import { describe, expect, it, vi } from 'vitest';
import { TileScheduler } from '../src/stream/TileScheduler';
import { FrameBuffer } from '../src/stream/FrameBuffer';
import { BevPyramid } from '../src/stream/BevPyramid';
import { encodeHeightsToRGBA, decodePackedHeights } from '../src/stream/HeightField';
import type { TilesetConfig } from '../src/io/manifest';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('TileScheduler', () => {
  it('respects concurrency and priority order', async () => {
    let running = 0;
    let maxRunning = 0;
    const order: string[] = [];
    const scheduler = new TileScheduler({ concurrency: 2 });

    const makeTask = (id: string, delay: number) => () =>
      new Promise<string>((resolve) => {
        running++;
        maxRunning = Math.max(maxRunning, running);
        setTimeout(() => {
          running--;
          order.push(id);
          resolve(id);
        }, delay);
      });

    const promises = [
      scheduler.request('low', -10, 1, makeTask('low', 30)),
      scheduler.request('high', 10, 1, makeTask('high', 10)),
      scheduler.request('mid', 5, 1, makeTask('mid', 10)),
    ];
    await Promise.all(promises);
    expect(maxRunning).toBeLessThanOrEqual(2);
    expect(order[0]).toBe('high');
  });

  it('evicts least-recently-used resources over budget', async () => {
    const onEvict = vi.fn();
    const scheduler = new TileScheduler({ concurrency: 4, budgetBytes: 150, onEvict });
    await Promise.all([
      scheduler.request('a', 0, 100, async () => 'res-a'),
      scheduler.request('b', 0, 100, async () => 'res-b'),
    ]);
    await flush();
    // only 100 bytes can stay within the 150 budget
    expect(scheduler.stats().loadedBytes).toBeLessThanOrEqual(150);
    expect(onEvict).toHaveBeenCalledTimes(1);
    expect(onEvict.mock.calls[0][0]).toBe('a'); // a is older than b
  });
});

describe('FrameBuffer', () => {
  function makeProvider() {
    const disposed: number[] = [];
    return {
      disposed,
      provider: {
        load: async (frame: number) => ({ frame, bytes: new Uint8Array(10) }),
        bytes: () => 100,
        dispose: (item: { frame: number }) => disposed.push(item.frame),
      },
    };
  }

  it('prefetches the window and trims to budget', async () => {
    const { provider, disposed } = makeProvider();
    const scheduler = new TileScheduler({ concurrency: 8 });
    const buffer = new FrameBuffer(provider, scheduler, {
      windowAhead: 3,
      windowBehind: 2,
      budgetBytes: 1000,
    });
    buffer.setFrame(10);
    await flush();
    await flush();
    // frames 8..13 requested and cached (6 × 100B fits in 1000B)
    expect(buffer.isLoaded(8)).toBe(true);
    expect(buffer.isLoaded(13)).toBe(true);
    expect(buffer.get(10)).toBeDefined();
    expect(buffer.stats().cached).toBe(6);

    // tighten the budget: farthest frames are evicted first
    const tight = new FrameBuffer(provider, scheduler, {
      windowAhead: 3,
      windowBehind: 2,
      budgetBytes: 450,
    });
    tight.setFrame(10);
    await flush();
    await flush();
    expect(tight.stats().cached).toBeLessThanOrEqual(4);
    expect(disposed.length).toBeGreaterThan(0);
  });

  it('reports failures through events without breaking the cache', async () => {
    const failures: number[] = [];
    const scheduler = new TileScheduler({ concurrency: 2 });
    const buffer = new FrameBuffer(
      {
        load: async (frame) => {
          if (frame === 7) throw new Error('boom');
          return { frame };
        },
        bytes: () => 10,
        dispose: () => undefined,
      },
      scheduler,
      { windowAhead: 1, windowBehind: 0, budgetBytes: 1e9 }
    );
    buffer.events.on('failed', ({ frame }) => failures.push(frame));
    buffer.setFrame(7);
    await flush();
    await flush();
    expect(failures).toContain(7);
    expect(buffer.stats().pending).toBe(0);
  });
});

describe('BevPyramid', () => {
  const config: TilesetConfig = {
    originX: 0,
    originZ: 0,
    metersPerPixel: 0.1,
    width: 4096,
    height: 4096,
    tileSize: 512,
    urlTemplate: 'tiles/{level}/{x}/{y}.png',
  };

  it('height RGBA packing round-trips through the canvas-safe scheme', () => {
    const heights = Float32Array.from([-12.34, 0, 0.05, 87.65, -1000, 12]);
    const rgba = encodeHeightsToRGBA(heights);
    expect(rgba.length).toBe(heights.length * 4);
    const decoded = decodePackedHeights({ data: new Uint8ClampedArray(rgba), width: 3, height: 2 });
    heights.forEach((h, i) => expect(decoded[i]).toBeCloseTo(h, 2));
  });

  it('derives levels and grid sizes', () => {
    const pyramid = new BevPyramid(config);
    expect(pyramid.maxLevel).toBe(3); // 4096/512 = 8 → 3 halvings
    expect(pyramid.tileGridAt(3)).toEqual({ nx: 8, ny: 8 });
    expect(pyramid.tileGridAt(0)).toEqual({ nx: 1, ny: 1 });
    expect(pyramid.mppAt(3)).toBeCloseTo(0.1);
    expect(pyramid.mppAt(0)).toBeCloseTo(0.8);
  });

  it('selects level by screen density and enumerates visible tiles', () => {
    const pyramid = new BevPyramid(config);
    expect(pyramid.levelForMpp(0.1)).toBe(3); // native density → finest
    expect(pyramid.levelForMpp(0.9)).toBe(0); // 8x coarser → coarsest
    // 102.4m ≈ 1024px at level 3 (0.1 mpp) → 2×2 tiles
    const tiles = pyramid.tilesForRect({ minX: 0, minZ: 0, maxX: 102.4, maxZ: 102.4 }, 3);
    expect(tiles.length).toBe(4);
    expect(tiles).toContainEqual({ level: 3, x: 0, y: 0 });
    const url = pyramid.tileUrl(2, 1, 3);
    expect(url).toBe('tiles/2/1/3.png');
  });
});

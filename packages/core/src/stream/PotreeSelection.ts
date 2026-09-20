import * as THREE from 'three';
import type { PotreeNode } from './PotreeOverlay';

export interface PotreeViewOptions {
  camera: THREE.PerspectiveCamera;
  viewportWidth: number;
  viewportHeight: number;
  pointBudget?: number;
  targetSpacingPixels?: number;
  /** Nodes expanded last time get a small hysteresis band. */
  previous?: ReadonlySet<string>;
}

export interface PotreeSelection {
  node: PotreeNode;
  drawCount: number;
  priority: number;
}

/** Additive Potree hierarchy: retain ancestors, refine only visible branches.
 * Reference: potree/src/Potree_update_visibility.js. Unlike a replacement mesh
 * LOD, a child does not contain its parent's points.
 */
export function selectPotreeNodes(
  nodes: ReadonlyMap<string, PotreeNode>, rootSpacing: number, options: PotreeViewOptions
): PotreeSelection[] {
  const { camera } = options;
  const width = Math.max(1, options.viewportWidth);
  const height = Math.max(1, options.viewportHeight);
  const spacing = Math.max(1, options.targetSpacingPixels ?? 1.5);
  const budget = Math.max(0, Math.floor(options.pointBudget ?? Math.min(480_000, width * height / (spacing * spacing))));
  if (!budget) return [];
  camera.updateMatrixWorld();
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse)
  );
  const eye = camera.getWorldPosition(new THREE.Vector3());
  const focal = height * camera.projectionMatrix.elements[5] / 2;
  const box = new THREE.Box3();
  const center = new THREE.Vector3();
  const queue: Array<{ node: PotreeNode; pixels: number; distance: number }> = [];
  const push = (node: PotreeNode | undefined) => {
    if (!node || node.isProxy) return;
    box.min.set(node.boxMin.x, node.boxMin.y, node.boxMin.z);
    box.max.set(node.boxMax.x, node.boxMax.y, node.boxMax.z);
    if (!frustum.intersectsBox(box)) return;
    // Distance to box surface avoids rejecting a large node containing the eye.
    const distance = Math.max(camera.near, box.distanceToPoint(eye));
    const diameter = box.getSize(center).length();
    queue.push({ node, distance, pixels: Math.min(Math.hypot(width, height), focal * diameter / distance) });
  };
  push(nodes.get('r'));
  const selected: PotreeSelection[] = [];
  // Discover required detail BEFORE allocating the draw budget. Otherwise a
  // dense ancestor consumes the budget and prevents zoom from visiting children.
  while (queue.length && selected.length < Math.min(4096, budget)) {
    queue.sort((a, b) => b.pixels - a.pixels || a.node.level - b.node.level || a.node.name.localeCompare(b.node.name));
    const { node, pixels, distance } = queue.shift()!;
    // Limit each incremental layer's contribution as well as the global sum.
    // Dense source nodes must not turn into solid squares merely because loaded.
    const localBudget = Math.max(1, Math.floor(pixels * pixels / (spacing * spacing * (node.level + 1) ** 2)));
    const drawCount = Math.min(node.numPoints, localBudget);
    selected.push({ node, drawCount, priority: pixels });
    const projectedSpacing = rootSpacing / 2 ** node.level * focal / distance;
    const threshold = spacing * (Array.from({ length: 8 }, (_, i) => options.previous?.has(`${node.name}${i}`)).some(Boolean) ? 0.85 : 1.15);
    if (projectedSpacing <= threshold) continue;
    for (let i = 0; i < 8; i++) push(nodes.get(`${node.name}${i}`));
  }
  // Keep a minimal additive contribution from every selected ancestor. Share
  // the remaining budget across branches rather than spending it in traversal
  // order. Square-root weights prevent one dense source node monopolizing it.
  const capacities = selected.map(s => s.drawCount);
  const weights = selected.map(s => Math.sqrt(s.drawCount) * (s.node.level + 1));
  for (const item of selected) item.drawCount = Math.min(1, item.drawCount);
  let remaining = budget - selected.reduce((sum, s) => sum + s.drawCount, 0);
  let active = selected.map((_, i) => i).filter(i => capacities[i] > selected[i].drawCount);
  while (remaining > 0 && active.length) {
    const totalWeight = active.reduce((sum, i) => sum + weights[i], 0);
    const available = remaining;
    let spent = 0;
    for (const i of active) {
      const amount = Math.min(capacities[i] - selected[i].drawCount,
        Math.floor(available * weights[i] / totalWeight));
      selected[i].drawCount += amount;
      spent += amount;
    }
    remaining -= spent;
    active = active.filter(i => capacities[i] > selected[i].drawCount);
    if (!spent) {
      // Deterministic rounding: highest-benefit entries receive remainder.
      active.sort((a,b) => weights[b] - weights[a] || a-b);
      for (const i of active) {
        if (!remaining) break;
        selected[i].drawCount++; remaining--;
      }
      break;
    }
  }
  return selected;
}

/** Deterministic Fisher-Yates order: drawRange prefixes form nested, unbiased
 * samples. Original point order can be spatially sorted; taking its prefix or
 * a fixed stride creates spatial bands. The source buffer is never mutated.
 */
export function stablePointOrder(positions: Float32Array, name: string): Float32Array {
  const result = positions.slice();
  let state = 2166136261;
  for (let i = 0; i < name.length; i++) state = Math.imul(state ^ name.charCodeAt(i), 16777619);
  state >>>= 0;
  for (let i = result.length / 3 - 1; i > 0; i--) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const j = Math.floor(state / 4294967296 * (i + 1));
    for (let axis = 0; axis < 3; axis++) {
      const value = result[i * 3 + axis];
      result[i * 3 + axis] = result[j * 3 + axis];
      result[j * 3 + axis] = value;
    }
  }
  return result;
}

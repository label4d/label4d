import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { selectPotreeNodes, stablePointOrder } from '../src/stream/PotreeSelection';
import type { PotreeNode } from '../src/stream/PotreeOverlay';

function tree() {
  const nodes = new Map<string, PotreeNode>();
  const add = (name: string, min: THREE.Vector3, max: THREE.Vector3, depth: number) => {
    nodes.set(name, { name, level: name.length - 1, numPoints: 1000, isProxy: false,
      isLeaf: !depth, byteOffset: 0, byteSize: 12000, boxMin: min.clone(), boxMax: max.clone() });
    if (!depth) return;
    const mid = min.clone().add(max).multiplyScalar(.5);
    for (let c = 0; c < 8; c++) add(name + c,
      new THREE.Vector3(c & 4 ? mid.x : min.x, c & 2 ? mid.y : min.y, c & 1 ? mid.z : min.z),
      new THREE.Vector3(c & 4 ? max.x : mid.x, c & 2 ? max.y : mid.y, c & 1 ? max.z : mid.z), depth - 1);
  };
  add('r', new THREE.Vector3(-10,-10,-10), new THREE.Vector3(10,10,10), 3);
  return nodes;
}
function camera(z = 50) {
  const c = new THREE.PerspectiveCamera(60, 1, .1, 1000);
  c.position.set(0,0,z); c.lookAt(0,0,0); return c;
}
describe('screen-space additive Potree selection', () => {
  it('honors point budgets including a partially drawn root', () => {
    for (const budget of [0, 1, 50, 5000, 20000]) {
      const selected = selectPotreeNodes(tree(), 4, {camera:camera(),viewportWidth:600,viewportHeight:600,pointBudget:budget});
      expect(selected.reduce((n,s)=>n+s.drawCount,0)).toBeLessThanOrEqual(budget);
      for (const s of selected) expect(s.drawCount).toBeLessThanOrEqual(s.node.numPoints);
    }
  });
  it('preserves the ancestor path and spreads coarse coverage across branches', () => {
    const selected = selectPotreeNodes(tree(), 4, {camera:camera(),viewportWidth:600,viewportHeight:600,pointBudget:20000});
    const names = new Set(selected.map(s=>s.node.name));
    for (const name of names) if(name !== 'r') expect(names.has(name.slice(0,-1))).toBe(true);
    for(let i=0;i<8;i++) expect(names.has('r'+i)).toBe(true);
  });
  it('culls a cloud behind the camera and increases detail when approaching', () => {
    const c=camera();c.lookAt(0,0,100);
    expect(selectPotreeNodes(tree(),4,{camera:c,viewportWidth:600,viewportHeight:600})).toHaveLength(0);
    const select=(z:number)=>selectPotreeNodes(tree(),4,{camera:camera(z),viewportWidth:600,viewportHeight:600});
    expect(select(40).length).toBeGreaterThan(select(900).length);
  });
  it('still refines on zoom when a dense root alone could consume the budget', () => {
    const nodes = tree();
    nodes.get('r')!.numPoints = 1_000_000;
    const select = (z: number) => selectPotreeNodes(nodes, 4, {
      camera: camera(z), viewportWidth: 600, viewportHeight: 600, pointBudget: 5000,
    });
    const far = select(900), near = select(40);
    expect(Math.max(...near.map(s => s.node.level))).toBeGreaterThan(Math.max(...far.map(s => s.node.level)));
    expect(near.filter(s => s.node.level > 0).reduce((n,s) => n+s.drawCount,0)).toBeGreaterThan(0);
    expect(near.reduce((n,s) => n+s.drawCount,0)).toBeLessThanOrEqual(5000);
  });
  it('returns a repeatable plan for an unchanged camera', () => {
    const nodes=tree();const opts={camera:camera(),viewportWidth:600,viewportHeight:600};
    const a=selectPotreeNodes(nodes,4,opts);
    expect(selectPotreeNodes(nodes,4,{...opts,previous:new Set(a.map(s=>s.node.name))})).toEqual(a);
  });
});
describe('stable sampling', () => {
  it('preserves all xyz tuples without mutation and covers the whole ordered source', () => {
    const input=Float32Array.from({length:3000},(_,i)=>Math.floor(i/3));
    const before=input.slice();const a=stablePointOrder(input,'r012');const b=stablePointOrder(input,'r012');
    expect(a).toEqual(b);expect(input).toEqual(before);
    const ids=[];for(let i=0;i<a.length;i+=3){expect(a[i]).toBe(a[i+1]);expect(a[i]).toBe(a[i+2]);ids.push(a[i]);}
    expect(new Set(ids).size).toBe(1000);
    expect(Math.max(...ids.slice(0,50))).toBeGreaterThan(900);
    expect(Math.min(...ids.slice(0,50))).toBeLessThan(100);
  });
});

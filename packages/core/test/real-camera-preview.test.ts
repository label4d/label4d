import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Matrix4, Vector3 } from 'three';
import { CameraProjector, EgoTrack } from '../src/projection/projection';
import { parsePcd } from '../src/io/pcd';
import { validateManifest } from '../src/io/manifest';
const output = resolve('../../apps/web-ui/public/kitti-camera');
const calibration = resolve('../../fixtures/calibration/2011_09_26');
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const calib = (name: string): Record<string, number[]> => Object.fromEntries(readFileSync(`${calibration}/${name}`, 'utf8').split(/\r?\n/).flatMap(line => { const m = line.match(/^(\w+):\s*(.+)$/); if (!m) return []; const a = m[2].trim().split(/\s+/).map(Number); return a.every(Number.isFinite) ? [[m[1], a]] : []; }));
const transform = (r: number[], t = [0,0,0]) => new Matrix4().set(r[0],r[1],r[2],t[0],r[3],r[4],r[5],t[1],r[6],r[7],r[8],t[2],0,0,0,1);
const basis = new Matrix4().set(1,0,0,0, 0,0,1,0, 0,-1,0,0, 0,0,0,1);
describe.skipIf(!existsSync(`${output}/manifest.json`))('Real KITTI alignment against official calibration and human labels', () => {
  it.each([0,12,100,199])('matches P_rect_02 R_rect_00 T_velo_cam for frame %s', frame => {
    const manifest = validateManifest(json(`${output}/manifest.json`));
    const cam=calib('calib_cam_to_cam.txt'), velo=calib('calib_velo_to_cam.txt'), imu=calib('calib_imu_to_velo.txt');
    const poses=manifest.egoPoses as number[][];
    const projector=CameraProjector.create(manifest.cameras![0],new EgoTrack(new Float64Array(poses.flat()),manifest.frameCount));
    const worldToCam0=transform(cam.R_rect_00).multiply(transform(velo.R,velo.T)).multiply(transform(imu.R,imu.T)).multiply(basis.clone().invert()).multiply(new Matrix4().fromArray(poses[frame]).invert());
    const bytes=readFileSync(resolve('../../apps/web-ui/public/kitti-camera/pcd',`${frame}.pcd`));
    const cloud=parsePcd(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    const raw=readFileSync(resolve('../../fixtures/kitti-tracking-source/velodyne',`${String(frame).padStart(6,'0')}.bin`));
    expect(raw.length / 16).toBe(cloud.count);
    const localToRect=transform(cam.R_rect_00).multiply(transform(velo.R,velo.T));
    expect(readFileSync(`${output}/images/${frame}.png`).equals(readFileSync(resolve('../../fixtures/kitti-tracking-source/images',`${String(frame).padStart(6,'0')}.png`)))).toBe(true);
    let visible=0;
    for(let i=0;i<cloud.count;i+=997) {
      const p=new Vector3().fromArray(cloud.positions,i*3), rect=p.clone().applyMatrix4(worldToCam0), P=cam.P_rect_02;
      const denominator=P[8]*rect.x+P[9]*rect.y+P[10]*rect.z+P[11];
      if(denominator<=0.01) continue;
      const actual=projector.projectPoint(p,frame);
      expect(actual.valid).toBe(true);
      expect(actual.x).toBeCloseTo((P[0]*rect.x+P[1]*rect.y+P[2]*rect.z+P[3])/denominator,4);
      expect(actual.y).toBeCloseTo((P[4]*rect.x+P[5]*rect.y+P[6]*rect.z+P[7])/denominator,4);
      const local=new Vector3(raw.readFloatLE(i*16),raw.readFloatLE(i*16+4),raw.readFloatLE(i*16+8)).applyMatrix4(localToRect);
      const d=P[8]*local.x+P[9]*local.y+P[10]*local.z+P[11];
      if(d>2) {
        expect(Math.abs(actual.x-(P[0]*local.x+P[1]*local.y+P[2]*local.z+P[3])/d)).toBeLessThan(0.02);
        expect(Math.abs(actual.y-(P[4]*local.x+P[5]*local.y+P[6]*local.z+P[7])/d)).toBeLessThan(0.02);
      }
      visible++;
    }
    expect(visible).toBeGreaterThan(10);
    expect(manifest.potree?.url).toBe('/kitti-camera/potree');
  });
  it('uses a rebuilt static tree containing exactly the filtered same-sequence points', () => {
    const report=json(`${output}/alignment-report.json`);
    const metadata=json(`${output}/potree/metadata.json`);
    expect(metadata.points).toBe(report.staticPoints);
    expect(metadata.points).toBeGreaterThan(20_000_000);
    expect(metadata.points).toBeLessThan(report.dynamicPoints);
  });
  it('matches committed official image hashes, preventing raw/tracking cross-sequence pairing', () => {
    const reference=json(`${calibration}/tracking-reference.json`);
    for (const image of reference.images) expect(createHash('sha256').update(readFileSync(`${output}/images/${image.frame}.png`)).digest('hex')).toBe(image.sha256);
  });
  it('encloses the first visible car lidar returns along its length axis', () => {
    const track = json(`${output}/snapshot.json`).tracks.find((t: { meta: { id: string } }) => t.meta.id === 'kitti_00000');
    const bytes = readFileSync(`${output}/pcd/0.pcd`);
    const cloud = parsePcd(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const [x, y, z] = track.keyframes.pos;
    const [length, height, width] = track.keyframes.size;
    const yaw = track.keyframes.yaw[0], c = Math.cos(yaw), s = Math.sin(yaw);
    let enclosed = 0;
    for (let i = 0; i < cloud.count; i++) {
      const dx = cloud.positions[i * 3] - x, dy = cloud.positions[i * 3 + 1] - y, dz = cloud.positions[i * 3 + 2] - z;
      if (Math.abs(c * dx - s * dz) < length / 2 + 0.2 && Math.abs(dy) < height / 2 + 0.2 && Math.abs(s * dx + c * dz) < width / 2 + 0.2) enclosed++;
    }
    // Official first-frame car has ~767 returns; the old 90-degree error enclosed only ~253.
    expect(enclosed).toBeGreaterThan(700);
  });
  it('matches official tracking centers and dimensions through stationary and moving frames', () => {
    const manifest=validateManifest(json(`${output}/manifest.json`)), snapshot=json(`${output}/snapshot.json`);
    const cam=calib('calib_cam_to_cam.txt'), velo=calib('calib_velo_to_cam.txt'), imu=calib('calib_imu_to_velo.txt');
    const references=json(`${calibration}/tracking-reference.json`).rows as Array<{frame:number;type:string;bottomCam0:number[];sizeHWL:number[];rotationY:number}>;
    let checked=0;
    for(const ref of references) {
      if(!['Car','Van','Truck','Pedestrian','Person_sitting','Cyclist','Tram'].includes(ref.type)) continue;
      const worldToRect=transform(cam.R_rect_00).multiply(transform(velo.R,velo.T)).multiply(transform(imu.R,imu.T)).multiply(basis.clone().invert()).multiply(new Matrix4().fromArray((manifest.egoPoses as number[][])[ref.frame]).invert());
      const expected=new Vector3(...ref.bottomCam0 as [number,number,number]);expected.y-=ref.sizeHWL[0]/2;
      let closest=Infinity; let dimensions: number[] = []; let yaw = NaN;
      for(const track of snapshot.tracks) {
        if(track.meta.attributes.kitti_type!==ref.type) continue;
        const at=track.keyframes.frames.indexOf(ref.frame);if(at<0) continue;
        const center=new Vector3().fromArray(track.keyframes.pos,at*3).applyMatrix4(worldToRect);
        const distance=center.distanceTo(expected);
        if(distance<closest) { closest=distance; dimensions=track.keyframes.size.slice(at*3,at*3+3); yaw=track.keyframes.yaw[at]; }
      }
      expect(closest).toBeLessThan(0.000001); expect(dimensions).toEqual([ref.sizeHWL[2],ref.sizeHWL[0],ref.sizeHWL[1]]);
      // KITTI devkit rotates the local length axis (1,0,0) around camera Y.
      const lengthAxis = new Vector3(Math.cos(ref.rotationY), 0, -Math.sin(ref.rotationY)).transformDirection(worldToRect.clone().invert());
      lengthAxis.y = 0; lengthAxis.normalize();
      expect(new Vector3(Math.cos(yaw), 0, -Math.sin(yaw)).dot(lengthAxis)).toBeCloseTo(1, 10);
      checked++;
    }
    expect(checked).toBeGreaterThan(30);
  });
});

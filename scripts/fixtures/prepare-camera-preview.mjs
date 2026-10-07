/** Explicit R-mini Z-up -> v1 Y-up preview. Original fixtures remain unchanged. */
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const source = resolve(root, 'fixtures/r-mini');
const output = resolve(root, 'apps/web-ui/public/kitti-camera');
const base = '/kitti-camera';
if (!existsSync(join(source, 'images/0.png'))) throw new Error('Run pnpm fixtures:r-mini first: real KITTI images are missing');
const input = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8'));
if (input.formatVersion !== 2 || input.worldConvention.up !== 'z') throw new Error('Expected R-mini v2 Z-up fixture');
// Right-handed basis: (x,y,z) -> (x,z,-y). Ego and sensor bases stay unchanged.
const poses = input.pose.frames.map(({ T_world_from_ego: m }) => {
  const out = [...m];
  for (let c = 0; c < 4; c++) { out[c * 4] = m[c * 4]; out[c * 4 + 1] = m[c * 4 + 2]; out[c * 4 + 2] = -m[c * 4 + 1]; }
  return out;
});
mkdirSync(join(output, 'images'), { recursive: true });
mkdirSync(join(output, 'pcd'), { recursive: true });
for (let f = 0; f < poses.length; f++) {
  copyFileSync(join(source, `images/${f}.png`), join(output, `images/${f}.png`));
  const pcd = readFileSync(join(source, `pcd/${f}.pcd`));
  const marker = Buffer.from('DATA binary\n');
  const at = pcd.indexOf(marker);
  if (at < 0 || !pcd.subarray(0, at).toString().includes('FIELDS x y z intensity')) throw new Error('Unexpected PCD schema');
  const offset = at + marker.length;
  if ((pcd.length - offset) % 16) throw new Error('Incomplete PCD payload');
  for (let p = offset; p < pcd.length; p += 16) {
    const y = pcd.readFloatLE(p + 4), z = pcd.readFloatLE(p + 8);
    pcd.writeFloatLE(z, p + 4); pcd.writeFloatLE(-y, p + 8);
  }
  writeFileSync(join(output, `pcd/${f}.pcd`), pcd);
}
const cameras = input.sensors.filter((s) => s.type === 'camera').map((s) => ({
  id: s.sensorId, model: s.model, width: s.width, height: s.height,
  intrinsics: s.intrinsics, distortion: s.distortion, cameraToEgo: s.T_ego_from_sensor,
  imageTemplate: `${base}/${s.imageTemplate}`,
}));
const manifest = { formatVersion: 1, id: 'kitti_camera_0084_yup_preview', fps: 10,
  frameCount: poses.length, egoPoses: poses,
  pointCloud: { urlTemplate: `${base}/pcd/{frame}.pcd`, format: 'pcd', approxBytesPerFrame: 2_000_000 }, cameras };
writeFileSync(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Prepared ${poses.length} real camera + lidar frames at ${base}/manifest.json (explicit v1 preview)`);

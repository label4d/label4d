/** Column-major transforms. No scene/runtime projection code used here. */
export const AXIS_MAP = [1,0,0,0, 0,0,-1,0, 0,1,0,0, 0,0,0,1];
export const rt = (r, t = [0,0,0]) => [r[0],r[3],r[6],0, r[1],r[4],r[7],0, r[2],r[5],r[8],0, ...t,1];
export function multiply(a, b) {
  return Array.from({ length: 16 }, (_, i) => { const row = i % 4, col = Math.floor(i / 4); let v = 0; for (let k = 0; k < 4; k++) v += a[k * 4 + row] * b[col * 4 + k]; return v; });
}
export function inverse(m) {
  const rows = Array.from({length:4}, (_, r) => [...Array.from({length:4}, (_, c) => m[c*4+r]), ...Array.from({length:4}, (_, c) => Number(c===r))]);
  for (let c=0;c<4;c++) {
    let pivot=c; for(let r=c+1;r<4;r++) if(Math.abs(rows[r][c])>Math.abs(rows[pivot][c])) pivot=r;
    [rows[c],rows[pivot]]=[rows[pivot],rows[c]];
    const scale=rows[c][c]; if(Math.abs(scale)<1e-12) throw new Error('Singular calibration');
    rows[c]=rows[c].map(v=>v/scale);
    for(let r=0;r<4;r++) if(r!==c) { const f=rows[r][c]; rows[r]=rows[r].map((v,i)=>v-f*rows[c][i]); }
  }
  return Array.from({length:16},(_,i)=>rows[i%4][4+Math.floor(i/4)]);
}
export function apply(m, p) { return [0,1,2].map(r=>m[r]*p[0]+m[4+r]*p[1]+m[8+r]*p[2]+m[12+r]); }
export function parseCalibration(text) {
  return Object.fromEntries(text.split(/\r?\n/).flatMap(line=>{const m=line.match(/^(\w+):\s*(.+)$/); if(!m) return []; const v=m[2].trim().split(/\s+/).map(Number); return v.every(Number.isFinite) ? [[m[1],v]] : []; }));
}
export function camera2Config(cam, velo, imu) {
  const p=cam.P_rect_02;
  const intrinsics={fx:p[0],fy:p[5],cx:p[2],cy:p[6]};
  // P = K [I | t], including the nonzero depth baseline (p[11]).
  const t=[(p[3]-p[2]*p[11])/p[0],(p[7]-p[6]*p[11])/p[5],p[11]];
  const baseline=rt([1,0,0,0,1,0,0,0,1],t);
  const cam2FromImu=multiply(baseline,multiply(rt(cam.R_rect_00),multiply(rt(velo.R,velo.T),rt(imu.R,imu.T))));
  return {id:'cam2',model:'pinhole',width:cam.S_rect_02[0],height:cam.S_rect_02[1],intrinsics,
    cameraToEgo:multiply(AXIS_MAP,inverse(cam2FromImu)),imageTemplate:'/kitti-camera/images/{frame}.png'};
}

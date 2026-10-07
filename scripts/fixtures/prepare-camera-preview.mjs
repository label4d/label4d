/** Fixture orchestration only; all import and numerical work lives in tools/py. */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../',import.meta.url));
function python(script,args) {
 const result=spawnSync('uv',['run','--project','tools/py','python',`tools/py/${script}`,...args],{cwd:root,stdio:'inherit'});
 if(result.error) throw result.error;
 if(result.status!==0) throw new Error(`${script} failed with exit ${result.status}`);
}
python('fetch_tracking_source.py',['--output','fixtures/kitti-tracking-source','--sequence','0011','--frames','200']);
python('import_kitti_tracking.py',[
 '--input','fixtures/kitti-tracking-source','--sequence','0011','--frames','200',
 '--output','apps/web-ui/public/kitti-camera','--url-prefix','/kitti-camera',
 '--id','kitti_tracking_0011_official_aligned_v2',
 '--work-dir','fixtures/kitti-tracking-source/static-preview','--overwrite',
]);

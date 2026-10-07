/** Reproducible official tracking preview. Never combine raw-drive assets with tracking labels. */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root=fileURLToPath(new URL('../../',import.meta.url));
function run(command,args) {
 const result=spawnSync(command,args,{cwd:root,stdio:'inherit'});
 if(result.error) throw result.error;
 if(result.status!==0) throw new Error(`${command} failed with exit ${result.status}`);
}
run('python3',['scripts/fixtures/fetch-tracking-source.py']);
run('uv',['run','--project','tools/py','python','scripts/fixtures/build-tracking-preview.py']);
const converter=process.env.LABELFASTER_POTREE_CONVERTER ?? join(root,'third_party/PotreeConverter/build/PotreeConverter');
if(!existsSync(converter)) throw new Error('Build PotreeConverter using third_party/POTREE_BUILD.md or set LABELFASTER_POTREE_CONVERTER');
const las=join(root,'fixtures/kitti-tracking-source/static-preview/world.las');
run('uv',['run','--project','tools/py','python','tools/py/export_world_las.py','--input','fixtures/kitti-tracking-source/static-preview','--output',las]);
run(converter,[las,'-o','apps/web-ui/public/kitti-camera/potree','--encoding','UNCOMPRESSED']);

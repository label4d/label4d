import { describe, expect, it, vi } from 'vitest';
import { openManifestDataset } from '../src/dataset/ManifestDataset';
import { EditorSession } from '../src/session/EditorSession';
import { CameraProjector, EgoTrack } from '../src/projection/projection';
import type { SequenceManifest } from '../src/io/manifest';
import type { DatasetImage } from '../src/dataset/DatasetProvider';

const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const encoder = new TextEncoder();
function pcd(): ArrayBuffer {
  const header = encoder.encode('VERSION .7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n');
  const bytes = new Uint8Array(header.length + 16); bytes.set(header); bytes.set(new Uint8Array(new Float32Array([1,2,3,4]).buffer),header.length);
  return bytes.buffer;
}
function fixture() {
  const poses = [identity, [...identity.slice(0,12),10,2,3,1]];
  const cameraToEgo = [0,0,-1,0,-1,0,0,0,0,1,0,0,1,2,3,1];
  const camera = { id:'front',model:'pinhole' as const,width:100,height:50,intrinsics:{fx:50,fy:50,cx:50,cy:25},cameraToEgo,imageTemplate:'/images/{frame}.png' };
  const manifest: SequenceManifest = { formatVersion:1,id:'kitti-recording',frameCount:2,fps:12,egoPoses:poses,cameras:[camera],pointCloud:{format:'pcd',urlTemplate:'/pcd/{frame}.pcd'} };
  const close=vi.fn(); const image={width:100,height:50,close} as unknown as DatasetImage;
  const deps = { net:{fetchJson:vi.fn(async()=>({poses})),fetchBinary:vi.fn(async()=>pcd())},fetchImage:vi.fn(async()=>image) };
  return { manifest, poses, camera, deps, close, image };
}

describe('v1 DatasetProvider',()=>{
  it('shares cloud/images and preserves FPS timing, projection and editable identity',async()=>{
    const f=fixture();const provider=await openManifestDataset(f.manifest,f.deps,new AbortController().signal);
    expect(provider.description.id).toBe(f.manifest.id);expect(provider.capabilities).toEqual({editing:true,projection:'calibrated',imageFailure:'optional'});
    expect(provider.observations).toBeNull();expect(provider.sourceProjection).toBeNull();expect(provider.timeMicros).toBeNull();
    const cloud=await provider.cloud!.load(1);expect(cloud.count).toBe(1);expect([...cloud.positions]).toEqual([1,2,3]);expect(f.deps.net.fetchBinary).toHaveBeenCalledWith('/pcd/1.pcd',{signal:undefined});
    const images=provider.image('front');expect(await images.load(1)).toBe(f.image);expect(f.deps.fetchImage).toHaveBeenCalledWith('/images/1.png',undefined);images.dispose(f.image);expect(f.close).toHaveBeenCalledTimes(1);
    expect(provider.cameraPoseTime('front',1)).toBeCloseTo(1e6/12);
    const ego=new EgoTrack(provider.egoPoses,2);const original=CameraProjector.create(f.camera,ego);const adapted=CameraProjector.create(f.camera,ego);
    adapted.poseProvider=(frame)=>provider.cameraPose('front',frame);
    for(const frame of [0,1]) expect(adapted.projectPoint({x:4,y:5,z:6},frame)).toEqual(original.projectPoint({x:4,y:5,z:6},frame));
    provider.dispose();await expect(provider.cloud!.load(0)).rejects.toThrow('disposed');
  });
  it('closes late decoded images after disposal and rejects canceled loads',async()=>{
    const f=fixture();let finish!: (image: DatasetImage)=>void;
    const provider=await openManifestDataset(f.manifest,{...f.deps,fetchImage:()=>new Promise((resolve)=>{finish=resolve;})},new AbortController().signal);
    const load=provider.image('front').load(0);provider.dispose();finish(f.image);
    await expect(load).rejects.toThrow('disposed');expect(f.close).toHaveBeenCalledTimes(1);
    const controller=new AbortController();controller.abort();await expect(openManifestDataset(f.manifest,f.deps,controller.signal)).rejects.toThrow();
  });
  it('ignores obsolete v1 pose loads during a sequence switch',async()=>{
    const f=fixture();let finish!: (value: unknown)=>void;
    const session=new EditorSession({...f.deps,net:{...f.deps.net,fetchJson:()=>new Promise((resolve)=>{finish=resolve;})},raf:()=>0,cancelRaf:()=>undefined});
    const previous=session.loadManifest({...f.manifest,egoPoses:'/old-poses.json'});
    await session.loadManifest({formatVersion:1,id:'new-recording',frameCount:1,fps:10});
    finish({poses:f.poses});await previous;
    expect(session.manifest?.id).toBe('new-recording');expect(session.readOnly).toBe(false);expect(session.canEdit).toBe(true);expect(session.datasetCapabilities?.editing).toBe(true);
    session.dispose();
  });
  it('retains v1 editing/export even when optional camera images fail',async()=>{
    const f=fixture();const session=new EditorSession({...f.deps,fetchImage:async()=>{throw new Error('missing photo');},raf:()=>0,cancelRaf:()=>undefined});
    await session.loadManifest(f.manifest);
    expect(session.frameStatus).toBe('ready');expect(session.readOnly).toBe(false);expect(session.canEdit).toBe(true);
    expect(session.exportSnapshot().formatVersion).toBe(1);expect(session.currentPointCloud()?.count).toBe(1);
    session.dispose();
  });
});

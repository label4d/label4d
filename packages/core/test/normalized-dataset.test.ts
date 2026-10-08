import { afterEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { zipSync } from 'fflate';
import * as THREE from 'three';
import { openNormalizedDataset, datasetUrl, decodeCameraReferences } from '../src/dataset/NormalizedDataset';
import { EditorSession } from '../src/session/EditorSession';
import { Playhead } from '../src/playback/Playhead';
import { stateBoxCorners } from '../src/geometry/math';
import { TrackInstanceRenderer } from '../src/render/TrackInstanceRenderer';
import { CameraImageView } from '../src/render/CameraImageView';
const identity = [1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1];
const tilt = [1,0,0,0,0,0,1,0,0,-1,0,0,3,4,10,1];
const encoder = new TextEncoder();
const arrayBuffer = (b: Uint8Array) => b.slice().buffer;
async function hash(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await webcrypto.subtle.digest('SHA-256', arrayBuffer(bytes))), (b) => b.toString(16).padStart(2,'0')).join('');
}
function refs(count = 1): Uint8Array {
  const header = encoder.encode(`{'descr': '<i4', 'fortran_order': False, 'shape': (${count}, 6), }\n`);
  const bytes = new Uint8Array(10 + header.length + count*24);
  bytes.set([0x93,78,85,77,80,89,1,0]); new DataView(bytes.buffer).setUint16(8,header.length,true);
  bytes.set(header,10);
  // Official pixels deliberately differ from geometric projection.
  [1,22,33,0,0,0].forEach((v,i) => new DataView(bytes.buffer).setInt32(10+header.length+i*4,v,true));
  return zipSync({ 'camera_projection.npy': bytes });
}
async function fixture() {
  const pcdHeader = encoder.encode('VERSION .7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH 1\nHEIGHT 1\nPOINTS 1\nDATA binary\n');
  const pcd = new Uint8Array(pcdHeader.length+16); pcd.set(pcdHeader); pcd.set(new Uint8Array(new Float32Array([3,4,10,1]).buffer),pcdHeader.length);
  const npz = refs(); const image = encoder.encode('image fixture');
  const cloudHash = await hash(pcd), attrsHash = await hash(npz), imageHash = await hash(image);
  const root = 'http://localhost/data/'; const resources = new Map<string, Uint8Array>();
  const times = [0,100000,350000];
  const sequence = { schema: 'labelfaster.normalized-sequence/1', id: 'test-source', coordinateSystem: { handedness:'right',up:'Y',unit:'meter',matrixOrder:'column-major',sourceWorldToLocal:identity }, time:{unit:'microsecond',sourceOriginMicros:'1234567890123456',matchingPolicy:'exact-frame-key',missingPolicy:'reject'}, provenance:{dataset:'waymo-perception'}, sensors:[{id:'front',kind:'camera',sourceId:1,name:'front',sensorToEgo:identity,model:'pinhole-brown-conrady',width:100,height:100,intrinsics:[50,50,50,50],distortion:[0,0,0,0,0]},{id:'top',kind:'lidar',sourceId:1,name:'top',sensorToEgo:identity}], frames:times.map((timeMicros,index)=>({index,timeMicros,path:`frames/${index}.json`})), bev:{path:'bev/map.png',originX:0,originZ:0,metersPerPixel:1,width:100,height:50} };
  const frames = times.map((timeMicros,index)=>({schema:'labelfaster.normalized-frame/1',sequenceId:sequence.id,index,timeMicros,egoToWorld:identity,
    samples:[{sensorId:'front',status:'available',sampleId:`${index}:front`,referenceTimeMicros:timeMicros,poseTimeMicros:timeMicros+50000,cameraToWorld:[...identity.slice(0,12),1,0,0,1],image:`images/${index}.jpg`,imageSha256:imageHash}, ...[1,2].map((returnId)=>({sensorId:'top',status:'available',sampleId:`${index}:${returnId}`,referenceTimeMicros:timeMicros,returnId,pointOffset:returnId-1,pointCount:returnId===1?1:0}))],
    boxObservations:index===1?[]:[{objectId:'object',source:'human-observation',label:1,size:[4,2,6],boxToWorld:tilt}], sourceComponents:{projected_lidar_box:index===1?[]:[{'key.camera_name':1,'key.laser_object_id':'object','[ProjectedLiDARBoxComponent].box.center.x':40,'[ProjectedLiDARBoxComponent].box.center.y':50,'[ProjectedLiDARBoxComponent].box.size.x':20,'[ProjectedLiDARBoxComponent].box.size.y':30}]},
    pointCloud:{path:`pcd/${index}.pcd`,format:'pcd-xyzi-binary',pointCount:1,sha256:cloudHash,attributes:`attrs/${index}.npz`,attributesSha256:attrsHash,attributeSchema:'labelfaster.point-attributes/1'}}));
  function publish() { frames.forEach((f,i)=> { resources.set(root+`frames/${i}.json`,encoder.encode(JSON.stringify(f))); resources.set(root+f.pointCloud.path,pcd); resources.set(root+f.pointCloud.attributes,npz); resources.set(root+`images/${i}.jpg`,image); }); }
  publish();
  vi.stubGlobal('crypto',webcrypto);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const bytes=resources.get(String(url)); return new Response(bytes ? arrayBuffer(bytes) : null, {status:bytes?200:404,headers:{'content-type':String(url).endsWith('.json')?'application/json':'application/octet-stream'}});
  }));
  vi.stubGlobal('createImageBitmap',vi.fn(async()=>({width:100,height:100,close:vi.fn()})));
  return {sequence,frames,root,resources,publish};
}
afterEach(()=>vi.unstubAllGlobals());
describe('normalized source presentation',()=>{
  it('rejects escaped paths, wrong timing, transforms and point spans',async()=>{
    for (const path of ['../evil','/evil','a/%2e%2e/b','https://other/a','a\\b']) expect(()=>datasetUrl('http://localhost/data/',path)).toThrow();
    const f=await fixture(); f.sequence.frames[1].timeMicros=0;
    await expect(openNormalizedDataset(f.sequence,f.root+'sequence.json',new AbortController().signal)).rejects.toThrow('time index');
    f.sequence.frames[1].timeMicros=100000; f.frames[0].samples[1].pointOffset=4; f.publish();
    await expect(openNormalizedDataset(f.sequence,f.root+'sequence.json',new AbortController().signal)).rejects.toThrow('point span');
    f.frames[0].samples[1].pointOffset=0;f.frames[0].egoToWorld=[...identity]; f.frames[0].egoToWorld[0]=2; f.publish();
    await expect(openNormalizedDataset(f.sequence,f.root+'sequence.json',new AbortController().signal)).rejects.toThrow('pose mismatch');
  });
  it('preserves full pose, gaps, sampled camera pose, source pixels and immutable session',async()=>{
    const f=await fixture();const session=new EditorSession({raf:()=>0,cancelRaf:()=>undefined,pointCloudWindow:{ahead:0,behind:0,budgetBytes:100000}});
    await session.loadNormalized(f.sequence,f.root+'sequence.json');
    expect(session.bevPyramid?.tileWorldRect(0,0,0)).toEqual({minX:0,minZ:0,maxX:100,maxZ:50});
    expect(session.frameStatus).toBe('ready'); expect(session.manifest).toHaveProperty('schema','labelfaster.browser-observations/1'); expect(session.readOnly).toBe(true);expect(session.canEdit).toBe(false);
    const state=session.store.resolveState('object',0)!;expect(state.boxToWorld).toEqual(tilt);
    const corners=new Float64Array(24); stateBoxCorners(state,corners); expect([...corners.slice(0,3)]).toEqual([1,7,9]);
    const boxes=new TrackInstanceRenderer(session.store,session.selection,session.labels);boxes.sync(0);
    const mesh=boxes.group.children.find((a)=>a instanceof THREE.InstancedMesh) as THREE.InstancedMesh;
    const matrix=new THREE.Matrix4();mesh.getMatrixAt(0,matrix); expect(matrix.elements[6]).toBe(2);expect(matrix.elements[9]).toBe(-6);expect(mesh.count).toBe(1);
    const projector=session.projectors.get('front')!;expect(projector.worldToCamera({x:1,y:0,z:10},0)).toEqual({x:0,y:0,z:10});expect(session.cameraPoseTime('front')).toBe(.05);
    const camera=new CameraImageView(session.labels);camera.attachProjector(projector);camera.setOptions({cloudProjection:true,showAll:false});camera.syncFrame(0,session.store,session.selection,session.currentPointCloud());
    const points=camera.group.children.find((a)=>a instanceof THREE.Points) as THREE.Points;
    expect([...points.geometry.getAttribute('position').array].slice(0,3)).toEqual([22,67,0.2].map(Math.fround));
    expect(camera.pick(40,50)?.id).toBe('object');
    expect(()=>session.exportSnapshot()).toThrow('read-only');expect(()=>session.store.setKeyframe('object',0,state)).toThrow('immutable');
    session.selection.select(['object']);session.deleteSelection();session.duplicateSelection();session.setTool('box');expect(session.tools.activeTool).toBe('select');expect(session.store.trackCount).toBe(1);
    session.setFrame(1);await vi.waitFor(()=>expect(session.frameStatus).toBe('ready'));expect(session.store.activeTrackIds(1)).toEqual([]);expect(session.store.resolveState('object',1)).toBeNull();expect(session.playhead.timeAt(2)).toBe(.35);
    boxes.sync(1);expect(mesh.count).toBe(0);
    camera.dispose();boxes.dispose();session.dispose();
  });
  it('rejects corrupt cloud or mismatched attribute shape',async()=>{
    const f=await fixture();const provider=await openNormalizedDataset(f.sequence,f.root+'sequence.json',new AbortController().signal);
    f.resources.set(f.root+'pcd/0.pcd',encoder.encode('corrupt'));await expect(provider.cloud.load(0,new AbortController().signal)).rejects.toThrow('SHA256 mismatch');
    expect(()=>decodeCameraReferences(arrayBuffer(refs()),2)).toThrow('shape mismatch');provider.dispose();
  });
  it('keeps the presented frame during loading and ignores obsolete completions',async()=>{
    const f=await fixture();const originalFetch=globalThis.fetch;
    let release: (()=>void) | undefined;
    vi.stubGlobal('fetch',vi.fn(async (url: string, init?: RequestInit)=> {
      if (String(url).endsWith('/pcd/1.pcd')) await new Promise<void>((resolve)=>{release=resolve;});
      return originalFetch(url,init);
    }));
    const session=new EditorSession({raf:()=>0,cancelRaf:()=>undefined,pointCloudWindow:{ahead:0,behind:0,budgetBytes:100000}});
    await session.loadNormalized(f.sequence,f.root+'sequence.json');
    session.setFrame(1);await vi.waitFor(()=>expect(release).toBeDefined());
    expect(session.frame).toBe(0);expect(session.currentPointCloud()?.count).toBe(1);expect(session.store.resolveState('object',session.frame)).not.toBeNull();
    session.setFrame(2);await vi.waitFor(()=>expect(session.frame).toBe(2));release!();
    await new Promise((resolve)=>setTimeout(resolve,20));expect(session.frame).toBe(2);
    await session.loadManifest({formatVersion:1,id:'v1',frameCount:3,fps:10});expect(session.readOnly).toBe(false);expect(session.canEdit).toBe(true);expect(session.playhead.timeAt(2)).toBe(.2);expect(session.store.trackCount).toBe(0);
    session.dispose();
  });
  it('cancels metadata initialization on sequence switch and checks photo integrity',async()=>{
    const f=await fixture();const originalFetch=globalThis.fetch;let release: (()=>void) | undefined;
    vi.stubGlobal('fetch',vi.fn(async(url: string,init?:RequestInit)=> {
      if (String(url).endsWith('/frames/0.json')) await new Promise<void>((resolve)=>{release=resolve;});
      return originalFetch(url,init);
    }));
    const session=new EditorSession({raf:()=>0,cancelRaf:()=>undefined,pointCloudWindow:{ahead:0,behind:0,budgetBytes:100000}});
    const load=session.loadNormalized(f.sequence,f.root+'sequence.json');await vi.waitFor(()=>expect(release).toBeDefined());
    await session.loadManifest({formatVersion:1,id:'replacement',frameCount:1,fps:10});release!();await load;
    expect(session.manifest?.id).toBe('replacement');expect(session.readOnly).toBe(false);
    vi.stubGlobal('fetch',originalFetch);f.resources.set(f.root+'images/0.jpg',encoder.encode('corrupt photo'));
    await session.loadNormalized(f.sequence,f.root+'sequence.json');expect(session.frameStatus).toBe('error');expect(session.canEdit).toBe(false);
    session.dispose();
  });
  it('uses actual nonuniform durations and clears the clock for v1',()=>{
    let tick: ((t:number)=>void) | null = null;const playhead=new Playhead(3,(cb)=>{tick=cb;return 0;},()=>{});
    playhead.setTimeMicros([0,100000,350000]);playhead.play();const start=performance.now();tick!(start+110);expect(playhead.frame).toBe(1);tick!(start+260);expect(playhead.frame).toBe(1);tick!(start+370);expect(playhead.frame).toBe(2);
    playhead.pause();playhead.setTimeMicros(null);expect(playhead.timeAt(2)).toBe(.2);playhead.dispose();
  });
});

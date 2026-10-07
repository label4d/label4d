"""One official tracking sequence: camera, lidar, OXTS and human labels, same frame IDs."""
import json, math, pathlib, shutil, hashlib
import numpy as np
ROOT=pathlib.Path(__file__).resolve().parents[2]
SRC=ROOT/'fixtures/kitti-tracking-source'
OUT=ROOT/'apps/web-ui/public/kitti-camera'
N=200
A=np.array([[1,0,0,0],[0,0,1,0],[0,-1,0,0],[0,0,0,1]],dtype=float)
calib={p[0]:np.array(p[1:],dtype=float) for p in (line.replace(':',' ').split() for line in (SRC/'calib/0011.txt').read_text().splitlines()) if len(p)>1}
def rt12(v):
 m=np.eye(4);m[:3,:]=v.reshape(3,4);return m
velo_cam=rt12(calib['Tr_velo_cam']);imu_velo=rt12(calib['Tr_imu_velo']);velo_imu=np.linalg.inv(imu_velo)
rect=np.eye(4);rect[:3,:3]=calib['R_rect'].reshape(3,3)
P=calib['P2'].reshape(3,4);K=P[:,:3];baseline=np.eye(4);baseline[:3,3]=np.linalg.solve(K,P[:,3])
cam_imu=baseline@rect@velo_cam@imu_velo
rows=np.loadtxt(SRC/'oxts/0011.txt')[:N]
if len(rows)!=N:raise ValueError('Missing OXTS frames')
scale=math.cos(rows[0,0]*math.pi/180);earth=6378137.
translations=np.stack([earth*scale*rows[:,1]*math.pi/180,earth*scale*np.log(np.tan(math.pi/4+rows[:,0]*math.pi/360)),rows[:,2]],axis=1);translations-=translations[0]
poses=[];world_velo=[];world_rect=[]
for f,row in enumerate(rows):
 roll,pitch,yaw=row[3:6] # OXTS radians, no degree conversion
 cr,sr,cp,sp,cy,sy=math.cos(roll),math.sin(roll),math.cos(pitch),math.sin(pitch),math.cos(yaw),math.sin(yaw)
 R=np.array([[cy*cp,cy*sp*sr-sy*cr,cy*sp*cr+sy*sr],[sy*cp,sy*sp*sr+cy*cr,sy*sp*cr-cy*sr],[-sp,cp*sr,cp*cr]])
 T=np.eye(4);T[:3,:3]=R;T[:3,3]=translations[f]
 poses.append((A@T@np.linalg.inv(A)).flatten(order='F').tolist())
 world_velo.append(A@T@velo_imu);world_rect.append(A@T@velo_imu@np.linalg.inv(velo_cam)@np.linalg.inv(rect))
for d in ['images','pcd']:(OUT/d).mkdir(parents=True,exist_ok=True)
STATIC=SRC/'static-preview'
(STATIC/'pcd').mkdir(parents=True,exist_ok=True)
tracks={};boxes={f:[] for f in range(N)}
labelmap={'Car':'Car','Van':'Truck','Truck':'Truck','Pedestrian':'Pedestrian','Person_sitting':'Pedestrian','Cyclist':'Cyclist','Tram':'Truck'}
for line in (SRC/'labels/0011.txt').read_text().splitlines():
 p=line.split();f,tid=int(p[0]),int(p[1]);kind=p[2]
 if f>=N or kind not in labelmap:continue
 h,w,l=map(float,p[10:13]);x,y,z,ry=map(float,p[13:17]);T=world_rect[f]
 # KITTI length axis is camera X, rotated about camera Y.
 center=(T@np.array([x,y-h/2,z,1]))[:3];heading=T[:3,:3]@np.array([math.cos(ry),0,-math.sin(ry)])
 angle=math.atan2(-heading[2],heading[0]);size=[l,h,w]
 t=tracks.setdefault(tid,{'meta':{'id':f'kitti_{tid:05d}','label':labelmap[kind],'startFrame':f,'endFrame':f,'interpolation':'linear','source':'human','attributes':{'kitti_type':kind}},'keyframes':{'frames':[],'pos':[],'yaw':[],'size':[]},'frameAttributes':[]})
 t['meta']['endFrame']=f;t['frameAttributes'].append({'frame':f,'attrs':{'occlusion':p[4],'truncation':p[3]}});k=t['keyframes'];k['frames'].append(f);k['pos'].extend(center.tolist());k['yaw'].append(angle);k['size'].extend(size)
 boxes[f].append((center,angle,np.array(size)))
def pcd(path,points):
 count=len(points);header=f'VERSION 0.7\nFIELDS x y z intensity\nSIZE 4 4 4 4\nTYPE F F F F\nCOUNT 1 1 1 1\nWIDTH {count}\nHEIGHT 1\nPOINTS {count}\nDATA binary\n'.encode()
 with path.open('wb') as out:out.write(header);out.write(points.astype('<f4').tobytes())
source_checks=[];static_count=0;dynamic_count=0
for f in range(N):
 image=SRC/'images'/f'{f:06d}.png';lidar=SRC/'velodyne'/f'{f:06d}.bin'
 raw=np.fromfile(lidar,dtype='<f4').reshape(-1,4);points=raw.copy();T=world_velo[f];points[:,:3]=raw[:,:3]@T[:3,:3].T+T[:3,3]
 pcd(OUT/'pcd'/f'{f}.pcd',points);dynamic_count+=len(points)
 keep=np.ones(len(points),dtype=bool)
 for center,yaw,size in boxes[f]:
  delta=points[:,:3]-center;c,s=math.cos(yaw),math.sin(yaw)
  localx=c*delta[:,0]-s*delta[:,2];localz=s*delta[:,0]+c*delta[:,2]
  inside=(abs(localx)<size[0]/2+0.2)&(abs(delta[:,1])<size[1]/2+0.2)&(abs(localz)<size[2]/2+0.2)
  keep&=~inside
 pcd(STATIC/'pcd'/f'{f}.pcd',points[keep]);static_count+=int(keep.sum())
 shutil.copyfile(image,OUT/'images'/f'{f}.png')
 if f in [0,12,50,100,199]:source_checks.append({'frame':f,'imageSha256':hashlib.sha256(image.read_bytes()).hexdigest(),'lidarSha256':hashlib.sha256(lidar.read_bytes()).hexdigest()})
 if f%50==0:print(f'Converted official frame {f}',flush=True)
id='kitti_tracking_0011_official_aligned_v2'
manifest={'formatVersion':1,'id':id,'fps':10,'frameCount':N,'egoPoses':poses,'pointCloud':{'urlTemplate':'/kitti-camera/pcd/{frame}.pcd','format':'pcd','approxBytesPerFrame':2000000},'cameras':[{'id':'cam2','model':'pinhole','width':1242,'height':375,'intrinsics':{'fx':P[0,0],'fy':P[1,1],'cx':P[0,2],'cy':P[1,2]},'cameraToEgo':(A@np.linalg.inv(cam_imu)).flatten(order='F').tolist(),'imageTemplate':'/kitti-camera/images/{frame}.png'}],'potree':{'url':'/kitti-camera/potree'}}
snapshot={'formatVersion':1,'sequenceId':id,'frameCount':N,'createdAt':'2026-10-07T00:00:00Z','qa':{'status':'pending','notes':'Official KITTI tracking 0011 frames 0..199'},'tracks':list(tracks.values()),'geometries':[]}
(OUT/'manifest.json').write_text(json.dumps(manifest,indent=2));(OUT/'snapshot.json').write_text(json.dumps(snapshot))
(OUT/'alignment-report.json').write_text(json.dumps({'source':'official KITTI tracking 0011','frames':N,'tracks':len(tracks),'dynamicPoints':dynamic_count,'staticPoints':static_count,'sourceChecks':source_checks,'staticPolicy':'Points inside human-labelled boxes excluded; unlabeled dynamics may remain.'},indent=2))
print(f'Prepared official aligned sequence: {N} frames, {len(tracks)} tracks, {static_count} static points',flush=True)

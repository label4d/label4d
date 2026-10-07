"""Fetch only tracking 0011 frames 0..199 using validated ZIP byte ranges."""
import io, urllib.request, zipfile, pathlib, time
ROOT=pathlib.Path(__file__).resolve().parents[2]
OUT=ROOT/'fixtures/kitti-tracking-source'
BASE='https://s3.eu-central-1.amazonaws.com/avg-kitti/'
class Remote(io.RawIOBase):
 def __init__(self,url):
  self.url=url;self.pos=0;self.cache=None
  self.size=int(urllib.request.urlopen(urllib.request.Request(url,method='HEAD'),timeout=60).headers['Content-Length'])
 def seekable(self):return True
 def seek(self,p,w=0):self.pos=p if w==0 else self.pos+p if w==1 else self.size+p;return self.pos
 def tell(self):return self.pos
 def response(self,start,end):
  for attempt in range(3):
   try:
    r=urllib.request.urlopen(urllib.request.Request(self.url,headers={'Range':f'bytes={start}-{end}'}),timeout=120)
    if r.status!=206 or not r.headers['Content-Range'].startswith(f'bytes {start}-'):raise ValueError('Server did not honor ZIP byte range')
    return r
   except Exception:
    if attempt==2:raise
    time.sleep(2)
 def read(self,n=-1):
  n=min(n if n>=0 else self.size-self.pos,self.size-self.pos)
  if n<=0:return b''
  start=self.pos
  if self.cache and start>=self.cache[0] and start+n<=self.cache[1]:
   with self.cache[2].open('rb') as f:f.seek(start-self.cache[0]);data=f.read(n)
  else:
   with self.response(start,start+n-1) as r:data=r.read()
  if len(data)!=n:raise IOError('Incomplete ZIP range')
  self.pos+=len(data);return data
 def cache_frames(self,infos,name):
  start=min(v.header_offset for v in infos);end=max(v.header_offset+30+len(v.filename.encode())+len(v.extra)+v.compress_size+1024 for v in infos)
  target=OUT/f'{name}.range'; print(f'Downloading {name}: {(end-start)/1e6:.1f} MB selected ZIP span',flush=True)
  with self.response(start,end-1) as r,target.open('wb') as f:
   copied=0;last=0
   while b:=r.read(1024*1024):
    f.write(b);copied+=len(b)
    if copied-last>32*1024*1024:print(f'{name}: {copied/1e6:.0f} MB',flush=True);last=copied
  if copied!=end-start:raise IOError('Incomplete download')
  self.cache=(start,end,target)
OUT.mkdir(parents=True,exist_ok=True)
for archive,prefix,directory,extension in [('data_tracking_image_2.zip','training/image_02/0011/','images','.png'),('data_tracking_velodyne.zip','training/velodyne/0011/','velodyne','.bin')]:
 dest=OUT/directory;dest.mkdir(exist_ok=True)
 if all((dest/f'{i:06d}{extension}').exists() for i in range(200)):print(f'{directory}: cache ready',flush=True);continue
 remote=Remote(BASE+archive)
 with zipfile.ZipFile(remote) as z:
  infos=[z.getinfo(f'{prefix}{i:06d}{extension}') for i in range(200)]
  remote.cache_frames(infos,directory)
  for info in infos:(dest/pathlib.Path(info.filename).name).write_bytes(z.read(info))
 print(f'{directory}: verified ZIP CRC, 200 frames extracted',flush=True)
for archive,prefix,directory in [('data_tracking_oxts.zip','training/oxts/','oxts'),('data_tracking_calib.zip','training/calib/','calib'),('data_tracking_label_2.zip','training/label_02/','labels')]:
 dest=OUT/directory;dest.mkdir(exist_ok=True);target=dest/'0011.txt'
 if target.exists():continue
 with urllib.request.urlopen(BASE+archive,timeout=90) as r:body=r.read()
 with zipfile.ZipFile(io.BytesIO(body)) as z:target.write_bytes(z.read(prefix+'0011.txt'))
print('Official tracking 0011 source complete',flush=True)

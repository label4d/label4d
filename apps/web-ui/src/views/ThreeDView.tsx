import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  AttributeBadgeRenderer,
  createCloudShaderMaterial,
  PointCloudFrameView,
  TrackInstanceRenderer,
  WorldCloudOverlay,
  vec3,
} from '@labelfaster/core';
import { useSession } from '../session/SessionProvider';

/** Perspective 3D view: streaming point cloud + instanced track boxes + badges. */
export function ThreeDView() {
  const session = useSession();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(false);
  const [potree, setPotree] = useState(true); // 默认开启拼接点云

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e13);
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const dir = new THREE.DirectionalLight(0xffffff, 0.9);
    dir.position.set(30, 60, 20);
    scene.add(dir);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 2000);
    camera.position.set(18, 22, 26);
    const controls = new OrbitControls(camera, canvas);
    controls.target.set(0, 0, 0);
    controls.enableDamping = true;
    controls.dampingFactor = 0.12;
    // 禁止相机钻到地面以下（否则看到"地面朝上"的倒立场景），侧看时保持俯视角
    controls.minPolarAngle = 0.05;
    controls.maxPolarAngle = Math.PI / 2 - 0.08;

    const cloudView = new PointCloudFrameView();
    scene.add(cloudView.group);

    // ---- 自车轨迹：连接线 + 每帧可点击定位标记（当前帧高亮）----
    const egoGroup = new THREE.Group();
    scene.add(egoGroup);
    const egoLineMat = new THREE.LineBasicMaterial({ color: 0x3ddc97 });
    const egoMarkerMat = new THREE.MeshBasicMaterial({ color: 0x2ea87e });
    const egoMarkerHotMat = new THREE.MeshBasicMaterial({ color: 0x4dffce }); // 当前帧高亮
    const markerGeo = new THREE.SphereGeometry(0.45, 12, 10);
    const egoMarkers: THREE.Mesh[] = [];
    let egoMarkersBuilt = false;
    let lastEgoFrame = -1;
    const buildEgoTrajectory = () => {
      if (egoMarkersBuilt) return;
      const n = session.ego.count;
      if (n < 2) return;
      const linePts: THREE.Vector3[] = [];
      for (let f = 0; f < n; f++) {
        const p = session.ego.positionAt(f);
        linePts.push(new THREE.Vector3(p.x, p.y + 0.05, p.z));
        const m = new THREE.Mesh(markerGeo, egoMarkerMat);
        m.position.set(p.x, p.y + 0.05, p.z);
        m.userData.frame = f; // 点击时按帧跳
        egoGroup.add(m);
        egoMarkers.push(m);
      }
      const lineGeo = new THREE.BufferGeometry().setFromPoints(linePts);
      egoGroup.add(new THREE.Line(lineGeo, egoLineMat));
      egoMarkersBuilt = true;
    };
    buildEgoTrajectory();
    const offEgo = session.events.on('manifestLoaded', buildEgoTrajectory);
    // 全局拼接点云（4D 序列静态环境）流式加载
    // manifest 异步到达：挂载时可能未就绪，manifestLoaded 事件补初始化
    let overlay: WorldCloudOverlay | null = null;
    let disposed = false;
    const ensureWorldOverlay = () => {
      const manifest = session.manifest as { worldCloud?: { indexUrl: string } } | null;
      if (overlay || !manifest?.worldCloud) return;
      overlay = new WorldCloudOverlay((url) =>
        fetch(url).then((r) => r.arrayBuffer())
      );
      scene.add(overlay.group);
      void overlay.load(manifest.worldCloud.indexUrl).then(() => { if (!disposed && overlay) overlay.enabled = true; });
    };
    ensureWorldOverlay();
    const offOverlay = session.events.on('manifestLoaded', ensureWorldOverlay);
    const instance = new TrackInstanceRenderer(session.store, session.selection, session.labels);
    scene.add(instance.group);
    const badges = new AttributeBadgeRenderer(session.labels);
    scene.add(badges.group);

    const ndc = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();

    type PickResult = { egoFrame: number } | { id: string } | null;
    const pickAt = (e: PointerEvent): PickResult => {
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      // 自车轨迹标记优先于标注框（定位导航优先）
      const egoHit = raycaster.intersectObjects(egoMarkers, false)[0];
      if (egoHit) return { egoFrame: egoHit.object.userData.frame as number };
      const badgeHit = badges.pick(raycaster);
      if (badgeHit) return { id: badgeHit };
      const hit = session.pickTrackByRay(
        { x: raycaster.ray.origin.x, y: raycaster.ray.origin.y, z: raycaster.ray.origin.z },
        { x: raycaster.ray.direction.x, y: raycaster.ray.direction.y, z: raycaster.ray.direction.z },
        session.frame
      );
      return hit ? { id: hit.id } : null;
    };

    let downAt: { x: number; y: number } | null = null;
    const onPointerDown = (e: PointerEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y);
      downAt = null;
      if (moved > 4 || e.button !== 0) return;
      const hit = pickAt(e);
      if (hit && 'egoFrame' in hit) {
        // 点击自车轨迹标记：跳转到对应帧
        session.setFrame(hit.egoFrame);
        return;
      }
      const id = hit && 'id' in hit ? hit.id : null;
      if (id) session.selection.select([id], e.shiftKey ? 'toggle' : 'replace');
      else if (!e.shiftKey) session.selection.clear();
    };
    const onPointerMove = (e: PointerEvent) => {
      if (e.buttons !== 0) return;
      const hit = pickAt(e);
      // 悬停在轨迹标记上显示手型；标注框照常高亮
      canvas.style.cursor = hit && 'egoFrame' in hit ? 'pointer' : '';
      session.setHover(hit && 'id' in hit ? hit.id : null);
    };
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointermove', onPointerMove);

    const onBadgeToggle = (e: Event) => badges.setOptions({ showAll: Boolean((e as CustomEvent).detail) });
    window.addEventListener('lf:badges', onBadgeToggle);

    // Potree 静态八叉树 overlay：按视点流式调度，节点级 LRU 驻留
    const potreeGroup = new THREE.Group();
    potreeGroup.visible = true; // 默认显示，复选框控制开关
    scene.add(potreeGroup);
    const potreeMaterial = createCloudShaderMaterial({
      mode: 0,               // 高度着色（源数据强度全 0，不可用）
      range: [-3, 10],       // 全局统一色域，避免分块边界
      pointSize: 0.12,
    });
    const potreeChunks = new Map<string, { points: THREE.Points; lastUse: number }>();
    let potreeEnabled = true; // 默认开启，复选框控制开关
    let potreeTick = 0;
    const disposeChunk = (points: THREE.Points) => {
      potreeGroup.remove(points);
      points.geometry.dispose();
    };
    const onPotreeToggle = (e: Event) => {
      potreeEnabled = Boolean((e as CustomEvent).detail);
      potreeGroup.visible = potreeEnabled;
      if (!potreeEnabled) {
        for (const { points } of potreeChunks.values()) disposeChunk(points);
        potreeChunks.clear();
      }
    };
    window.addEventListener('lf:potree', onPotreeToggle);

    let followEnabled = follow;
    const onFollow = (e: Event) => {
      followEnabled = Boolean((e as CustomEvent).detail);
    };
    window.addEventListener('lf:follow', onFollow);

    // re-center on the ego vehicle once a manifest is loaded
    const recenter = () => {
      const ego = session.ego.positionAt(session.frame);
      controls.target.set(ego.x, 0, ego.z);
      camera.position.set(ego.x + 30, ego.y + 35, ego.z + 30);
      controls.update();
    };
    recenter();
    const offManifest = session.events.on('manifestLoaded', recenter);

    let rafId = 0;
    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    let lastCloud: unknown = null;
    const renderLoop = () => {
      const frame = session.frame;
      const cloud = session.currentPointCloud();
      if (cloud !== lastCloud) {
        lastCloud = cloud;
        cloudView.setFrame(cloud, frame);
      }
      const moveDelta = session.tools.movePreviewDelta();
      const rotateDelta = session.tools.rotatePreviewDelta();
      const previewIds = new Set(session.selection.all());
      instance.setPreview(
        moveDelta
          ? { ids: previewIds, delta: moveDelta }
          : rotateDelta
            ? { ids: previewIds, delta: vec3(), pivot: rotateDelta.pivot, dyaw: rotateDelta.dyaw }
            : null
      );
      const velocityIds = new Set(session.selection.all());
      if (session.hover) velocityIds.add(session.hover);
      instance.setFilter({
        hiddenLabels: session.hiddenLabels,
        blinkLabel: session.blinkLabel,
        blinkOn: session.blinkOn,
        velocityIds,
      });
      instance.fps = session.playhead.fps;
      instance.sync(frame, session.hover);
      badges.sync(frame, session.store, session.selection, session.hover);
      // 当前帧轨迹标记高亮
      if (frame !== lastEgoFrame && egoMarkers.length) {
        if (egoMarkers[lastEgoFrame]) egoMarkers[lastEgoFrame].material = egoMarkerMat;
        if (egoMarkers[frame]) egoMarkers[frame].material = egoMarkerHotMat;
        lastEgoFrame = frame;
      }

      // Potree overlay：按相机位置+距离分级加载，保证整条轨迹都有可见覆盖
      if (potreeEnabled && session.potree && potreeTick++ % 12 === 0) {
        const camPos = camera.position;
        for (const { name, done } of session.potree.requestView({ x: camPos.x, y: camPos.y, z: camPos.z }, 160)) {
          const cached = potreeChunks.get(name);
          if (cached) {
            cached.lastUse = potreeTick;
            continue;
          }
          void done.then((chunk) => {
            if (disposed || !potreeEnabled || !chunk.count || potreeChunks.has(name)) return;
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(chunk.positions, 3));
            const points = new THREE.Points(geometry, potreeMaterial);
            potreeGroup.add(points);
            potreeChunks.set(name, { points, lastUse: potreeTick });
          });
        }
        // 超出驻留上限时驱逐最久未用节点（给足余量，避免远端节点被立即驱逐）
        const MAX_NODES = 200;
        if (potreeChunks.size > MAX_NODES) {
          const lru = [...potreeChunks.entries()].sort((a, b) => a[1].lastUse - b[1].lastUse);
          for (let k = 0; k < potreeChunks.size - MAX_NODES; k++) {
            const [name, { points }] = lru[k];
            disposeChunk(points);
            potreeChunks.delete(name);
          }
        }
      }

      // 拼接环境点云：无论是否跟随，都按当前视点节流加载附近分块
      if (potreeTick % 20 === 0) {
        void overlay?.ensureAround(controls.target.x, controls.target.z, 130);
      }
      if (followEnabled) {
        const ego = session.ego.positionAt(frame);
        controls.target.set(ego.x, 0, ego.z);
      }
      controls.update();
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('lf:badges', onBadgeToggle);
      window.removeEventListener('lf:potree', onPotreeToggle);
      window.removeEventListener('lf:follow', onFollow);
      offManifest();
      offEgo();
      offOverlay();
      disposed = true;
      controls.dispose();
      cloudView.dispose();
      if (overlay) overlay.dispose();
      for (const { points } of potreeChunks.values()) disposeChunk(points);
      potreeChunks.clear();
      potreeMaterial.dispose();
      markerGeo.dispose();
      egoLineMat.dispose();
      egoMarkerMat.dispose();
      egoMarkerHotMat.dispose();
      instance.dispose();
      badges.dispose();
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <label className="absolute right-2 top-2 flex items-center gap-1 rounded bg-black/50 px-2 py-1 text-[10px] text-slate-200">
        <input
          type="checkbox"
          checked={follow}
          onChange={(e) => {
            setFollow(e.target.checked);
            window.dispatchEvent(new CustomEvent('lf:follow', { detail: e.target.checked }));
          }}
        />
        跟随自车
      </label>
      <label className="absolute right-2 top-8 flex items-center gap-1 rounded bg-black/50 px-2 py-1 text-[10px] text-slate-200">
        <input
          type="checkbox"
          checked={potree}
          onChange={(e) => {
            setPotree(e.target.checked);
            window.dispatchEvent(new CustomEvent('lf:potree', { detail: e.target.checked }));
          }}
        />
        静态点云(Potree)
      </label>
    </div>
  );
}

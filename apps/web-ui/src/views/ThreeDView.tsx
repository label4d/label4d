import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { SlidersHorizontal } from 'lucide-react';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import {
  AttributeBadgeRenderer,
  createCloudShaderMaterial,
  CLOUD_POINT_SIZE,
  EgoCameraFollow,
  stablePointOrder,
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
  const [density, setDensity] = useState(2);
  const densityRef = useRef(2);
  const [pointSize, setPointSize] = useState(CLOUD_POINT_SIZE);
  const pointSizeRef = useRef(CLOUD_POINT_SIZE);
  const [potreePoints, setPotreePoints] = useState(0);
  const [potree, setPotree] = useState(true); // 默认开启拼接点云

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    setPotreePoints(0);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0c141c);
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
    const potreeDebug = {
      setLayerMode: (m: string) => { dbgRef.current.layerMode = m as typeof dbgLayerMode; dbgLayerMode = m as typeof dbgLayerMode; },
      setNodeColor: (v: boolean) => { dbgRef.current.nodeColor = v; },
      setShowBounds: (v: boolean) => { dbgRef.current.showBounds = v; boundsGroup.visible = v; },
      getStats: () => ({ loaded: potreeChunks.size, pending: pendingNodes.size,
        selected: desired.size, pointBudget: selectedBudget,
        drawn: [...potreeChunks.values()].reduce((sum, e) => sum + (e.points.visible ? e.points.geometry.drawRange.count : 0), 0),
        nodes: [...potreeChunks.keys()], camera: camera.position.toArray(),
        visibleNodes: [...potreeChunks].filter(([, e]) => e.points.visible).map(([name]) => name),
        selectedNodes: [...desired.keys()],
        gpuBytes: [...potreeChunks.values()].reduce((sum, e) => sum + e.bytes, 0),
      }),
      setFixedPixel: (v: boolean) => { dbgRef.current.fixedPixel = v; },
      setSampleRatio: (v: number) => { dbgRef.current.sampleRatio = v; },
      setCloudVisible: (v: boolean) => { cloudView.group.visible = v; },
      setAnnotationsVisible: (v: boolean) => { instance.group.visible = v; },
      setEgoVisible: (v: boolean) => { egoGroup.visible = v; },
    };
    if (import.meta.env.DEV) (window as unknown as { __lfPotreeDebug?: unknown }).__lfPotreeDebug = potreeDebug;
    const ensureWorldOverlay = () => {
      const manifest = session.manifest as { worldCloud?: { indexUrl: string } } | null;
      if (overlay || !manifest?.worldCloud) return;
      overlay = new WorldCloudOverlay(async (url, signal) => {
        const response = await fetch(url, { signal });
        if (!response.ok) throw new Error(`World cloud HTTP ${response.status}`);
        return response.arrayBuffer();
      }, session.scheduler);
      scene.add(overlay.group);
      void overlay.load(manifest.worldCloud.indexUrl).then(() => { if (!disposed && overlay) overlay.enabled = true; }).catch((error) => { if (!disposed) session.events.emit('error', { message: String(error) }); });
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
      // 右键/中键交给 OrbitControls 平移/缩放，不进入点击选择判定
      if (e.button !== 0) return;
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
    // 调试：层级对照与节点可视化
    const dbgRef = { current: { layerMode: 'all' as 'all' | 'coarse' | 'detail', nodeColor: false, showBounds: false, fixedPixel: true, sampleRatio: 1 } };
    let dbgLayerMode: 'all' | 'coarse' | 'detail' = 'all'; // all=全显示, coarse=只level≤2, detail=只细节
    dbgRef.current = { layerMode: 'all', nodeColor: false, showBounds: false, fixedPixel: true, sampleRatio: 1 };
    const boundsGroup = new THREE.Group();
    boundsGroup.visible = false;
    scene.add(boundsGroup);
    const nodeColors = new Map<string, THREE.Color>();
    const randomNodeColor = (name: string) => {
      let c = nodeColors.get(name);
      if (!c) {
        c = new THREE.Color().setHSL(([...name].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0) % 360) / 360, 0.7, 0.55);
        nodeColors.set(name, c);
      }
      return c;
    };

    const potreeMaterial = createCloudShaderMaterial({
      mode: 0, range: [-2, 4], pointSize: CLOUD_POINT_SIZE, fixedPixels: true,
      lowColor: '#2a2d33', highColor: '#e8e8e8',
    });
    const potreeChunks = new Map<string, { points: THREE.Points; lastUse: number; bytes: number }>();
    const pendingNodes = new Set<string>();
    let desired = new Map<string, number>();
    let lastSelection = new Set<string>();
    let selectedBudget = 0;
    let potreeEnabled = true; // 默认开启，复选框控制开关
    let potreeTick = 0;
    const disposeChunk = (points: THREE.Points) => {
      potreeGroup.remove(points);
      points.geometry.dispose();
      const helper = points.userData.boundsHelper as THREE.Box3Helper | undefined;
      if (helper) { boundsGroup.remove(helper); helper.geometry.dispose(); (helper.material as THREE.Material).dispose(); }
      if (points.material !== potreeMaterial) (points.material as THREE.Material).dispose();
    };
    const onPotreeToggle = (e: Event) => {
      potreeEnabled = Boolean((e as CustomEvent).detail);
      potreeGroup.visible = potreeEnabled;
      if (!potreeEnabled) {
        desired.clear();
        lastSelection.clear();
        for (const { points } of potreeChunks.values()) disposeChunk(points);
        potreeChunks.clear();
      }
    };
    window.addEventListener('lf:potree', onPotreeToggle);

    let followEnabled = follow;
    controls.enableDamping = !followEnabled;
    let orbiting = false;
    const cameraFollow = new EgoCameraFollow();
    const captureFollow = () => cameraFollow.capture(session.ego.poseAt(session.frame), camera, controls.target);
    const onOrbitStart = () => { orbiting = true; };
    const onOrbitChange = () => { if (followEnabled && orbiting) captureFollow(); };
    const onOrbitEnd = () => { if (followEnabled) captureFollow(); orbiting = false; };
    controls.addEventListener('start', onOrbitStart);
    controls.addEventListener('change', onOrbitChange);
    controls.addEventListener('end', onOrbitEnd);
    const onFollow = (e: Event) => {
      followEnabled = Boolean((e as CustomEvent).detail);
      // Damping would continue changing the relative pose after the user releases the mouse.
      controls.enableDamping = !followEnabled;
      controls.update();
      if (followEnabled) captureFollow();
      else camera.up.set(0, 1, 0);
    };
    window.addEventListener('lf:follow', onFollow);

    // re-center on the ego vehicle once a manifest is loaded
    const recenter = () => {
      const ego = session.ego.positionAt(session.frame);
      controls.target.set(ego.x, 0, ego.z);
      camera.position.set(ego.x + 30, ego.y + 35, ego.z + 30);
      controls.update();
      if (followEnabled) captureFollow();
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

      // Camera-space LOD selection; cached nodes are not automatically visible.
      if (followEnabled) {
        cameraFollow.apply(session.ego.poseAt(frame), camera, controls.target);
        if (orbiting) controls.update();
      } else {
        controls.update();
      }
      if (import.meta.env.MODE === 'test') {
        wrap.dataset.camera = JSON.stringify({ frame, position: camera.position.toArray(), quaternion: camera.quaternion.toArray(), target: controls.target.toArray() });
      }
      if (potreeEnabled && session.potree && potreeTick++ % 6 === 0) {
        const source = session.potree;
        const targetSpacingPixels = 3 / densityRef.current;
        selectedBudget = Math.min(480_000, Math.floor(
          wrap.clientWidth * wrap.clientHeight / (targetSpacingPixels * targetSpacingPixels)
        ));
        const plan = source.selectView({ camera, viewportWidth: wrap.clientWidth,
          viewportHeight: wrap.clientHeight, pointBudget: selectedBudget, targetSpacingPixels, previous: lastSelection });
        lastSelection = new Set(plan.map(p => p.node.name));
        desired = new Map(plan.map(p => [p.node.name, p.drawCount]));
        for (const [name, entry] of potreeChunks) {
          entry.points.visible = desired.has(name);
          if (desired.has(name)) entry.lastUse = potreeTick;
        }
        for (const { node, priority } of plan) {
          const name = node.name;
          if (potreeChunks.has(name) || pendingNodes.has(name) || !node.numPoints) continue;
          // Additive hierarchy: show/load ancestors before their details.
          const parent = source.nodes.get(name.slice(0, -1));
          if (parent?.numPoints && !potreeChunks.has(parent.name)) continue;
          if (pendingNodes.size >= 12) break;
          pendingNodes.add(name);
          void source.requestNode(node, priority).then(chunk => {
            if (disposed || !potreeEnabled || session.potree !== source ||
              !desired.has(name) || !chunk.count || potreeChunks.has(name)) return;
            const positions = stablePointOrder(chunk.positions, name);
            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            geometry.setDrawRange(0, 0);
            const points = new THREE.Points(geometry, potreeMaterial);
            points.userData.level = node.level;
            points.userData.nodeName = name;
            potreeGroup.add(points);
            potreeChunks.set(name, { points, lastUse: potreeTick, bytes: positions.byteLength });
          }).catch(() => undefined).finally(() => pendingNodes.delete(name));
        }
        // GPU cache has a byte budget. Only inactive nodes can be evicted.
        let residentBytes = [...potreeChunks.values()].reduce((sum, e) => sum + e.bytes, 0);
        const inactive = [...potreeChunks].filter(([name]) => !desired.has(name))
          .sort((a, b) => a[1].lastUse - b[1].lastUse);
        for (const [name, entry] of inactive) {
          if (residentBytes <= 128 * 1024 * 1024 && potreeChunks.size <= 256) break;
          disposeChunk(entry.points);
          residentBytes -= entry.bytes;
          potreeChunks.delete(name);
        }
      }
      cloudView.setPointSize(pointSizeRef.current);
      potreeMaterial.uniforms.uFixedPixels.value = dbgRef.current.fixedPixel;
      potreeMaterial.uniforms.uPointSize.value = dbgRef.current.fixedPixel ? pointSizeRef.current : 0.12;
      boundsGroup.visible = dbgRef.current.showBounds;
      for (const [name, entry] of potreeChunks) {
        const points = entry.points;
        const level = points.userData.level as number;
        const layerVisible = dbgRef.current.layerMode === 'all' ||
          (dbgRef.current.layerMode === 'coarse' ? level <= 2 : level > 2);
        const parentName = name.slice(0, -1);
        const parentReady = name === 'r' || !session.potree?.nodes.get(parentName)?.numPoints || potreeChunks.has(parentName);
        points.visible = potreeEnabled && desired.has(name) && layerVisible && parentReady;
        const target = Math.floor((desired.get(name) ?? 0) * Math.max(0, Math.min(1, dbgRef.current.sampleRatio)));
        // Nested samples grow gradually; reductions immediately respect budget.
        points.geometry.setDrawRange(0, Math.min(target,
          points.geometry.drawRange.count + Math.max(1, Math.ceil(target / 12))));
        if (dbgRef.current.nodeColor && points.material === potreeMaterial) {
          const color = `#${randomNodeColor(name).getHexString()}`;
          points.material = createCloudShaderMaterial({ lowColor: color, highColor: color });
        } else if (!dbgRef.current.nodeColor && points.material !== potreeMaterial) {
          (points.material as THREE.Material).dispose(); points.material = potreeMaterial;
        }
        if (points.material !== potreeMaterial) {
          const material = points.material as THREE.ShaderMaterial;
          material.uniforms.uPointSize.value = potreeMaterial.uniforms.uPointSize.value;
          material.uniforms.uFixedPixels.value = potreeMaterial.uniforms.uFixedPixels.value;
        }
        if (dbgRef.current.showBounds && !points.userData.boundsHelper) {
          const node = session.potree?.nodes.get(name);
          if (node) {
            const helper = new THREE.Box3Helper(new THREE.Box3(
              new THREE.Vector3(node.boxMin.x, node.boxMin.y, node.boxMin.z),
              new THREE.Vector3(node.boxMax.x, node.boxMax.y, node.boxMax.z)), 0xffff00);
            points.userData.boundsHelper = helper; boundsGroup.add(helper);
          }
        }
        if (points.userData.boundsHelper) points.userData.boundsHelper.visible = points.visible;
      }

      // 拼接环境点云：无论是否跟随，都按当前视点节流加载附近分块
      if (potreeTick % 20 === 0) {
        void overlay?.ensureAround(controls.target.x, controls.target.z, 130);
      }
      if (potreeTick % 20 === 0) {
        const count = [...potreeChunks.values()].reduce((sum, e) => sum + (e.points.visible ? e.points.geometry.drawRange.count : 0), 0);
        setPotreePoints((old) => old === count ? old : count);
      }
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
      controls.removeEventListener('start', onOrbitStart);
      controls.removeEventListener('change', onOrbitChange);
      controls.removeEventListener('end', onOrbitEnd);
      offManifest();
      offEgo();
      offOverlay();
      disposed = true;
      const debugWindow = window as unknown as { __lfPotreeDebug?: unknown };
      if (debugWindow.__lfPotreeDebug === potreeDebug) delete debugWindow.__lfPotreeDebug;
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
  }, [session, session.manifest]);

  return (
    <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden" data-testid="cloud-view">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <details className="cloud-view-settings"><summary><SlidersHorizontal size={13} />点云显示</summary><div className="cloud-settings-content">
      <label>
        点云密度
        <input
          type="range"
          aria-label="点云密度"
          min="1" max="3" step="0.1"
          value={density}
          className="w-20"
          onChange={(e) => {
            const value = Number(e.target.value);
            densityRef.current = value;
            setDensity(value);
          }}
        />
      </label>
      <label>
        点大小
        <input
          type="range"
          aria-label="点大小"
          min="1" max="6" step="0.25"
          value={pointSize}
          className="w-20"
          onChange={(e) => {
            const value = Number(e.target.value);
            pointSizeRef.current = value;
            setPointSize(value);
          }}
        />
        <output className="w-12 text-right tabular-nums">{pointSize.toFixed(2)} px</output>
      </label>
      <label>
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
      <label>
        <input
          type="checkbox"
          checked={Boolean(session.manifest?.potree) && potree}
          disabled={!session.manifest?.potree}
          onChange={(e) => {
            setPotree(e.target.checked);
            window.dispatchEvent(new CustomEvent('lf:potree', { detail: e.target.checked }));
          }}
        />
        静态点云(Potree)
      </label>
      <span role="status" aria-label="Potree 加载状态">{!session.manifest?.potree ? '未配置 Potree' : !potree ? 'Potree 已关闭' : potreePoints ? `Potree 已显示 ${potreePoints.toLocaleString()} 点` : 'Potree 加载中…'}</span>
      <span className="text-slate-400">动态点云：当前帧 · 绿色路径：自车轨迹</span>
      </div></details>
    </div>
  );
}

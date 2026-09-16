import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  AttributeBadgeRenderer,
  BevTileRenderer,
  ToolMachine,
  TrackInstanceRenderer,
  makeDynamicLines,
  rayGround,
  rayOBB,
  vec3,
} from '@labelfaster/core';
import type { ToolContext } from '@labelfaster/core';
import { useSession } from '../session/SessionProvider';
import { demoFetchImage } from '../lib/demo';

function loadImage(url: string): Promise<ImageBitmap | HTMLImageElement> {
  if (url.startsWith('demo://')) return demoFetchImage(url);
  return fetch(url)
    .then((r) => r.blob())
    .then((blob) => createImageBitmap(blob, { imageOrientation: 'flipY' }));
}

/** Ground-plane orthographic view: BEV tiles, drawing tools, ego trajectory. */
export function BevView() {
  const session = useSession();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b0e13);
    scene.add(new THREE.AmbientLight(0xffffff, 0.9));
    const bevDir = new THREE.DirectionalLight(0xffffff, 0.5);
    bevDir.position.set(0, 100, 0);
    scene.add(bevDir);
    const camera = new THREE.OrthographicCamera(-40, 40, 40, -40, 0.1, 2000);
    const view = { cx: 0, cz: 4, halfExtent: 40 };

    const applyCamera = () => {
      const aspect = wrap.clientWidth / Math.max(1, wrap.clientHeight);
      const halfExtentY = view.halfExtent;
      camera.left = -halfExtentY * aspect;
      camera.right = halfExtentY * aspect;
      camera.top = halfExtentY;
      camera.bottom = -halfExtentY;
      camera.position.set(view.cx, 200, view.cz);
      camera.up.set(0, 0, -1);
      camera.lookAt(view.cx, 0, view.cz);
      camera.updateProjectionMatrix();
    };

    const instance = new TrackInstanceRenderer(session.store, session.selection, session.labels);
    scene.add(instance.group);
    const badges = new AttributeBadgeRenderer(session.labels);
    scene.add(badges.group);

    let bevTiles: BevTileRenderer | null = null;
    const ensureTiles = () => {
      if (bevTiles || !session.bevPyramid) return;
      bevTiles = new BevTileRenderer(session.bevPyramid, session.scheduler, loadImage);
      scene.add(bevTiles.group);
      session.registerEvictHandler('bev:', (id, resource) => bevTiles?.evictResource(id, resource));
      void bevTiles.loadOverview();
    };
    ensureTiles();
    const offTiles = session.events.on('manifestLoaded', ensureTiles);

    // ---- ego trajectory (clickable per-frame dots) ----
    const egoLine = makeDynamicLines(16384, { color: 0x3ddc97, opacity: 0.9 });
    scene.add(egoLine.object);
    let egoDots: THREE.Points | null = null;
    const rebuildEgo = () => {
      const n = session.ego.count;
      const segmentBuf = new Float32Array(Math.max((n - 1) * 6, 6));
      const dotPositions = new Float32Array(n * 3);
      for (let f = 0; f < n; f++) {
        const p = session.ego.positionAt(f);
        dotPositions[f * 3] = p.x;
        dotPositions[f * 3 + 1] = 0.06;
        dotPositions[f * 3 + 2] = p.z;
        if (f < n - 1) {
          segmentBuf[f * 6] = p.x;
          segmentBuf[f * 6 + 1] = 0.06;
          segmentBuf[f * 6 + 2] = p.z;
          const q = session.ego.positionAt(f + 1);
          segmentBuf[f * 6 + 3] = q.x;
          segmentBuf[f * 6 + 4] = 0.06;
          segmentBuf[f * 6 + 5] = q.z;
        }
      }
      egoLine.update(segmentBuf, Math.max((n - 1) * 2, 0));
      if (egoDots) {
        scene.remove(egoDots);
        egoDots.geometry.dispose();
        (egoDots.material as THREE.Material).dispose();
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(dotPositions, 3));
      egoDots = new THREE.Points(
        geometry,
        new THREE.PointsMaterial({ size: 0.45, color: 0x3ddc97, sizeAttenuation: true })
      );
      scene.add(egoDots);
    };
    rebuildEgo();
    const offManifest = session.events.on('manifestLoaded', rebuildEgo);

    // center the ground view on the ego vehicle when a manifest arrives
    const centerOnEgo = () => {
      const ego = session.ego.positionAt(session.frame);
      view.cx = ego.x;
      view.cz = ego.z;
      view.halfExtent = 60;
      applyCamera();
    };
    centerOnEgo();
    const offManifestCenter = session.events.on('manifestLoaded', centerOnEgo);

    const previewLines = makeDynamicLines(2048, { color: 0x2b6cff, depthTest: false, dashed: true, dashSize: 0.8, gapSize: 0.5 });
    scene.add(previewLines.object);
    const marqueeDiv = document.createElement('div');
    marqueeDiv.style.cssText =
      'position:absolute;border:1px dashed #2b6cff;background:rgba(43,108,255,0.08);pointer-events:none;display:none;';
    wrap.appendChild(marqueeDiv);

    // hover tooltip (id / class / keyframe state)
    const tooltipDiv = document.createElement('div');
    tooltipDiv.style.cssText =
      'position:absolute;pointer-events:none;display:none;background:rgba(8,12,18,0.85);border:1px solid #2b3b52;color:#d7e3f4;font:11px system-ui;padding:3px 7px;border-radius:4px;z-index:30;white-space:nowrap;';
    wrap.appendChild(tooltipDiv);

    // measurement HUD (value of the last measurement)
    const measureDiv = document.createElement('div');
    measureDiv.style.cssText =
      'position:absolute;left:10px;bottom:8px;display:none;background:rgba(8,12,18,0.85);border:1px solid #3ddc97;color:#3ddc97;font:12px system-ui;padding:4px 9px;border-radius:4px;z-index:30;';
    wrap.appendChild(measureDiv);
    const offMeasurement = session.events.on('measurement', (m) => {
      if (!m) {
        measureDiv.style.display = 'none';
        return;
      }
      const unit = m.kind === 'angle' ? '°' : 'm';
      const name = m.kind === 'distance' ? '距离' : m.kind === 'height' ? '高度差' : '角度';
      measureDiv.textContent = `${name}: ${m.value.toFixed(2)}${unit}`;
      measureDiv.style.display = 'block';
    });

    // right-click context menu on an object
    const menuDiv = document.createElement('div');
    menuDiv.style.cssText =
      'position:absolute;display:none;background:#10161f;border:1px solid #2b3b52;border-radius:6px;padding:4px;z-index:40;min-width:140px;box-shadow:0 8px 24px rgba(0,0,0,0.5);';
    wrap.appendChild(menuDiv);
    const hideMenu = () => {
      menuDiv.style.display = 'none';
    };
    const menuItem = (text: string, action: () => void) => {
      const item = document.createElement('div');
      item.textContent = text;
      item.style.cssText = 'padding:5px 10px;font:12px system-ui;color:#d7e3f4;border-radius:4px;cursor:pointer;';
      item.addEventListener('mouseenter', () => (item.style.background = '#1d2530'));
      item.addEventListener('mouseleave', () => (item.style.background = 'transparent'));
      item.addEventListener('click', () => {
        action();
        hideMenu();
      });
      menuDiv.appendChild(item);
      return item;
    };

    // ---- picking / gestures ----
    const ndc = new THREE.Vector2();
    const raycaster = new THREE.Raycaster();
    const toGesture = (e: PointerEvent | MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      ndc.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      ndc.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(ndc, camera);
      const ground = rayGround(raycaster.ray.origin, raycaster.ray.direction, 0);
      return {
        world: ground ?? vec3(),
        screen: { x: e.clientX - rect.left, y: e.clientY - rect.top },
        rayOrigin: raycaster.ray.origin.clone(),
        rayDir: raycaster.ray.direction.clone(),
      };
    };

    const buildContext = (world: { x: number; y: number; z: number }, rayOrigin: THREE.Vector3, rayDir: THREE.Vector3, e: PointerEvent | MouseEvent): ToolContext => {
      const hit = session.pickTrackByRay(
        { x: rayOrigin.x, y: rayOrigin.y, z: rayOrigin.z },
        { x: rayDir.x, y: rayDir.y, z: rayDir.z },
        session.frame
      );
      let pickedId = hit?.id ?? null;
      if (!pickedId) pickedId = session.pickGeometryAtWorld(world, Math.max(0.6, view.halfExtent * 0.02));

      let vertexHit: { id: string; index: number } | null = null;
      if (session.tools.activeTool === 'vertexEdit' || e.altKey) {
        for (const geom of session.store.geometriesAt(session.frame)) {
          const index = ToolMachine.vertexNear(world, geom.vertices, Math.max(0.5, view.halfExtent * 0.02));
          if (index !== null) {
            vertexHit = { id: geom.meta.id, index };
            break;
          }
        }
      }

      let rotateHandleHit: { id: string; pivot: { x: number; y: number; z: number } } | null = null;
      if (e.shiftKey && pickedId && session.selection.has(pickedId)) {
        const state = session.store.resolveState(pickedId, session.frame);
        if (state) rotateHandleHit = { id: pickedId, pivot: state.pos };
      }
      return { pickedId, vertexHit, rotateHandleHit, selection: session.selection.all() };
    };

    session.rectPicker = (rect) => {
      const rect2 = canvas.getBoundingClientRect();
      const aspect = rect2.width / Math.max(1, rect2.height);
      const wppX = (2 * view.halfExtent * aspect) / rect2.width;
      const wppY = (2 * view.halfExtent) / rect2.height;
      const minX = view.cx + (rect.x0 - rect2.width / 2) * wppX;
      const maxX = view.cx + (rect.x1 - rect2.width / 2) * wppX;
      // screen up = -Z
      const minZ = view.cz - (rect.y1 - rect2.height / 2) * wppY;
      const maxZ = view.cz - (rect.y0 - rect2.height / 2) * wppY;
      const ids: string[] = [];
      for (const id of session.store.activeTrackIds(session.frame)) {
        const state = session.store.resolveState(id, session.frame);
        if (state && state.pos.x >= minX && state.pos.x <= maxX && state.pos.z >= minZ && state.pos.z <= maxZ) ids.push(id);
      }
      for (const geom of session.store.geometriesAt(session.frame)) {
        for (let i = 0; i * 3 < geom.vertices.length; i++) {
          const x = geom.vertices[i * 3];
          const z = geom.vertices[i * 3 + 2];
          if (x >= minX && x <= maxX && z >= minZ && z <= maxZ) {
            ids.push(geom.meta.id);
            break;
          }
        }
      }
      return ids;
    };

    let panLast: { x: number; y: number } | null = null;

    const onPointerDown = (e: PointerEvent) => {
      canvas.setPointerCapture(e.pointerId);
      if (e.button === 1) {
        panLast = { x: e.clientX, y: e.clientY };
        return;
      }
      if (e.button !== 0) return;
      const g = toGesture(e);
      const ctx = buildContext(g.world, g.rayOrigin, g.rayDir, e);
      // 空白处左键拖动 = 平移视图（Shift 保留给框选）
      if (!ctx.pickedId && !e.shiftKey) {
        panLast = { x: e.clientX, y: e.clientY };
        return;
      }
      session.applyIntent(session.tools.pointerDown(
        { world: g.world, screen: g.screen, button: e.button, shift: e.shiftKey, alt: e.altKey },
        ctx
      ));
    };

    const onPointerMove = (e: PointerEvent) => {
      if (panLast) {
        const rect = canvas.getBoundingClientRect();
        const aspect = rect.width / Math.max(1, rect.height);
        const wppX = (2 * view.halfExtent * aspect) / rect.width;
        const wppY = (2 * view.halfExtent) / rect.height;
        view.cx -= (e.clientX - panLast.x) * wppX;
        view.cz += (e.clientY - panLast.y) * wppY; // screen down = +Z
        panLast = { x: e.clientX, y: e.clientY };
        return;
      }
      const g = toGesture(e);
      session.tools.pointerMove({ world: g.world, screen: g.screen, button: e.buttons, shift: e.shiftKey, alt: e.altKey });
      // hover pick (cheap ray; fine at pointermove rate)
      const hit = session.pickTrackByRay(
        { x: g.rayOrigin.x, y: g.rayOrigin.y, z: g.rayOrigin.z },
        { x: g.rayDir.x, y: g.rayDir.y, z: g.rayDir.z },
        session.frame
      );
      let hoverId = hit?.id ?? null;
      if (!hoverId) hoverId = session.pickGeometryAtWorld(g.world, Math.max(0.6, view.halfExtent * 0.02));
      session.setHover(hoverId);
      // tooltip: id / class / keyframe state
      if (hoverId) {
        const record = session.store.getTrack(hoverId);
        const text = record
          ? `${record.meta.label}·${hoverId.slice(-4)}${session.store.getKeyframes(hoverId)?.frames.includes(session.frame) ? ' ◆关键帧' : ''}`
          : `几何·${hoverId.slice(-4)}`;
        tooltipDiv.textContent = text;
        tooltipDiv.style.display = 'block';
        tooltipDiv.style.left = `${g.screen.x + 14}px`;
        tooltipDiv.style.top = `${g.screen.y + 10}px`;
      } else {
        tooltipDiv.style.display = 'none';
      }
      if (session.heightField && session.tools.activeTool !== 'select') {
        session.heightField.prefetchAround(g.world.x, g.world.z);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (panLast) {
        panLast = null;
        return;
      }
      const g = toGesture(e);
      const ctx = buildContext(g.world, g.rayOrigin, g.rayDir, e);
      session.applyIntent(session.tools.pointerUp(
        { world: g.world, screen: g.screen, button: e.button, shift: e.shiftKey, alt: e.altKey },
        ctx
      ));
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = toGesture(e);
      const factor = Math.exp(e.deltaY * 0.0012);
      const next = Math.min(500, Math.max(4, view.halfExtent * factor));
      // zoom toward cursor
      const k = next / view.halfExtent;
      view.cx = g.world.x + (view.cx - g.world.x) * k;
      view.cz = g.world.z + (view.cz - g.world.z) * k;
      view.halfExtent = next;
    };

    const onDoubleClick = (e: MouseEvent) => {
      if (session.tools.activeTool === 'polyline' || session.tools.activeTool === 'polygon') {
        session.applyIntent(session.tools.finishGeometry());
        return;
      }
      // select tool: double-click re-centers the view on that point
      const g = toGesture(e);
      view.cx = g.world.x;
      view.cz = g.world.z;
      applyCamera();
    };

    const onContextMenu = (e: MouseEvent) => {
      e.preventDefault();
      const g = toGesture(e);
      const ctx = buildContext(g.world, g.rayOrigin, g.rayDir, e);
      wrap.dataset.lastContext = ctx.pickedId ?? 'none';
      if (!ctx.pickedId) {
        hideMenu();
        return;
      }
      session.selection.select([ctx.pickedId]);
      menuDiv.innerHTML = '';
      const isTrack = !!session.store.getTrack(ctx.pickedId);
      if (isTrack) {
        menuItem('设为关键帧 (K)', () => session.setKeyframeAtCurrentFrame(ctx.pickedId!));
        menuItem('删除关键帧', () => session.removeKeyframeAtCurrentFrame(ctx.pickedId!));
        menuItem('拆分轨迹', () => session.splitSelectedAtCurrentFrame());
        if (session.selection.size >= 2) menuItem('合并轨迹', () => session.mergeSelectedTracks());
        menuItem('复制轨迹 (偏移)', () => session.duplicateSelection());
      }
      menuItem('删除 (Del)', () => session.deleteSelection());
      const label = isTrack
        ? session.store.getTrack(ctx.pickedId)?.meta.label
        : session.store.getGeometry(ctx.pickedId)?.meta.label;
      if (label) {
        menuItem(`隐藏类别「${label}」`, () => session.setLabelHidden(label, true));
      }
      const rect2 = canvas.getBoundingClientRect();
      menuDiv.style.left = `${Math.min(e.clientX - rect2.left, rect2.width - 160)}px`;
      menuDiv.style.top = `${Math.min(e.clientY - rect2.top, rect2.height - 220)}px`;
      menuDiv.style.display = 'block';
    };
    const onDocClick = (e: MouseEvent) => {
      if (!menuDiv.contains(e.target as Node)) hideMenu();
    };
    document.addEventListener('click', onDocClick);
    // debug/automation hook: same code path as a real right-click
    (window as unknown as { __lfBevContext?: (x: number, y: number) => void }).__lfBevContext = (cx: number, cy: number) => {
      const fake = {
        clientX: cx,
        clientY: cy,
        shiftKey: false,
        altKey: false,
        preventDefault: () => undefined,
      };
      const g = toGesture(fake as MouseEvent);
      const ctx = buildContext(g.world, g.rayOrigin, g.rayDir, fake as MouseEvent);
      onContextMenu(fake as unknown as MouseEvent);
      return ctx.pickedId;
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('contextmenu', onContextMenu);

    const onBadgeToggle = (e: Event) => badges.setOptions({ showAll: Boolean((e as CustomEvent).detail) });
    window.addEventListener('lf:badges', onBadgeToggle);

    // ---- render loop ----
    let rafId = 0;
    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      renderer.setSize(w, h, false);
      applyCamera();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    const tmpPreviewBuf = new Float32Array(2048 * 3);
    const renderLoop = () => {
      const frame = session.frame;
      wrap.dataset.bev = `${view.cx.toFixed(1)},${view.cz.toFixed(1)},${view.halfExtent.toFixed(0)}`;
      // 诊断：画布中心的射线拾取结果
      {
        raycaster.setFromCamera(new THREE.Vector2(0, 0), camera);
        const hitIds = session.store.activeTrackIds(frame);
        let hit = 'none';
        for (const id of hitIds) {
          const st = session.store.resolveState(id, frame);
          if (!st) continue;
          const t = rayOBB(
            { x: raycaster.ray.origin.x, y: raycaster.ray.origin.y, z: raycaster.ray.origin.z },
            { x: raycaster.ray.direction.x, y: raycaster.ray.direction.y, z: raycaster.ray.direction.z },
            st.pos, st.yaw, st.size
          );
          if (t !== null) { hit = id; break; }
        }
        wrap.dataset.centerPick = hit;
      }
      // class visibility filter + blink highlight + velocity arrows (selected/hover)
      const velocityIds = new Set(session.selection.all());
      if (session.hover) velocityIds.add(session.hover);
      instance.setFilter({
        hiddenLabels: session.hiddenLabels,
        blinkLabel: session.blinkLabel,
        blinkOn: session.blinkOn,
        velocityIds,
      });
      instance.fps = session.playhead.fps;
      // drag preview (move/rotate) applied at render level only
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
      instance.sync(frame, session.hover);
      badges.sync(frame, session.store, session.selection, session.hover);
      bevTiles?.updateView(
        {
          minX: view.cx - view.halfExtent * (wrap.clientWidth / Math.max(1, wrap.clientHeight)),
          maxX: view.cx + view.halfExtent * (wrap.clientWidth / Math.max(1, wrap.clientHeight)),
          minZ: view.cz - view.halfExtent,
          maxZ: view.cz + view.halfExtent,
        },
        (2 * view.halfExtent) / Math.max(1, wrap.clientHeight)
      );

      // tool previews
      let v = 0;
      const toolState = session.tools.state;
      if (toolState.name === 'drawBox') {
        const axisX = Math.cos(toolState.heading);
        const axisZ = -Math.sin(toolState.heading);
        const length = toolState.stage === 'heading'
          ? Math.max(0.1, Math.hypot(toolState.cursor.x - toolState.origin.x, toolState.cursor.z - toolState.origin.z))
          : toolState.length;
        const half = 1.0; // width preview fixed until width drag
        const rear = vec3(toolState.origin.x, 0.15, toolState.origin.z);
        const corners = [
          vec3(rear.x, 0.15, rear.z),
          vec3(rear.x + axisX * length, 0.15, rear.z + axisZ * length),
          vec3(rear.x + axisX * length + -axisZ * half, 0.15, rear.z + axisZ * length + axisX * half),
          vec3(rear.x + -axisZ * half, 0.15, rear.z + axisX * half),
        ];
        for (let i = 0; i < 4; i++) {
          const a = corners[i];
          const b = corners[(i + 1) % 4];
          tmpPreviewBuf[v * 3] = a.x; tmpPreviewBuf[v * 3 + 1] = a.y; tmpPreviewBuf[v * 3 + 2] = a.z; v++;
          tmpPreviewBuf[v * 3] = b.x; tmpPreviewBuf[v * 3 + 1] = b.y; tmpPreviewBuf[v * 3 + 2] = b.z; v++;
        }
        // heading ray
        tmpPreviewBuf[v * 3] = rear.x; tmpPreviewBuf[v * 3 + 1] = 0.15; tmpPreviewBuf[v * 3 + 2] = rear.z; v++;
        tmpPreviewBuf[v * 3] = rear.x + axisX * Math.max(length, 1); tmpPreviewBuf[v * 3 + 1] = 0.15;
        tmpPreviewBuf[v * 3 + 2] = rear.z + axisZ * Math.max(length, 1); v++;
      } else if (toolState.name === 'drawLine' && toolState.points.length > 0) {
        for (let i = 0; i < toolState.points.length - 1; i++) {
          const a = toolState.points[i];
          const b = toolState.points[i + 1];
          tmpPreviewBuf[v * 3] = a.x; tmpPreviewBuf[v * 3 + 1] = 0.15; tmpPreviewBuf[v * 3 + 2] = a.z; v++;
          tmpPreviewBuf[v * 3] = b.x; tmpPreviewBuf[v * 3 + 1] = 0.15; tmpPreviewBuf[v * 3 + 2] = b.z; v++;
        }
        const last = toolState.points[toolState.points.length - 1];
        if (toolState.cursor) {
          tmpPreviewBuf[v * 3] = last.x; tmpPreviewBuf[v * 3 + 1] = 0.15; tmpPreviewBuf[v * 3 + 2] = last.z; v++;
          tmpPreviewBuf[v * 3] = toolState.cursor.x; tmpPreviewBuf[v * 3 + 1] = 0.15; tmpPreviewBuf[v * 3 + 2] = toolState.cursor.z; v++;
        }
      } else if (toolState.name === 'measure' && toolState.points.length > 0) {
        for (let i = 0; i < toolState.points.length - 1; i++) {
          const a = toolState.points[i];
          const b = toolState.points[i + 1];
          tmpPreviewBuf[v * 3] = a.x; tmpPreviewBuf[v * 3 + 1] = 0.2; tmpPreviewBuf[v * 3 + 2] = a.z; v++;
          tmpPreviewBuf[v * 3] = b.x; tmpPreviewBuf[v * 3 + 1] = 0.2; tmpPreviewBuf[v * 3 + 2] = b.z; v++;
        }
      }
      previewLines.update(tmpPreviewBuf, v);

      // marquee rectangle (DOM overlay)
      const marquee = session.tools.marqueeRect();
      if (marquee) {
        marqueeDiv.style.display = 'block';
        marqueeDiv.style.left = `${Math.min(marquee.x0, marquee.x1)}px`;
        marqueeDiv.style.top = `${Math.min(marquee.y0, marquee.y1)}px`;
        marqueeDiv.style.width = `${Math.abs(marquee.x1 - marquee.x0)}px`;
        marqueeDiv.style.height = `${Math.abs(marquee.y1 - marquee.y0)}px`;
      } else {
        marqueeDiv.style.display = 'none';
      }

      renderer.render(scene, camera);
      rafId = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('contextmenu', onContextMenu);
      document.removeEventListener('click', onDocClick);
      window.removeEventListener('lf:badges', onBadgeToggle);
      offManifest();
      offManifestCenter();
      offMeasurement();
      offTiles();
      session.rectPicker = null;
      marqueeDiv.remove();
      tooltipDiv.remove();
      measureDiv.remove();
      menuDiv.remove();
      instance.dispose();
      badges.dispose();
      bevTiles?.dispose();
      egoLine.dispose();
      previewLines.dispose();
      if (egoDots) {
        egoDots.geometry.dispose();
        (egoDots.material as THREE.Material).dispose();
      }
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
    </div>
  );
}

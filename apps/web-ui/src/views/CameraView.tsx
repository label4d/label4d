import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { CameraImageView } from '@labelfaster/core';
import { useSession, useSessionTick } from '../session/SessionProvider';

/**
 * Camera image view: 4D objects projected through per-camera calibration
 * (pinhole / fisheye). Projected hulls are clickable to select the 4D
 * object; double-click opens the attribute editor at the cursor.
 */
export function CameraView({ index = 0 }: { index?: number }) {
  const session = useSession();
  useSessionTick(['frameChanged', 'frameStatusChanged', 'manifestLoaded', 'storeChanged']);
  const viewRef = useRef<CameraImageView | null>(null);
  const [cloudProjection, setCloudProjection] = useState(session.manifest?.id === 'demo_sequence');
  const projectionRef = useRef(cloudProjection);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const [cameraId, setCameraId] = useState<string | null>(null);
  const [editor, setEditor] = useState<{ x: number; y: number; id: string } | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    const view = new CameraImageView(session.labels);
    viewRef.current = view;
    view.setOptions({ cloudProjection: projectionRef.current });
    const debug = window as unknown as { __lfCam?: unknown; __lfCamTicks?: unknown };
    if (import.meta.env.DEV) debug.__lfCam = view;

    let currentProjectorId: string | null = null;
    let currentImage: unknown = null;

    const resize = () => {
      renderer.setSize(wrap.clientWidth, wrap.clientHeight, false);
      view.setViewportSize(wrap.clientWidth, wrap.clientHeight);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    const toImagePx = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const config = view.camera.userData.config as { width: number; height: number } | undefined;
      if (!config) return null;
      // 感知 pan/zoom 的画布->图像像素换算（整幅图铺满画布的比例映射在缩放后是错的）
      const img = view.toImagePixel(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
      if (img.x < 0 || img.y < 0 || img.x > config.width || img.y > config.height) return null;
      return {
        x: img.x,
        y: img.y,
        client: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      };
    };

    let downAt: { x: number; y: number } | null = null;
    const onClick = (e: MouseEvent) => {
      const px = toImagePx(e);
      if (!px) return;
      const hit = view.pick(px.x, px.y);
      if (hit) session.selection.select([hit.id]);
      else session.selection.clear();
    };
    const onDoubleClick = (e: MouseEvent) => {
      const px = toImagePx(e);
      if (!px) return;
      const hit = view.pick(px.x, px.y);
      if (hit) setEditor({ x: px.client.x, y: px.client.y, id: hit.id });
    };
    const onDown = (e: MouseEvent) => {
      downAt = { x: e.clientX, y: e.clientY };
    };
    const onUp = (e: MouseEvent) => {
      if (downAt && Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) > 5) {
        // drag: ignore (no marquee in camera view v1)
      } else if (e.button === 0) {
        onClick(e);
      }
      downAt = null;
    };
    canvas.addEventListener('dblclick', onDoubleClick);
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointerup', onUp);

    // 视图平移/缩放：滚轮缩放（光标为中心），左键拖动平移
    let panLast: { x: number; y: number } | null = null;
    const onPanDown = (e: PointerEvent) => {
      if (e.button === 0) { panLast = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); }
    };
    const onPanMove = (e: PointerEvent) => {
      if (!panLast || !view.hasProjector) return;
      const rect = canvas.getBoundingClientRect();
      const config = (view.camera.userData as { config?: { width: number; height: number } }).config;
      if (!config) return;
      // 严格像素跟随：正交视口宽 config.width/viewScale 图像像素铺满 rect.width 屏幕像素；
      // 画布与图像纵横比不同（拉伸填充），横纵系数分开算
      const kx = (view.camera.right - view.camera.left) / rect.width;
      const ky = (view.camera.top - view.camera.bottom) / rect.height;
      view.panByPixels((e.clientX - panLast.x) * kx, -(e.clientY - panLast.y) * ky);
      panLast = { x: e.clientX, y: e.clientY };
    };
    const onPanUp = () => { panLast = null; };
    const cancelPointer = () => { panLast = null; downAt = null; };
    canvas.addEventListener('pointerdown', onPanDown);
    canvas.addEventListener('pointermove', onPanMove);
    canvas.addEventListener('pointerup', onPanUp);
    canvas.addEventListener('pointercancel', cancelPointer);
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const config = (view.camera.userData as { config?: { width: number; height: number } }).config;
      if (!config) return;
      const img = view.toImagePixel(e.clientX - rect.left, e.clientY - rect.top, rect.width, rect.height);
      if (img.x < 0 || img.y < 0 || img.x > config.width || img.y > config.height) return null;
      const imgYGl = config.height - img.y;
      view.zoomAtCursor(img.x, imgYGl, Math.exp(-e.deltaY * 0.0015));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const onBadgeToggle = (e: Event) => view.setOptions({ showAll: Boolean((e as CustomEvent).detail) });
    window.addEventListener('lf:badges', onBadgeToggle);


    let rafId = 0;
    const ticks = { n: 0, wanted: null as string | null };
    if (import.meta.env.DEV) debug.__lfCamTicks = ticks;
    const renderLoop = () => {
      try {
        runFrame();
      } catch (error) {
        (ticks as { err?: string }).err = String(error);
        return;
      }
      rafId = requestAnimationFrame(renderLoop);
    };
    const runFrame = () => {
      ticks.n++;
      const cameras = [...session.projectors.keys()];
      const wantedId = cameraId && session.projectors.has(cameraId) ? cameraId : cameras.length ? cameras[Math.min(index, cameras.length - 1)] : null;
      if (wantedId && wantedId !== currentProjectorId) {
        const projector = session.projectors.get(wantedId);
        if (projector) {
          view.attachProjector(projector);
          view.camera.userData.config = projector.config;
          currentProjectorId = wantedId;
          currentImage = null; // force re-set
        }
      }

      const frame = session.frame;
      // ensure current image is requested; FrameBuffer prefetch usually wins
      const image = session.currentCameraImage(wantedId);
      if (image !== currentImage) {
        currentImage = image;
        view.setImage(image);
      }

      if (currentProjectorId) {
        if (image) view.syncFrame(frame, session.store, session.selection, session.currentPointCloud(), session.hover, session.selectionPreview, session.hiddenLabels);
        view.render(renderer);
      }
    };
    renderLoop();

    return () => {
      cancelAnimationFrame(rafId);
      observer.disconnect();
      canvas.removeEventListener('dblclick', onDoubleClick);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointerdown', onPanDown);
      canvas.removeEventListener('pointermove', onPanMove);
      canvas.removeEventListener('pointerup', onPanUp);
      canvas.removeEventListener('pointercancel', cancelPointer);
      canvas.removeEventListener('wheel', onWheel);
      window.removeEventListener('lf:badges', onBadgeToggle);
      if (viewRef.current === view) viewRef.current = null;
      if (debug.__lfCam === view) delete debug.__lfCam;
      if (debug.__lfCamTicks === ticks) delete debug.__lfCamTicks;
      view.dispose();
      renderer.dispose();
    };
  }, [session, cameraId, session.manifest, index]);

  const cameras = [...session.projectors.keys()];
  const editorTrack = editor ? session.store.getTrack(editor.id) : undefined;
  const editorLabel = editorTrack ? session.labels.find((l) => l.name === editorTrack.meta.label) : undefined;

  return (
    <div ref={wrapRef} className="camera-view">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="camera-chrome">
        <select aria-label={`选择相机 ${index + 1}`} value={cameraId && cameras.includes(cameraId) ? cameraId : cameras[Math.min(index, cameras.length - 1)] ?? ''} onChange={(e) => setCameraId(e.target.value)}>
          {cameras.map((id) => <option key={id} value={id}>{id} · {session.projectors.get(id)?.config.model === 'pinhole' ? '针孔' : '鱼眼'}</option>)}
        </select>
        <label className="camera-cloud-toggle"><input type="checkbox" checked={cloudProjection} onChange={(e) => { setCloudProjection(e.target.checked); projectionRef.current = e.target.checked; viewRef.current?.setOptions({ cloudProjection: e.target.checked }); }} />点云投影</label>
      </div>
      {session.manifest?.id === 'demo_sequence' && <span className="camera-demo-label">合成示意图</span>}
      {session.frameStatus === 'ready' && !session.currentCameraImage(cameraId ?? cameras[Math.min(index, cameras.length - 1)]) && <div className="camera-empty">当前帧无相机图像</div>}

      {editor && editorTrack && (
        <div
          ref={editorRef}
          className="absolute z-20 w-44 rounded border border-[#2b3b52] bg-[#10161f]/95 p-2 text-[11px] text-slate-200 shadow-xl"
          style={{ left: Math.min(editor.x, 600), top: Math.min(editor.y, 300) }}
        >
          <div className="mb-1 flex items-center justify-between">
            <b>{editorTrack.meta.label}·{editorTrack.meta.id.slice(-4)}</b>
            <button className="text-slate-500 hover:text-white" onClick={() => setEditor(null)}>✕</button>
          </div>
          {editorLabel?.attributeSchema?.length ? (
            editorLabel.attributeSchema.map((def) => {
              const frameAttrs = session.store.getFrameAttributes(editor.id, session.frame) ?? {};
              const value = def.perFrame ? frameAttrs[def.key] : editorTrack.meta.attributes[def.key];
              return (
                <label key={def.key} className="flex items-center justify-between py-0.5">
                  <span className="text-[10px] text-slate-500">{def.key}{def.perFrame ? ' ⏱' : ''}</span>
                  {def.type === 'enum' ? (
                    <select
                      className="w-20 rounded bg-[#1d2530] px-1 text-[11px] outline-none"
                      value={String(value ?? def.default ?? '')}
                      onChange={(e) =>
                        def.perFrame
                          ? session.setFrameAttribute(editor.id, def.key, e.target.value)
                          : session.setTrackAttribute(editor.id, def.key, e.target.value)
                      }
                    >
                      {def.options?.map((option) => (
                        <option key={option} value={option}>{option}</option>
                      ))}
                    </select>
                  ) : def.type === 'bool' ? (
                    <input
                      type="checkbox"
                      checked={Boolean(value ?? def.default ?? false)}
                      onChange={(e) =>
                        def.perFrame
                          ? session.setFrameAttribute(editor.id, def.key, e.target.checked)
                          : session.setTrackAttribute(editor.id, def.key, e.target.checked)
                      }
                    />
                  ) : (
                    <input
                      className="w-20 rounded bg-[#1d2530] px-1 text-[11px] outline-none"
                      value={String(value ?? '')}
                      onChange={(e) =>
                        def.perFrame
                          ? session.setFrameAttribute(editor.id, def.key, def.type === 'number' ? Number(e.target.value) : e.target.value)
                          : session.setTrackAttribute(editor.id, def.key, def.type === 'number' ? Number(e.target.value) : e.target.value)
                      }
                    />
                  )}
                </label>
              );
            })
          ) : (
            <div className="text-[10px] text-slate-500">该类别未定义属性 schema</div>
          )}
        </div>
      )}
    </div>
  );
}

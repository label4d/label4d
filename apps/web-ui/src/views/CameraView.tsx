import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { CameraImageView } from '@labelfaster/core';
import { useSession } from '../session/SessionProvider';

/**
 * Camera image view: 4D objects projected through per-camera calibration
 * (pinhole / fisheye). Projected hulls are clickable to select the 4D
 * object; double-click opens the attribute editor at the cursor.
 */
export function CameraView({ index = 0 }: { index?: number }) {
  const session = useSession();
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
    (window as unknown as { __lfCam?: unknown }).__lfCam = view;

    let currentProjectorId: string | null = null;
    let currentImage: unknown = null;
    let currentFrame = -1;

    const resize = () => {
      renderer.setSize(wrap.clientWidth, wrap.clientHeight, false);
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(wrap);

    const toImagePx = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const config = view.camera.userData.config as { width: number; height: number } | undefined;
      if (!config) return null;
      return {
        x: ((e.clientX - rect.left) / rect.width) * config.width,
        y: ((e.clientY - rect.top) / rect.height) * config.height,
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
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button === 0) { panLast = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); }
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!panLast || !view.hasProjector) return;
      const rect = canvas.getBoundingClientRect();
      const config = (view.camera.userData as { config?: { width: number; height: number } }).config;
      if (!config) return;
      const k = config.width / rect.width;
      view.panByPixels(-(e.clientX - panLast.x) * k, (e.clientY - panLast.y) * k);
      panLast = { x: e.clientX, y: e.clientY };
    });
    canvas.addEventListener('pointerup', () => { panLast = null; });
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const config = (view.camera.userData as { config?: { width: number; height: number } }).config;
      if (!config) return;
      const imgX = ((e.clientX - rect.left) / rect.width) * config.width;
      const imgYGl = config.height - ((e.clientY - rect.top) / rect.height) * config.height;
      view.zoomAtCursor(imgX, imgYGl, Math.exp(-e.deltaY * 0.0015));
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });

    const onBadgeToggle = (e: Event) => view.setOptions({ showAll: Boolean((e as CustomEvent).detail) });
    window.addEventListener('lf:badges', onBadgeToggle);
    const onCloudProj = (e: Event) => view.setOptions({ cloudProjection: Boolean((e as CustomEvent).detail) });
    window.addEventListener('lf:cloudproj', onCloudProj);

    let rafId = 0;
    const ticks = { n: 0, wanted: null as string | null };
    (window as unknown as { __lfCamTicks?: typeof ticks }).__lfCamTicks = ticks;
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
      const wantedId = cameras.length ? cameras[Math.min(index, cameras.length - 1)] : null;
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
      const image = session.currentCameraImage();
      if (image && image !== currentImage) {
        currentImage = image;
        view.setImage(image);
      } else if (!image && session.imageFrames && frame !== currentFrame) {
        void session.imageFrames.ensure(frame);
      }
      currentFrame = frame;

      if (currentProjectorId) {
        view.syncFrame(frame, session.store, session.selection, session.currentPointCloud(), session.hover);
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
      window.removeEventListener('lf:badges', onBadgeToggle);
      window.removeEventListener('lf:cloudproj', onCloudProj);
      view.dispose();
      renderer.dispose();
    };
  }, [session, cameraId]);

  const cameras = [...session.projectors.keys()];
  const editorTrack = editor ? session.store.getTrack(editor.id) : undefined;
  const editorLabel = editorTrack ? session.labels.find((l) => l.name === editorTrack.meta.label) : undefined;

  return (
    <div ref={wrapRef} className="relative min-h-0 flex-1 overflow-hidden bg-black">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div className="absolute left-2 top-2 flex gap-1">
        {cameras.map((id) => {
          const config = session.projectors.get(id)?.config;
          return (
            <button
              key={id}
              className={`rounded px-2 py-0.5 text-[10px] ${
                (cameraId ?? session.activeCameraId) === id ? 'bg-[#2b6cff] text-white' : 'bg-black/60 text-slate-300'
              }`}
              onClick={() => setCameraId(id)}
            >
              {id}·{config?.model === 'pinhole' ? '针孔' : config?.model === 'fisheye_equidistant' ? '鱼眼等距' : config?.model}
            </button>
          );
        })}
      </div>
      <div className="absolute right-2 top-2 flex items-center gap-2">
        <label className="flex items-center gap-1 rounded bg-black/60 px-2 py-0.5 text-[10px] text-slate-300">
          <input
            type="checkbox"
            defaultChecked
            onChange={(e) => window.dispatchEvent(new CustomEvent('lf:cloudproj', { detail: e.target.checked }))}
          />
          点云投影
        </label>
        <span className="rounded bg-black/60 px-2 py-0.5 text-[10px] text-slate-400">双击投影 → 编辑属性</span>
      </div>

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

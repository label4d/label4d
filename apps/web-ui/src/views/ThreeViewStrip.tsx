import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { ThreeViewPanel, vec3 } from '@labelfaster/core';
import type { ThreeViewAxis } from '@labelfaster/core';
import { useSession } from '../session/SessionProvider';

const AXES: ThreeViewAxis[] = ['top', 'front', 'side'];
const AXIS_LABEL: Record<ThreeViewAxis, string> = { top: '俯视', front: '前视', side: '侧视' };

/** Point-cloud three-view strip (top / front / side), clickable to select. */
export function ThreeViewStrip() {
  const session = useSession();
  const [depthHalf, setDepthHalf] = useState(12);
  const refs = useRef<Array<{ wrap: HTMLDivElement; canvas: HTMLCanvasElement } | null>>([null, null, null]);

  useEffect(() => {
    const cleanups: Array<() => void> = [];
    const panels: ThreeViewPanel[] = [];
    const renderers: THREE.WebGLRenderer[] = [];

    refs.current.forEach((entry, index) => {
      if (!entry) return;
      const { wrap, canvas } = entry;
      const axis = AXES[index];
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
      const panel = new ThreeViewPanel(axis, session.labels);
      panels.push(panel);
      renderers.push(renderer);

      const resize = () => {
        renderer.setSize(wrap.clientWidth, wrap.clientHeight, false);
        panel.fit(session.ego.positionAt(session.frame), 45);
      };
      resize();
      const observer = new ResizeObserver(resize);
      observer.observe(wrap);
      const offManifest = session.events.on('manifestLoaded', () => {
        resize();
      });
      cleanups.push(() => {
        offManifest();
      });

      let downAt: { x: number; y: number } | null = null;
      const panelCoords = (e: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        const p = panel.screenToPlane(
          e.clientX - rect.left,
          e.clientY - rect.top,
          rect.width,
          rect.height
        );
        return { x: p.x, y: p.y, moved: downAt ? Math.hypot(e.clientX - downAt.x, e.clientY - downAt.y) : 0 };
      };
      const onDown = (e: MouseEvent) => {
        downAt = { x: e.clientX, y: e.clientY };
      };
      const onUp = (e: MouseEvent) => {
        const p = panelCoords(e);
        if (p.moved > 4) return;
        const id = panel.pick(p.x, p.y);
        if (id) session.selection.select([id]);
      };
      canvas.addEventListener('pointerdown', onDown);
      canvas.addEventListener('pointerup', onUp);
      let panDrag: { x: number; y: number } | null = null;
      const onPanDown = (ev: MouseEvent) => {
        if (ev.button === 1 || (ev.button === 0 && ev.shiftKey)) { panDrag = { x: ev.clientX, y: ev.clientY }; canvas.setPointerCapture((ev as unknown as PointerEvent).pointerId); }
      };
      const onPanMove = (ev: MouseEvent) => {
        if (!panDrag) return;
        const rect = canvas.getBoundingClientRect();
        panel.panByFraction((ev.clientX - panDrag.x) / rect.width, (ev.clientY - panDrag.y) / rect.height);
        panDrag = { x: ev.clientX, y: ev.clientY };
      };
      const onPanUp = () => { panDrag = null; };
      const onWheel = (ev: WheelEvent) => { ev.preventDefault(); panel.zoomBy(Math.exp(-ev.deltaY * 0.0015)); };
      canvas.addEventListener('pointerdown', onPanDown);
      canvas.addEventListener('pointermove', onPanMove);
      canvas.addEventListener('pointerup', onPanUp);
      canvas.addEventListener('wheel', onWheel, { passive: false });

      cleanups.push(() => {
        observer.disconnect();
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointerdown', onPanDown);
        canvas.removeEventListener('pointermove', onPanMove);
        canvas.removeEventListener('pointerup', onPanUp);
        canvas.removeEventListener('wheel', onWheel);
        panel.dispose();
        renderer.dispose();
      });
    });

    let rafId = 0;
    let lastCloud: unknown = null;
    let lastCloudFrame = -1;
    const renderLoop = () => {
      const frame = session.frame;
      const cloud = session.currentPointCloud();
      // 选中对象时三视图聚焦该对象；未选中时跟随自车
      const focusId = session.selection.first;
      const focusState = focusId ? session.store.resolveState(focusId, frame) : null;
      const center = focusState ? focusState.pos : session.ego.positionAt(frame);
      const half = focusState ? 12 : 45;
      panels.forEach((panel, index) => {
        const entry = refs.current[index];
        if (!entry) return;
        panel.fit(center, half);
        const depthCenter = focusState ? panel.depthOf(center) : 0;
        if (cloud && (cloud !== lastCloud || frame !== lastCloudFrame || index === 0)) {
          panel.setCloud(cloud, depthCenter - depthHalfWindow(), depthCenter + depthHalfWindow());
        }
        panel.syncFrame(frame, session.store, session.selection);
        const panelRenderer = renderers[index];
        if (panelRenderer) panel.render(panelRenderer);
      });
      lastCloud = cloud;
      lastCloudFrame = frame;
      rafId = requestAnimationFrame(renderLoop);
    };
    renderLoop();

    function depthHalfWindow() {
      return depthHalf;
    }

    return () => {
      cancelAnimationFrame(rafId);
      cleanups.forEach((fn) => fn());
    };
  }, [session, depthHalf]);

  return (
    <div className="flex min-h-0 flex-1 gap-px bg-[#1d2530]">
      {AXES.map((axis, index) => (
        <div
          key={axis}
          ref={(el) => {
            if (el) {
              const canvas = el.querySelector('canvas');
              refs.current[index] = canvas
                ? { wrap: el, canvas: canvas as HTMLCanvasElement }
                : null;
            }
          }}
          className="relative min-h-0 flex-1 bg-[#0b0e13]"
        >
          {index === 0 && (
            <label className="absolute left-1 top-1 z-10 flex items-center gap-1 rounded bg-black/50 px-1 text-[9px] text-slate-300">
              深度
              <input
                type="range"
                min={2}
                max={40}
                value={depthHalf}
                className="w-14 accent-[#2b6cff]"
                onChange={(e) => setDepthHalf(Number(e.target.value))}
              />
            </label>
          )}
          <span className="absolute right-1 top-1 z-10 rounded bg-black/50 px-1 text-[9px] text-slate-400">{AXIS_LABEL[axis]}</span>
          <canvas className="block h-full w-full" />
        </div>
      ))}
    </div>
  );
}

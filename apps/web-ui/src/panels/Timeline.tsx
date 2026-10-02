import { useEffect, useRef } from 'react';
import { useSession, useSessionTick } from '../session/SessionProvider';
import { colorForLabel } from '@labelfaster/core';

const ROW_HEIGHT = 16;
const LABEL_WIDTH = 90;

/**
 * Canvas timeline: frame ruler, per-track existence bars with keyframe
 * diamonds, playhead, scrub/seek. Rows are virtualized by scroll offset so
 * thousands of tracks stay smooth.
 */
export function Timeline() {
  const session = useSession();
  useSessionTick(['frameChanged', 'storeChanged', 'selectionChanged']);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const parent = canvas.parentElement as HTMLElement;

    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = parent.clientWidth;
      const height = parent.clientHeight;
      if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
        canvas.width = width * dpr;
        canvas.height = height * dpr;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.fillStyle = '#0e1218';
      ctx.fillRect(0, 0, width, height);

      const frameCount = session.frameCount;
      const frame = session.frame;
      const x0 = LABEL_WIDTH;
      const plot = width - x0 - 8;
      const fx = (f: number) => x0 + (f / Math.max(1, frameCount - 1)) * plot;

      // ruler
      ctx.fillStyle = '#151b24';
      ctx.fillRect(0, 0, width, 20);
      ctx.fillStyle = '#5b6b7f';
      ctx.font = '10px system-ui';
      const stepFrames = Math.max(1, Math.round(frameCount / Math.max(4, plot / 60)));
      for (let f = 0; f < frameCount; f += stepFrames) {
        const x = fx(f);
        ctx.fillRect(x, 14, 1, 6);
        ctx.fillText(String(f), x + 2, 11);
      }

      // rows (virtualized)
      const rowsTop = 22;
      const visibleRows = Math.floor((height - rowsTop - 14) / ROW_HEIGHT);
      const records = session.store.listTracks();
      const firstRow = Math.floor(scrollRef.current / ROW_HEIGHT);
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, rowsTop, width, height - rowsTop - 14);
      ctx.clip();
      for (let i = 0; i <= visibleRows + 1; i++) {
        const record = records[firstRow + i];
        if (!record) break;
        const y = rowsTop + i * ROW_HEIGHT - (scrollRef.current % ROW_HEIGHT);
        const selected = session.selection.has(record.meta.id);
        ctx.fillStyle = selected ? '#20293a' : '#12171f';
        ctx.fillRect(0, y, width, ROW_HEIGHT - 1);
        // label
        ctx.fillStyle = selected ? '#e8eef7' : '#8496ab';
        ctx.font = '10px system-ui';
        ctx.fillText(`${record.meta.label}·${record.meta.id.slice(-4)}`, 6, y + 11);
        // existence bar
        const color = colorForLabel(session.labels, record.meta.label);
        ctx.fillStyle = color;
        ctx.globalAlpha = selected ? 0.95 : 0.45;
        const bx = fx(record.meta.startFrame);
        const bw = Math.max(2, fx(record.meta.endFrame) - bx);
        ctx.fillRect(bx, y + 4, bw, ROW_HEIGHT - 9);
        ctx.globalAlpha = 1;
        // keyframe diamonds
        const kf = session.store.getKeyframes(record.meta.id);
        if (kf) {
          ctx.fillStyle = '#ffffff';
          for (let k = 0; k < kf.frames.length; k++) {
            const x = fx(kf.frames[k]);
            ctx.beginPath();
            ctx.moveTo(x, y + 3);
            ctx.lineTo(x + 3, y + 7.5);
            ctx.lineTo(x, y + 12);
            ctx.lineTo(x - 3, y + 7.5);
            ctx.closePath();
            ctx.fill();
          }
        }
        if (selected) {
          ctx.strokeStyle = '#ffe94f';
          ctx.strokeRect(0.5, y + 0.5, width - 1, ROW_HEIGHT - 2);
        }
      }
      ctx.restore();

      // playhead
      const px = fx(frame);
      ctx.fillStyle = '#ff5566';
      ctx.fillRect(px, 0, 1.5, height);
      ctx.beginPath();
      ctx.moveTo(px - 5, 0);
      ctx.lineTo(px + 6, 0);
      ctx.lineTo(px + 0.5, 9);
      ctx.closePath();
      ctx.fill();
    };

    draw();
    const off = session.events.on('frameChanged', draw);
    const off2 = session.events.on('storeChanged', draw);
    const off3 = session.events.on('selectionChanged', draw);
    const observer = new ResizeObserver(draw);
    observer.observe(parent);
    return () => {
      off();
      off2();
      off3();
      observer.disconnect();
    };
  }, [session]);

  const frameFromEvent = (e: React.PointerEvent<HTMLCanvasElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - LABEL_WIDTH;
    const plot = rect.width - LABEL_WIDTH - 8;
    return Math.max(0, Math.min(session.frameCount - 1, Math.round((x / Math.max(1, plot)) * (session.frameCount - 1))));
  };

  return (
    <canvas
      ref={canvasRef}
      className="block h-full w-full cursor-crosshair select-none"
      onWheel={(e) => {
        scrollRef.current = Math.max(0, scrollRef.current + e.deltaY);
      }}
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        session.setFrame(frameFromEvent(e));
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) session.setFrame(frameFromEvent(e));
      }}
    />
  );
}

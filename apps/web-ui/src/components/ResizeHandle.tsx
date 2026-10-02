import { useRef } from 'react';

export function ResizeHandle({ axis, value, onChange, min, max, label, reverse = false }: {
  axis: 'x' | 'y'; value: number; onChange: (value: number) => void;
  min: number; max: number; label: string; reverse?: boolean;
}) {
  const drag = useRef<{ start: number; value: number } | null>(null);
  const clamp = (n: number) => Math.min(max, Math.max(min, n));
  return <div className={`resize-handle resize-${axis}`} role="separator" tabIndex={0}
    aria-label={label} aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value)}
    onPointerDown={(e) => { e.preventDefault(); drag.current = { start: axis === 'x' ? e.clientX : e.clientY, value }; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={(e) => { if (!drag.current) return; const p = axis === 'x' ? e.clientX : e.clientY; onChange(clamp(drag.current.value + (p - drag.current.start) * (reverse ? -1 : 1))); }}
    onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}
    onKeyDown={(e) => { const direction = ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : ['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : 0;
      if (!direction) return; e.preventDefault(); e.stopPropagation(); onChange(clamp(value + direction * (reverse ? -16 : 16))); }} />;
}

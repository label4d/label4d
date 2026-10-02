import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';

export function Dropdown({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) ref.current?.removeAttribute('open'); };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape' && ref.current?.open) { ref.current.removeAttribute('open'); ref.current.querySelector('summary')?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  return <details ref={ref} className={`dropdown ${className}`}>
    <summary className="btn" aria-label={label}>{label}<ChevronDown size={14} /></summary>
    <div className="dropdown-content">{children}</div>
  </details>;
}

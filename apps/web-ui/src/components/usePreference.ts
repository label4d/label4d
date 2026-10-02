import { useEffect, useState } from 'react';

/** Layout preferences are independent of annotation document revisions. */
export function usePreference<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try { const saved = localStorage.getItem(`labelfaster.ui.${key}`); if (saved !== null) {
      const parsed: unknown = JSON.parse(saved);
      if (typeof parsed === typeof initial && (typeof parsed !== 'number' || Number.isFinite(parsed))) return parsed as T;
    } } catch { /* Layout still works without browser storage. */ }
    return initial;
  });
  useEffect(() => { try { localStorage.setItem(`labelfaster.ui.${key}`, JSON.stringify(value)); } catch { /* Optional preference. */ } }, [key, value]);
  return [value, setValue] as const;
}

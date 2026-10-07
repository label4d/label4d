import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { EditorSession, IndexedDbDocumentStorage } from '@labelfaster/core';
import type { SessionEvents } from '@labelfaster/core';
import { installTestProbe } from './testProbe';

const SessionContext = createContext<EditorSession | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<EditorSession | null>(null);
  const [startupError, setStartupError] = useState<string | null>(null);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const explicitManifest = params.get('manifest');
    const manifestUrl = explicitManifest || '/kitti-camera/manifest.json';
    const next = new EditorSession();
    let active = true;
    const removeProbe = installTestProbe(next);
    const onPageHide = () => { active = false; next.dispose(); };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    setSession(next);
    if (import.meta.env.DEV) (window as unknown as { __lf?: EditorSession }).__lf = next;
    void (async () => {
      let documentLoaded = false;
      try {
        const response = await fetch(manifestUrl);
        if (!response.ok) throw new Error(`${manifestUrl}：HTTP ${response.status}`);
        if (!response.headers.get('content-type')?.includes('application/json')) {
          throw new Error(`${manifestUrl} 未返回 JSON，请确认数据已准备且服务路径正确`);
        }
        const manifest = await response.json();
        if (!active) return;
        await next.loadManifest(manifest);
        if (!active) return;
        const snapshotUrl = new URL('snapshot.json', new URL(manifestUrl, window.location.href)).href;
        const snapshot = await fetch(snapshotUrl);
        if (snapshot.ok && snapshot.headers.get('content-type')?.includes('application/json') && active) next.importSnapshot(await snapshot.json());
        documentLoaded = true;
        if (active) await next.enablePersistence(new IndexedDbDocumentStorage());
      } catch (error) {
        if (active) {
          if (documentLoaded) next.events.emit('error', { message: String(error) });
          else setStartupError(String(error));
        }
      }
    })();
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('pageshow', onPageShow);
      active = false; removeProbe(); next.dispose();
      const debug = window as unknown as { __lf?: EditorSession };
      if (debug.__lf === next) delete debug.__lf;
    };
  }, []);
  if (startupError) return <div role="alert" className="error-banner">
    <div><b>数据加载失败</b><p>{startupError}</p>
      <p>请先导入 KITTI 数据，或通过 manifest 参数指定已有数据集。</p>
      <button onClick={() => window.location.reload()}>重新加载</button>
    </div>
  </div>;
  return session ? <SessionContext.Provider value={session}>{children}</SessionContext.Provider> : null;
}

export function useSession(): EditorSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}

/** Re-render the component whenever any of the given session events fires. */
export function useSessionTick(events: Array<keyof SessionEvents>): number {
  const session = useSession();
  const [tick, setTick] = useState(0);
  const key = events.join('|');
  useEffect(() => {
    const names = key.split('|') as Array<keyof SessionEvents>;
    const offs = names.map((event) => session.events.on(event, () => setTick((t) => (t + 1) % 1000000)));
    return () => offs.forEach((off) => off());
  }, [session, key]);
  return tick;
}

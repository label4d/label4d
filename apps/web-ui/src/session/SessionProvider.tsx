import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { EditorSession, IndexedDbDocumentStorage } from '@labelfaster/core';
import type { SessionEvents, SnapshotDocument } from '@labelfaster/core';
import { installTestProbe } from './testProbe';
import { buildDemoManifest, demoFetchImage, demoNet, demoSeedSnapshot } from '../lib/demo';

const SessionContext = createContext<EditorSession | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<EditorSession | null>(null);
  useEffect(() => {
    const next = new EditorSession({ net: demoNet, fetchImage: demoFetchImage });
    let active = true;
    const removeProbe = installTestProbe(next);
    const onPageHide = () => { active = false; next.dispose(); };
    const onPageShow = (event: PageTransitionEvent) => { if (event.persisted) window.location.reload(); };
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    setSession(next);
    if (import.meta.env.DEV) (window as unknown as { __lf?: EditorSession }).__lf = next;
    const manifestUrl = new URLSearchParams(window.location.search).get('manifest');
    void (async () => {
      try {
        if (manifestUrl) {
          const response = await fetch(manifestUrl);
          if (!response.ok) throw new Error(`Manifest HTTP ${response.status}`);
          const manifest = await response.json();
          if (!active) return;
          await next.loadManifest(manifest);
          if (!active) return;
          const snapshotUrl = new URL('snapshot.json', new URL(manifestUrl, window.location.href)).href;
          const snapshot = await fetch(snapshotUrl);
          if (snapshot.ok && active) next.importSnapshot(await snapshot.json());
        } else {
          await next.loadManifest(buildDemoManifest());
          if (!active) return;
          next.heightPolicy = 'zero-plane'; // demo explicitly declares a flat ground plane
          next.importSnapshot(demoSeedSnapshot('demo_sequence') as unknown as SnapshotDocument);
          next.selection.select(['trk_000001']);
        }
        if (active) await next.enablePersistence(new IndexedDbDocumentStorage());
      } catch (error) {
        if (active) next.events.emit('error', { message: String(error) });
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

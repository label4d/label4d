import { createContext, useContext, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { EditorSession } from '@labelfaster/core';
import type { SessionEvents, SnapshotDocument } from '@labelfaster/core';
import { buildDemoManifest, demoFetchImage, demoNet, demoSeedSnapshot } from '../lib/demo';

const SessionContext = createContext<EditorSession | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const ref = useRef<EditorSession | null>(null);
  if (!ref.current) {
    const session = new EditorSession({ net: demoNet, fetchImage: demoFetchImage });
    ref.current = session;
    if (typeof window !== 'undefined') {
      (window as unknown as { __lf: EditorSession }).__lf = session;
    }
    const manifestUrl = new URLSearchParams(window.location.search).get('manifest');
    if (manifestUrl) {
      // real-data mode: /?manifest=/kitti/manifest.json (+ optional sibling snapshot.json)
      void (async () => {
        try {
          const response = await fetch(manifestUrl);
          const manifest = await response.json();
          await session.loadManifest(manifest);
        } catch (error) {
          console.error('[labelfaster] manifest load failed', error);
        }
        try {
          const snapshotUrl = manifestUrl.replace(/manifest\.json.*$/, 'snapshot.json');
          const snapshotResponse = await fetch(snapshotUrl);
          if (snapshotResponse.ok) {
            session.importSnapshot(await snapshotResponse.json());
          }
        } catch (error) {
          console.error('[labelfaster] snapshot import failed', error);
        }
      })();
    } else {
      void session.loadManifest(buildDemoManifest()).then(() => {
        session.importSnapshot(demoSeedSnapshot('demo_sequence') as unknown as SnapshotDocument);
        session.selection.select(['trk_000001']);
      });
    }
  }
  return <SessionContext.Provider value={ref.current}>{children}</SessionContext.Provider>;
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

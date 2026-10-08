import type { EditorSession } from '@labelfaster/core';
export function installTestProbe(session: EditorSession): () => void {
  if (import.meta.env.MODE !== 'test') return () => {};
  const probe = { async read(query: { objectIds?: string[] } = {}) {
    const ids = query.objectIds ?? session.selection.all();
    if (ids.length > 32) throw new Error('Probe query is limited to 32 objects');
    const documentRevision = session.documentRevision;
    return structuredClone({ probeVersion: 1, capturedAt: Date.now(), documentRevision,
      renderRevision: session.store.currentVersion, nonAtomic: false,
      frame: { requested: session.requestedFrame, presented: session.frame, status: session.frameStatus },
      document: { tracks: session.readOnly ? [] : ids.map((id) => session.store.serializeTrack(id)), trackCount: session.store.trackCount },
      dataset: { readOnly: session.readOnly, time: session.playhead.timeAt(session.frame), active: session.store.activeTrackIds(session.frame),
        states: ids.map((id) => session.store.resolveState(id, session.frame)),
        cloudCount: session.currentPointCloud()?.count ?? 0, referenceCount: session.currentPointCloud()?.cameraReferences?.length ?? 0,
        cameras: [...session.projectors].map(([id, projector]) => ({ id, image: Boolean(session.currentCameraImage(id)), poseTime: session.cameraPoseTime(id), boxes: projector.sourceBoxes?.(session.frame) ?? [] })) },
      interaction: { selection: session.selection.all(), tool: session.tools.activeTool, gesture: session.tools.state.name,
        canUndo: session.history.canUndo, canRedo: session.history.canRedo },
      persistence: { status: session.saveStatus, revision: session.documentRevision, savedRevision: session.savedRevision },
      resources: session.bufferStats(), review: session.qa,
    });
  } };
  const win = window as unknown as { __LABELFASTER_TEST__?: typeof probe };
  win.__LABELFASTER_TEST__ = probe;
  return () => { if (win.__LABELFASTER_TEST__ === probe) delete win.__LABELFASTER_TEST__; };
}

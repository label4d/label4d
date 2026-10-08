import { useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Pause, Play, RotateCcw } from 'lucide-react';
import { useSession, useSessionTick } from '../session/SessionProvider';

export function PlaybackBar() {
  const session = useSession();
  useSessionTick(['frameChanged', 'manifestLoaded', 'storeChanged', 'frameStatusChanged', 'playbackChanged']);
  const cancelled = useRef(false);
  const [frameText, setFrameText] = useState<string | null>(null); const [, refresh] = useState(0);
  const ds = session.datasetStats();
  const commit = () => { if (!cancelled.current && frameText?.trim()) { const n = Number(frameText); if (Number.isSafeInteger(n)) session.setFrame(Math.max(0, Math.min(session.frameCount - 1, n))); } cancelled.current = false; setFrameText(null); };
  return <footer className="playback-bar">
    <div className="transport-controls">
      <button className="icon-button" aria-label="第一帧" disabled={session.requestedFrame === 0} onClick={() => session.setFrame(0)}><ChevronsLeft size={17} /></button>
      <button className="icon-button" aria-label="上一帧" title="上一帧 [" disabled={session.requestedFrame === 0} onClick={() => session.setFrame(session.requestedFrame - 1)}><ChevronLeft size={17} /></button>
      <button className="play-button" aria-label={session.playhead.playing ? '暂停' : '播放'} title="播放 / 暂停 Space" onClick={() => session.playhead.playing ? session.pause() : session.play()}>{session.playhead.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}<span>{session.playhead.playing ? '暂停' : '播放'}</span></button>
      <button className="icon-button" aria-label="下一帧" title="下一帧 ]" disabled={session.requestedFrame === session.frameCount - 1} onClick={() => session.setFrame(session.requestedFrame + 1)}><ChevronRight size={17} /></button>
      <button className="icon-button" aria-label="最后一帧" disabled={session.requestedFrame === session.frameCount - 1} onClick={() => session.setFrame(session.frameCount - 1)}><ChevronsRight size={17} /></button>
      <select aria-label="播放速度" value={session.playhead.speed} onChange={(e) => { session.playhead.speed = Number(e.target.value); refresh((n) => n + 1); }}>{[0.25, 0.5, 1, 2, 4].map((s) => <option key={s} value={s}>{s}×</option>)}</select>
    </div>
    <label className="frame-entry"><span>帧</span><input aria-label="跳转到帧" type="number" min={0} max={session.frameCount - 1} value={frameText ?? session.requestedFrame} onChange={(e) => setFrameText(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { cancelled.current = true; setFrameText(null); e.currentTarget.blur(); } }} /><span>/ {session.frameCount - 1}</span></label>
    <input aria-label="序列帧进度" type="range" min={0} max={session.frameCount - 1} value={session.requestedFrame} className="frame-scrubber" onChange={(e) => session.setFrame(Number(e.target.value))} />
    <span className={`frame-readiness ${session.frameStatus !== 'ready' ? 'is-loading' : ''}`}>
      {session.frameStatus === 'ready' ? `${session.playhead.timeAt(session.frame).toFixed(2)} s` : `呈现 ${session.frame} · ${session.frameStatus === 'error' ? '加载失败' : '加载中'}`}
    </span>
    {session.frameStatus === 'error' && <button className="icon-button" aria-label="重试帧" onClick={() => session.retryFrame()}><RotateCcw size={16} /></button>}
    <div className="coverage-indicator" title={`已有标注的帧占比，不代表已复核；${ds.keyframes} 个关键帧`}><span className="coverage-meter"><i style={{ width: `${ds.coverage * 100}%` }} /></span><span>覆盖 {(ds.coverage * 100).toFixed(0)}%</span><span className="muted">{ds.trackCount} 轨迹</span></div>
  </footer>;
}

import { useSession, useSessionTick } from '../session/SessionProvider';

export function PlaybackBar() {
  const session = useSession();
  useSessionTick(['frameChanged', 'manifestLoaded', 'storeChanged']);
  const stats = session.bufferStats();
  const ds = session.datasetStats();

  return (
    <div className="flex items-center gap-3 border-t border-[#1d2530] bg-[#0e1218] px-3 py-1.5 text-xs text-slate-300">
      <button className="btn" onClick={() => session.setFrame(0)} title="第一帧">⏮</button>
      <button className="btn" onClick={() => session.setFrame(session.frame - 1)} title="上一帧">◀</button>
      <button
        className="rounded bg-[#2b6cff] px-3 py-1 font-medium text-white hover:bg-[#3d7bff]"
        onClick={() => (session.playhead.playing ? session.pause() : session.play())}
      >
        {session.playhead.playing ? '⏸ 暂停' : '▶ 播放'}
      </button>
      <button className="btn" onClick={() => session.setFrame(session.frame + 1)} title="下一帧">▶|</button>
      <button className="btn" onClick={() => session.setFrame(session.frameCount - 1)} title="最后一帧">⏭</button>

      <select
        className="rounded bg-[#1d2530] px-1 py-1 outline-none"
        value={session.playhead.speed}
        onChange={(e) => {
          session.playhead.speed = Number(e.target.value);
        }}
      >
        {[0.25, 0.5, 1, 2, 4].map((s) => (
          <option key={s} value={s}>{s}x</option>
        ))}
      </select>

      <span className="tabular-nums">
        frame <b className="text-white">{session.frame}</b> / {session.frameCount - 1}
      </span>
      <input
        type="range"
        min={0}
        max={session.frameCount - 1}
        value={session.frame}
        className="flex-1 accent-[#2b6cff]"
        onChange={(e) => session.setFrame(Number(e.target.value))}
      />
      <span className="text-[10px] text-emerald-400" title="标注进度：有标注的帧占比 / 关键帧总数 / 轨迹数">
        覆盖 {(ds.coverage * 100).toFixed(0)}% · {ds.keyframes} 关键帧 · {ds.trackCount} 轨迹
      </span>
      <span className="text-[10px] text-slate-500" title="点云帧缓冲 / 调度器状态">
        pcd {stats.pcd ? `${stats.pcd.cached}f` : '—'} · queue {stats.scheduler.queued + stats.scheduler.running} · evict {stats.scheduler.evictions}
      </span>
    </div>
  );
}

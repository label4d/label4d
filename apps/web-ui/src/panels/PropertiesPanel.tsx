import { useState } from 'react';
import { useSession, useSessionTick } from '../session/SessionProvider';
import { SetKeyframeCommand, SetTrackMetaCommand, UpdateGeometryCommand } from '@labelfaster/core';
import type { AttributeDef, GeometryKind, KeyframeState } from '@labelfaster/core';

function NumberField(props: { label: string; value: number; step?: number; onCommit: (v: number) => void }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <label className="flex items-center justify-between gap-1 py-0.5">
      <span className="text-[10px] text-slate-500">{props.label}</span>
      <input
        type="number"
        step={props.step ?? 0.1}
        className="w-20 rounded bg-[#1d2530] px-1 py-0.5 text-[11px] text-slate-200 outline-none focus:ring-1 focus:ring-[#2b6cff]"
        value={text ?? props.value.toFixed(2)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== null) {
            const v = Number(text);
            if (Number.isFinite(v)) props.onCommit(v);
            setText(null);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        }}
      />
    </label>
  );
}

function AttributeRow(props: { def: AttributeDef; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void }) {
  const { def, value, onChange } = props;
  if (def.type === 'enum') {
    return (
      <label className="flex items-center justify-between gap-1 py-0.5">
        <span className="text-[10px] text-slate-500">{def.key}{def.perFrame ? ' ⏱' : ''}</span>
        <select
          className="w-24 rounded bg-[#1d2530] px-1 py-0.5 text-[11px] text-slate-200 outline-none"
          value={String(value ?? def.default ?? def.options?.[0] ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {def.options?.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }
  if (def.type === 'bool') {
    return (
      <label className="flex items-center justify-between gap-1 py-0.5">
        <span className="text-[10px] text-slate-500">{def.key}{def.perFrame ? ' ⏱' : ''}</span>
        <input
          type="checkbox"
          checked={Boolean(value ?? def.default ?? false)}
          onChange={(e) => onChange(e.target.checked)}
        />
      </label>
    );
  }
  return (
    <label className="flex items-center justify-between gap-1 py-0.5">
      <span className="text-[10px] text-slate-500">{def.key}{def.perFrame ? ' ⏱' : ''}</span>
      <input
        type={def.type === 'number' ? 'number' : 'text'}
        className="w-24 rounded bg-[#1d2530] px-1 py-0.5 text-[11px] text-slate-200 outline-none"
        value={String(value ?? def.default ?? '')}
        onChange={(e) => onChange(def.type === 'number' ? Number(e.target.value) : e.target.value)}
      />
    </label>
  );
}

export function PropertiesPanel() {
  const session = useSession();
  useSessionTick(['storeChanged', 'selectionChanged', 'frameChanged']);
  const [copyFrame, setCopyFrame] = useState('');

  const selected = session.selection.all();
  const first = selected[0] ?? null;
  const track = first ? session.store.getTrack(first) : undefined;
  const geometry = first && !track ? session.store.getGeometry(first) : undefined;
  const frame = session.frame;

  if (!first) {
    return (
      <div className="flex-1 px-3 py-2 text-[11px] text-slate-600">
        未选中对象。视图内点击选择；工具栏切换绘制工具。
      </div>
    );
  }

  if (track) {
    const state = session.store.resolveState(track.meta.id, frame);
    const labelDef = session.labels.find((l) => l.name === track.meta.label);
    const frameAttrs = session.store.getFrameAttributes(track.meta.id, frame) ?? {};
    const kf = session.store.getKeyframes(track.meta.id);
  // speed derived from neighbouring keyframes
  const speedInfo = (() => {
    if (!track) return null;
    const kf = session.store.getKeyframes(track.meta.id);
    if (!kf || kf.frames.length === 0) return null;
    const fps = session.playhead.fps || 10;
    let pa = -1, pb = -1;
    let lo = 0;
    const k = kf.frames.length;
    while (lo < k && kf.frames[lo] <= frame) lo++;
    pb = Math.min(k - 1, lo);
    pa = Math.max(0, lo - 1);
    if (pa === pb) return null;
    const dt = (kf.frames[pb] - kf.frames[pa]) / fps;
    if (dt <= 0) return null;
    const dx = kf.pos[pb * 3] - kf.pos[pa * 3];
    const dz = kf.pos[pb * 3 + 2] - kf.pos[pa * 3 + 2];
    const dy = kf.pos[pb * 3 + 1] - kf.pos[pa * 3 + 1];
    const speed = Math.hypot(dx, dy, dz) / dt;
    const dirDeg = (Math.atan2(-dz, dx) * 180) / Math.PI;
    return { speed, dirDeg };
  })();

  return (
    <div className="flex-1 overflow-y-auto px-3 py-2 text-[11px] text-slate-300">
      <div className="mb-1 flex items-center gap-2">
        <b className="text-white">{track.meta.label}·{track.meta.id.slice(-4)}</b>
          {track.meta.source === 'model' && (
            <span className="rounded bg-amber-500/20 px-1 text-[9px] text-amber-400">
              AI {track.meta.confidence?.toFixed(2)}
            </span>
          )}
          {state?.atKeyframe && <span className="rounded bg-sky-500/20 px-1 text-[9px] text-sky-300">关键帧</span>}
        </div>

        <label className="flex items-center justify-between py-0.5">
          <span className="text-[10px] text-slate-500">类别</span>
          <select
            className="w-24 rounded bg-[#1d2530] px-1 py-0.5 text-[11px] outline-none"
            value={track.meta.label}
            onChange={(e) => session.history.push(new SetTrackMetaCommand(session.store, track.meta.id, { label: e.target.value }))}
          >
            {session.labels.filter((l) => l.dynamic).map((l) => (
              <option key={l.name} value={l.name}>{l.name}</option>
            ))}
          </select>
        </label>

        <div className="mt-2 mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">位姿 @ frame {frame}</div>
        {state ? (
          <>
            <div className="grid grid-cols-2 gap-x-3">
              <NumberField label="x" value={state.pos.x} onCommit={(v) => commitState({ x: v, y: state.pos.y, z: state.pos.z })} />
              <NumberField label="y" value={state.pos.y} onCommit={(v) => commitState({ x: state.pos.x, y: v, z: state.pos.z })} />
              <NumberField label="z" value={state.pos.z} onCommit={(v) => commitState({ x: state.pos.x, y: state.pos.y, z: v })} />
              <NumberField
                label="yaw°"
                step={1}
                value={(state.yaw * 180) / Math.PI}
                onCommit={(v) => commitState(undefined, (v * Math.PI) / 180)}
              />
              <NumberField label="长" value={state.size.x} onCommit={(v) => commitSize({ x: v, y: state.size.y, z: state.size.z })} />
              <NumberField label="高" value={state.size.y} onCommit={(v) => commitSize({ x: state.size.x, y: v, z: state.size.z })} />
              <NumberField label="宽" value={state.size.z} onCommit={(v) => commitSize({ x: state.size.x, y: state.size.y, z: v })} />
            </div>
            {speedInfo && (
              <div className="mt-1 text-[10px] text-emerald-400" title="由相邻关键帧差分；通过编辑关键帧位置改变速度">
                速度 {speedInfo.speed.toFixed(2)} m/s（方向 {((speedInfo.dirDeg + 360) % 360).toFixed(0)}°）
              </div>
            )}
          </>
        ) : (
          <div className="text-[10px] text-slate-600">当前帧不在轨迹存在区间内</div>
        )}

        <div className="mt-2 flex flex-wrap gap-1">
          <button className="btn" onClick={() => session.setKeyframeAtCurrentFrame(track.meta.id)}>设关键帧 (K)</button>
          <button className="btn" onClick={() => session.removeKeyframeAtCurrentFrame(track.meta.id)}>删关键帧</button>
          <input
            className="w-14 rounded bg-[#1d2530] px-1 py-1 text-[10px] outline-none"
            placeholder="帧"
            value={copyFrame}
            onChange={(e) => setCopyFrame(e.target.value)}
          />
          <button
            className="btn"
            onClick={() => {
              const target = Number(copyFrame);
              if (Number.isFinite(target)) session.copyStateToFrame(track.meta.id, target);
            }}
          >
            拷贝状态到帧
          </button>
          <button className="btn" onClick={() => session.splitSelectedAtCurrentFrame()}>拆分</button>
          <button className="btn disabled:opacity-40" disabled={selected.length < 2} onClick={() => session.mergeSelectedTracks()}>合并</button>
          <button className="btn" onClick={() => session.duplicateSelection()} title="复制选中轨迹并偏移 2m">复制轨迹</button>
          <button className="rounded bg-[#7a2430] px-2 py-1 text-rose-200 hover:bg-[#952c3c]" onClick={() => session.deleteSelection()}>删除 (Del)</button>
        </div>

        <div className="mt-1 text-[10px] text-slate-500">
          关键帧 {kf?.frames.length ?? 0} 个 · 区间 [{track.meta.startFrame}, {track.meta.endFrame}]
        </div>

        {labelDef?.attributeSchema?.length ? (
          <>
            <div className="mt-2 mb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">属性</div>
            {labelDef.attributeSchema.map((def) =>
              def.perFrame ? (
                <AttributeRow
                  key={def.key}
                  def={def}
                  value={frameAttrs[def.key]}
                  onChange={(v) => session.setFrameAttribute(track.meta.id, def.key, v)}
                />
              ) : (
                <AttributeRow
                  key={def.key}
                  def={def}
                  value={track.meta.attributes[def.key]}
                  onChange={(v) => session.setTrackAttribute(track.meta.id, def.key, v)}
                />
              )
            )}
          </>
        ) : null}
      </div>
    );
  }

  if (geometry) {
    return (
      <div className="flex-1 overflow-y-auto px-3 py-2 text-[11px] text-slate-300">
        <div className="mb-1"><b className="text-white">{geometry.meta.kind}·{geometry.meta.id.slice(-4)}</b></div>
        <div className="text-[10px] text-slate-500">顶点 {geometry.vertices.length / 3} 个 · 闭合 {geometry.meta.closed ? '是' : '否'}</div>
        <div className="mt-2 flex gap-1">
          <select
            className="rounded bg-[#1d2530] px-1 py-0.5 text-[11px] outline-none"
            value={geometry.meta.kind}
            onChange={(e) =>
              session.history.push(
                new UpdateGeometryCommand(session.store, geometry.meta.id, undefined, {
                  kind: e.target.value as GeometryKind,
                  label: e.target.value,
                })
              )
            }
          >
            {session.labels.filter((l) => !l.dynamic).map((l) => (
              <option key={l.name} value={l.name.toLowerCase()}>{l.name}</option>
            ))}
          </select>
          <button className="rounded bg-[#7a2430] px-2 py-1 text-rose-200 hover:bg-[#952c3c]" onClick={() => session.deleteSelection()}>删除</button>
        </div>
      </div>
    );
  }

  return <div className="flex-1 px-3 py-2 text-[11px] text-slate-600">选中 {selected.length} 个对象</div>;

  function commitState(pos?: { x: number; y: number; z: number }, yaw?: number) {
    if (!track) return;
    const current = session.store.resolveState(track.meta.id, frame);
    if (!current) return;
    pushKeyframe({ pos: pos ?? current.pos, yaw: yaw ?? current.yaw, size: current.size });
  }

  function commitSize(size: { x: number; y: number; z: number }) {
    if (!track) return;
    const current = session.store.resolveState(track.meta.id, frame);
    if (!current) return;
    pushKeyframe({ pos: current.pos, yaw: current.yaw, size });
  }

  function pushKeyframe(state: KeyframeState) {
    if (!track) return;
    session.history.push(new SetKeyframeCommand(session.store, track.meta.id, frame, state));
  }
}

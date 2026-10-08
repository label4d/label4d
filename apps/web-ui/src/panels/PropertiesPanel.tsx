import { useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, Box, Copy, Diamond, MousePointer2, Plus, Scissors, Trash2 } from 'lucide-react';
import { useSession, useSessionTick } from '../session/SessionProvider';
import type { AttributeDef, GeometryKind, KeyframeState } from '@labelfaster/core';

function NumberField({ label, value, step = 0.1, min, unit, onCommit }: {
  label: string; value: number; step?: number; min?: number; unit?: string; onCommit: (v: number) => void;
}) {
  const [text, setText] = useState<string | null>(null); const cancel = useRef(false);
  return <label className="number-field"><span>{label}</span><div>
    <input type="number" step={step} min={min} aria-label={label} value={text ?? value.toFixed(2)}
      onChange={(e) => setText(e.target.value)} onBlur={() => {
        if (!cancel.current && text !== null && text.trim() !== '') { const v = Number(text); if (Number.isFinite(v) && (min === undefined || v >= min) && v !== value) onCommit(v); }
        cancel.current = false; setText(null);
      }} onKeyDown={(e) => { if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur(); } else if (e.key === 'Enter') e.currentTarget.blur(); }} />
    {unit && <small>{unit}</small>}
  </div></label>;
}
function AttributeRow({ def, value, onChange }: { def: AttributeDef; value: string | number | boolean | undefined; onChange: (v: string | number | boolean) => void }) {
  const [text, setText] = useState<string | null>(null); const cancel = useRef(false);
  if (def.type === 'number') return <NumberField label={def.key} value={Number(value ?? def.default ?? 0)} onCommit={onChange} />;
  return <label className="attribute-row"><span>{def.key}{def.perFrame && <small>当前帧</small>}</span>
    {def.type === 'enum' ? <select value={String(value ?? def.default ?? def.options?.[0] ?? '')} onChange={(e) => onChange(e.target.value)}>{def.options?.map((option) => <option key={option}>{option}</option>)}</select>
      : def.type === 'bool' ? <input type="checkbox" checked={Boolean(value ?? def.default ?? false)} onChange={(e) => onChange(e.target.checked)} />
      : <input type="text" value={text ?? String(value ?? def.default ?? '')} onChange={(e) => setText(e.target.value)} onBlur={() => { if (!cancel.current && text !== null && text !== String(value ?? def.default ?? '')) onChange(text); cancel.current = false; setText(null); }} onKeyDown={(e) => { if (e.key === 'Escape') { cancel.current = true; e.currentTarget.blur(); } else if (e.key === 'Enter') e.currentTarget.blur(); }} />}
  </label>;
}

export function PropertiesPanel() {
  const session = useSession();
  useSessionTick(['storeChanged', 'selectionChanged', 'frameChanged', 'saveChanged', 'frameStatusChanged']);
  const [copyFrame, setCopyFrame] = useState('');
  const selected = session.selection.all(); const first = selected[0];
  const track = first ? session.store.getTrack(first) : undefined;
  const geometry = first && !track ? session.store.getGeometry(first) : undefined;
  const frame = session.frame;
  const safe = (fn: () => void) => { try { fn(); } catch (error) { session.events.emit('error', { message: String(error) }); } };
  if (!first) return <div className="inspector-empty"><MousePointer2 size={28} strokeWidth={1.3} /><h3>选择一个对象</h3><p>点击视图或对象列表，查看位姿、关键帧与属性。</p><span>Shift 点击可多选</span></div>;
  if (selected.length > 1) return <fieldset className="properties-panel" disabled={!session.canEdit}>
    <div className="property-identity"><Box size={18} /><h2>已选择 {selected.length} 个对象</h2></div>
    <p className="property-note">批量操作支持复制和删除；相邻、同类别且元数据兼容的轨迹可合并。</p>
    <div className="property-actions"><button className="btn" onClick={() => safe(() => session.duplicateSelection())}><Copy size={14} />复制轨迹</button><button className="btn" disabled={!selected.every((id) => session.store.getTrack(id))} onClick={() => safe(() => session.mergeSelectedTracks())}>合并轨迹</button><button className="btn btn-danger" onClick={() => safe(() => session.deleteSelection())}><Trash2 size={14} />删除选中对象</button></div>
  </fieldset>;
  if (track) {
    const state = session.store.resolveState(track.meta.id, frame); const kf = track.kf;
    const before = [...kf.frames].filter((f) => f < frame); const previous = before[before.length - 1]; const next = [...kf.frames].find((f) => f > frame);
    const labelDef = session.labels.find((l) => l.name === track.meta.label);
    const frameAttrs = session.store.getFrameAttributes(track.meta.id, frame) ?? {};
    const copyTarget = Number(copyFrame); const copyValid = copyFrame.trim() !== '' && Number.isSafeInteger(copyTarget) && copyTarget >= 0 && copyTarget < session.frameCount;
    const commit = (patch: Partial<KeyframeState>) => { if (state) safe(() => session.editKeyframe(track.meta.id, frame, { pos: state.pos, size: state.size, yaw: state.yaw, ...patch })); };
    if (session.readOnly) return <section className="properties-panel" key={track.meta.id}>
      <div className="property-identity"><Box size={18} /><h2>{track.meta.label}<span>#{track.meta.id.slice(-4)}</span></h2><span className="state-chip">源观测</span></div>
      <p className="property-note">完整姿态 · 只读 · 缺失帧不插值</p>
      {state ? <section className="property-section"><div className="property-section-heading"><h3>帧 {frame} · {session.playhead.timeAt(frame).toFixed(3)} s</h3></div>
        <p className="property-note">中心 XYZ · m</p><p>{[state.pos.x,state.pos.y,state.pos.z].map((v) => v.toFixed(3)).join(' / ')}</p>
        <p className="property-note">长 / 高 / 宽 · m</p><p>{[state.size.x,state.size.y,state.size.z].map((v) => v.toFixed(3)).join(' / ')}</p>
        <p className="property-note">box → world · 完整旋转矩阵</p>
        <pre aria-label="源框旋转矩阵">{[0,1,2].map((r) => [0,1,2].map((c) => state.boxToWorld![c*4+r].toFixed(4)).join('  ')).join('\n')}</pre>
      </section> : <p className="property-note">当前帧没有源观测，请跳转到观测帧。</p>}
      <section className="property-section"><h3>实际观测 · {kf.frames.length} 帧</h3>
        <div className="keyframe-actions"><button className="icon-button" aria-label="上一个观测帧" disabled={previous === undefined} onClick={() => previous !== undefined && session.setFrame(previous)}><ArrowLeft size={16} /></button><button className="icon-button" aria-label="下一个观测帧" disabled={next === undefined} onClick={() => next !== undefined && session.setFrame(next)}><ArrowRight size={16} /></button></div>
        <div className="keyframe-chips" aria-label="观测帧跳转">{[...kf.frames].map((f) => <button key={f} className={f === frame ? 'is-current' : ''} onClick={() => session.setFrame(f)}>{f}</button>)}</div>
      </section>
    </section>;
    return <fieldset disabled={!session.canEdit} className="properties-panel" key={track.meta.id}>
      <div className="property-identity"><Box size={18} /><h2>{track.meta.label}<span>#{track.meta.id.slice(-4)}</span></h2><span className={`state-chip ${state?.atKeyframe ? 'keyframe' : ''}`}>{state?.atKeyframe ? '关键帧' : '插值帧'}</span></div>
      {track.meta.source === 'model' && <p className="property-note">模型候选 · 置信度 {track.meta.confidence?.toFixed(2) ?? '未提供'}</p>}
      <label className="attribute-row"><span>对象类别</span><select aria-label="类别" value={track.meta.label} onChange={(e) => safe(() => session.setTrackMeta(track.meta.id, { label: e.target.value }))}>{session.labels.filter((l) => l.dynamic).map((l) => <option key={l.name}>{l.name}</option>)}</select></label>
      <section key={`${track.meta.id}:${frame}`} className="property-section"><div className="property-section-heading"><h3>当前帧位姿</h3><span className="scope-label">帧 {frame}</span></div>
        <p className="property-note">修改会在当前帧设置关键帧</p>
        {state ? <>
          <div className="field-group"><span className="field-group-label">位置 · m</span><div className="number-grid">
            <NumberField label="x" value={state.pos.x} onCommit={(v) => commit({ pos: { ...state.pos, x: v } })} />
            <NumberField label="y" value={state.pos.y} onCommit={(v) => commit({ pos: { ...state.pos, y: v } })} />
            <NumberField label="z" value={state.pos.z} onCommit={(v) => commit({ pos: { ...state.pos, z: v } })} />
          </div></div>
          <div className="field-group"><span className="field-group-label">尺寸 · m</span><div className="number-grid">
            <NumberField label="长" min={0.01} value={state.size.x} onCommit={(v) => commit({ size: { ...state.size, x: v } })} />
            <NumberField label="宽" min={0.01} value={state.size.z} onCommit={(v) => commit({ size: { ...state.size, z: v } })} />
            <NumberField label="高" min={0.01} value={state.size.y} onCommit={(v) => commit({ size: { ...state.size, y: v } })} />
          </div></div>
          <div className="yaw-field"><span>朝向</span><NumberField label="yaw°" unit="°" step={1} value={state.yaw * 180 / Math.PI} onCommit={(v) => commit({ yaw: v * Math.PI / 180 })} /></div>
        </> : <p className="property-note">当前帧不在存在区间内，请跳转到有效关键帧。</p>}
      </section>
      <section className="property-section"><div className="property-section-heading"><h3>关键帧</h3><span className="muted">{kf.frames.length} 个</span></div>
        <div className="keyframe-actions"><button className="icon-button" aria-label="上一个关键帧" disabled={previous === undefined} title={`上一个关键帧 ${previous ?? ''}`} onClick={() => previous !== undefined && session.setFrame(previous)}><ArrowLeft size={16} /></button>
          <button className="btn keyframe-button" disabled={!state || state.atKeyframe} onClick={() => safe(() => session.setKeyframeAtCurrentFrame(track.meta.id))}><Plus size={14} />设关键帧 <kbd>K</kbd></button>
          <button className="icon-button" aria-label="下一个关键帧" disabled={next === undefined} title={`下一个关键帧 ${next ?? ''}`} onClick={() => next !== undefined && session.setFrame(next)}><ArrowRight size={16} /></button>
          <button className="icon-button danger-text" aria-label="删除当前关键帧" title="删除当前关键帧" disabled={!state?.atKeyframe || kf.frames.length <= 1} onClick={() => safe(() => session.removeKeyframeAtCurrentFrame(track.meta.id))}><Trash2 size={15} /></button>
        </div>
        <div className="keyframe-chips" aria-label="关键帧跳转">{[...kf.frames].map((f) => <button key={f} className={f === frame ? 'is-current' : ''} aria-label={`跳转到关键帧 ${f}`} aria-current={f === frame ? 'step' : undefined} onClick={() => session.setFrame(f)}><Diamond size={9} fill={f === frame ? 'currentColor' : 'none'} />{f}</button>)}</div>
        <label className="attribute-row"><span>插值方式</span><select aria-label="插值方式" value={track.meta.interpolation} onChange={(e) => safe(() => session.setTrackMeta(track.meta.id, { interpolation: e.target.value as 'linear' | 'hold' }))}><option value="linear">线性插值</option><option value="hold">保持前帧</option></select></label>
        <div className="property-range"><span>存在区间</span><span>{track.meta.startFrame} — {track.meta.endFrame}</span></div>
        <div className="copy-frame-row"><input aria-label="复制状态的目标帧" placeholder="目标帧" type="number" min={0} max={session.frameCount - 1} value={copyFrame} onChange={(e) => setCopyFrame(e.target.value)} /><button className="btn" disabled={!copyValid || !state} onClick={() => safe(() => session.copyStateToFrame(track.meta.id, copyTarget))}><Copy size={13} />拷贝状态到帧</button></div>
      </section>
      {labelDef?.attributeSchema?.length ? <section className="property-section"><div className="property-section-heading"><h3>对象属性</h3></div>{labelDef.attributeSchema.map((def) => <AttributeRow key={`${track.meta.id}:${def.key}:${frame}`} def={def} value={def.perFrame ? frameAttrs[def.key] : track.meta.attributes[def.key]} onChange={(v) => safe(() => def.perFrame ? session.setFrameAttribute(track.meta.id, def.key, v) : session.setTrackAttribute(track.meta.id, def.key, v))} />)}</section> : null}
      <section className="property-section property-actions"><button className="btn" disabled={frame <= track.meta.startFrame || frame > track.meta.endFrame} onClick={() => safe(() => session.splitSelectedAtCurrentFrame())}><Scissors size={14} />拆分</button><button className="btn" onClick={() => safe(() => session.duplicateSelection())}><Copy size={14} />复制轨迹</button><button className="btn btn-danger" onClick={() => safe(() => session.deleteSelection())}><Trash2 size={14} />删除</button></section>
    </fieldset>;
  }
  if (geometry) return <fieldset className="properties-panel" disabled={!session.canEdit}>
    <div className="property-identity"><h2>{geometry.meta.label}<span>#{geometry.meta.id.slice(-4)}</span></h2><span className="state-chip">几何元素</span></div>
    <section className="property-section"><div className="property-section-heading"><h3>几何信息</h3></div><label className="attribute-row"><span>元素类型</span><select aria-label="几何元素类型" value={geometry.meta.kind} onChange={(e) => safe(() => session.updateGeometry(geometry.meta.id, { kind: e.target.value as GeometryKind, label: e.target.value }))}>{session.labels.filter((l) => !l.dynamic).map((l) => <option key={l.name} value={l.name.toLowerCase()}>{l.name}</option>)}</select></label>
      <div className="property-range"><span>顶点</span><span>{geometry.vertices.length / 3} 个</span></div><div className="property-range"><span>闭合</span><span>{geometry.meta.closed ? '是' : '否'}</span></div>
      <p className="property-note">使用左侧顶点工具调整形状。</p><button className="btn" onClick={() => session.setTool('vertexEdit')}>编辑顶点 <kbd>5</kbd></button>
    </section><section className="property-section"><button className="btn btn-danger" onClick={() => safe(() => session.deleteSelection())}><Trash2 size={14} />删除几何</button></section>
  </fieldset>;
  return <div className="inspector-empty">当前对象已不存在，请重新选择。</div>;
}

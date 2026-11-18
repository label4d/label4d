import { useState } from 'react';
import { Box, ChevronDown, ChevronUp, Eye, EyeOff, Search, Spline, X } from 'lucide-react';
import { useSession, useSessionTick } from '../session/SessionProvider';
import { usePreference } from '../components/usePreference';
import { colorForLabel } from '@label4d/core';

export function ObjectList() {
  const session = useSession();
  useSessionTick(['frameChanged', 'storeChanged', 'selectionChanged', 'labelsChanged']);
  const [filter, setFilter] = useState('');
  const [open, setOpen] = usePreference('objectListOpen', true);
  const [kind, setKind] = useState<'all' | 'track' | 'geometry'>('all');
  const tracks = session.store.activeTrackIds(session.frame).map((id) => session.store.getTrack(id)!).map((record) => ({
    ...record.meta, geometry: false, atKeyframe: record.kf.frames.includes(session.frame),
  }));
  const geometries = session.store.listGeometries().filter((g) => g.meta.startFrame <= session.frame && g.meta.endFrame >= session.frame)
    .map((g) => ({ ...g.meta, geometry: true, source: 'human', atKeyframe: false }));
  const all = [...tracks, ...geometries];
  const active = all.filter((record) => (kind === 'all' || record.geometry === (kind === 'geometry')) &&
    (!filter || `${record.label} ${record.id}`.toLowerCase().includes(filter.toLowerCase())));
  return <section className="object-list" aria-label="当前帧对象">
    <div className="section-heading"><h2>当前帧对象 <span className="count-chip">{all.length}</span></h2><button className="icon-button object-collapse" aria-label={open ? '收起对象列表' : '展开对象列表'} aria-expanded={open} title="收起列表可为属性留出更多空间" onClick={() => setOpen((v) => !v)}>{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</button></div>
    {open && <>
    <div className="object-search"><Search size={14} /><input type="search" aria-label="搜索对象" placeholder="类别或对象 ID" value={filter} onChange={(e) => setFilter(e.target.value)} />{filter && <button className="icon-button" aria-label="清空对象搜索" onClick={() => setFilter('')}><X size={13} /></button>}</div>
    <div className="object-filters" role="group" aria-label="对象类型筛选">{(['all', 'track', 'geometry'] as const).map((value) => <button key={value} aria-pressed={kind === value} className={kind === value ? 'is-active' : ''} onClick={() => setKind(value)}>{value === 'all' ? '全部' : value === 'track' ? '轨迹' : '几何'}</button>)}<span>{active.length} 项</span></div>
    <div className="object-rows">
      {active.map((record) => {
        const selected = session.selection.has(record.id); const hidden = session.hiddenLabels.has(record.label);
        const Icon = record.geometry ? Spline : Box;
        return <div key={record.id} className={`object-row ${selected ? 'is-selected' : ''} ${hidden ? 'is-hidden' : ''}`}>
          <button className="object-select" aria-pressed={selected} title={`${record.id} · Shift 点击多选`} onClick={(e) => session.selection.select([record.id], e.shiftKey || e.metaKey || e.ctrlKey ? 'toggle' : 'replace')}>
            <Icon size={16} style={{ color: colorForLabel(session.labels, record.label) }} strokeWidth={1.7} />
            <span className="object-name">{record.label}<small>#{record.id.slice(-4)}</small></span>
            {record.source === 'model' && <span className="ai-chip">AI</span>}
            <span className={`keyframe-dot ${record.atKeyframe ? 'is-keyframe' : ''}`} title={session.readOnly ? '当前帧有源观测' : record.atKeyframe ? '当前帧为关键帧' : '当前帧为插值'}>◆</span>
            <span className="object-range" title={session.readOnly ? "首末观测帧；中间可能缺失" : "存在区间"}>{record.startFrame}–{record.endFrame}</span>
          </button>
          <button className="object-visibility icon-button" aria-label={`${hidden ? '显示' : '隐藏'} ${record.label} 类别`} title="按类别切换可见性" onClick={() => session.setLabelHidden(record.label, !hidden)}>{hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
        </div>;
      })}
      {active.length === 0 && <div className="empty-objects">{filter ? '没有匹配的对象' : kind === 'geometry' ? '当前帧还没有几何元素' : '当前帧还没有标注'}<small>{filter ? '尝试类别名称或 ID 的一部分' : '选择左侧工具，在主视图开始绘制'}</small></div>}
    </div>
    </>}
  </section>;
}

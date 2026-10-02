import { Box, Layers, Map, Maximize2, Minimize2, Orbit } from 'lucide-react';
import { useState } from 'react';
import { useSession, useSessionTick } from '../session/SessionProvider';
import { TOOLS } from './ToolRail';
import { Dropdown } from '../components/Dropdown';

export function ContextBar({ mode, onMode, focus, onFocus }: {
  mode: 'cloud' | 'bev'; onMode: (mode: 'cloud' | 'bev') => void; focus: boolean; onFocus: () => void;
}) {
  const session = useSession();
  useSessionTick(['toolChanged', 'labelsChanged', 'blinkChanged', 'frameStatusChanged']);
  const [, update] = useState(0); const [badges, setBadges] = useState(false);
  const tool = TOOLS.find((t) => t.id === session.tools.activeTool)!;
  const geometryTool = ['polyline', 'polygon', 'vertexEdit'].includes(tool.id);
  const creating = geometryTool || tool.id === 'box';
  let hint = tool.hint;
  if (session.tools.state.name === 'drawBox') hint = session.tools.state.stage === 'heading' ? '拖出朝向与长度，松开进入宽度步骤' : '继续拖动确定宽度，松开完成';
  if (session.frameStatus !== 'ready') hint = '正在加载目标帧，准备好后可继续编辑';
  return <div className="context-bar">
    <div className="view-tabs" role="group" aria-label="主视图">
      <button aria-label="4D 点云模式" aria-pressed={mode === 'cloud'} className={mode === 'cloud' ? 'is-active' : ''} onClick={() => onMode('cloud')}><Orbit size={16} /><span>4D 点云</span></button>
      <button aria-label="BEV 俯视模式" aria-pressed={mode === 'bev'} className={mode === 'bev' ? 'is-active' : ''} onClick={() => onMode('bev')}><Map size={16} /><span>BEV 俯视</span></button>
    </div>
    <div className="context-divider" />
    <div className="active-tool-label"><tool.icon size={15} /><span>{tool.label}</span></div>
    {tool.id === 'box' && <label className="context-label"><span>类别</span><select aria-label="动态类别" value={session.activeLabel} onChange={(e) => { session.activeLabel = e.target.value; update((n) => n + 1); }}>
      {session.labels.filter((l) => l.dynamic).map((l) => <option key={l.name}>{l.name}</option>)}
    </select></label>}
    {geometryTool && <label className="context-label"><span>元素</span><select aria-label="静态元素类型" value={session.activeGeometryKind} onChange={(e) => { session.activeGeometryKind = e.target.value as typeof session.activeGeometryKind; update((n) => n + 1); }}>
      {session.labels.filter((l) => !l.dynamic).map((l) => <option key={l.name} value={l.name.toLowerCase()}>{l.name}</option>)}
    </select></label>}
    {creating && <label className="ground-toggle" title="零平面适用于明确平坦的演示场景；否则使用高度数据"><input type="checkbox" aria-label="创建时使用零平面" checked={session.heightPolicy === 'zero-plane'} onChange={(e) => { session.heightPolicy = e.target.checked ? 'zero-plane' : 'terrain'; update((n) => n + 1); }} />零平面</label>}
    <span className="tool-hint">{hint}</span>
    <div className="context-actions">
      <Dropdown label="显示"><div className="menu-heading"><Layers size={14} /> 视图显示</div>
        <label className="menu-setting"><span>属性标签</span><input type="checkbox" checked={badges} onChange={(e) => { setBadges(e.target.checked); window.dispatchEvent(new CustomEvent('lf:badges', { detail: e.target.checked })); }} /></label>
        <label className="menu-setting"><span>类别高亮</span><select aria-label="闪烁高亮类别" value={session.blinkLabel ?? ''} onChange={(e) => session.setBlinkLabel(e.target.value || null)}><option value="">关闭</option>{session.labels.filter((l) => l.dynamic).map((l) => <option key={l.name}>{l.name}</option>)}</select></label>
        {session.labels.filter((l) => l.dynamic).map((label) => <label className="menu-setting" key={label.name}><span>{label.name}</span><input type="checkbox" aria-label={`显示 ${label.name}`} checked={!session.hiddenLabels.has(label.name)} onChange={(e) => session.setLabelHidden(label.name, !e.target.checked)} /></label>)}
        {session.hiddenLabels.size > 0 && <button className="menu-action" onClick={() => session.showAllLabels()}><Box size={15} />显示全部类别</button>}
      </Dropdown>
      <button className="icon-button" aria-label={focus ? '退出专注视图' : '专注主视图'} aria-pressed={focus} title={focus ? '恢复多视图 (F)' : '放大主视图 (F)'} onClick={onFocus}>{focus ? <Minimize2 size={17} /> : <Maximize2 size={17} />}</button>
    </div>
  </div>;
}

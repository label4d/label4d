import { MousePointer2, Box, Spline, Pentagon, ScanLine, Ruler, Keyboard, Undo2, Redo2 } from 'lucide-react';
import type { ToolId } from '@label4d/core';
import { useSession, useSessionTick } from '../session/SessionProvider';

export const TOOLS = [
  { id: 'select', label: '选择', hint: '点击选择 · 拖动平移对象 · Shift 框选', icon: MousePointer2 },
  { id: 'box', label: '3D框', hint: '先拖出朝向与长度，再拖出宽度', icon: Box },
  { id: 'polyline', label: '折线', hint: '点击添加顶点，双击结束', icon: Spline },
  { id: 'polygon', label: '多边形', hint: '点击添加顶点，双击闭合', icon: Pentagon },
  { id: 'vertexEdit', label: '顶点', hint: '选中几何，拖动顶点调整', icon: ScanLine },
  { id: 'measure', label: '测量', hint: '点击两点测量距离', icon: Ruler },
] satisfies Array<{ id: ToolId; label: string; hint: string; icon: typeof Box }>;

export function ToolRail({ onHelp }: { onHelp: () => void }) {
  const session = useSession();
  useSessionTick(['manifestLoaded', 'toolChanged', 'historyChanged', 'saveChanged', 'frameStatusChanged']);
  return <nav className="tool-rail" aria-label="标注工具">
    <div className="rail-tools">{TOOLS.map((tool, index) => <button key={tool.id}
      className={`rail-tool ${session.tools.activeTool === tool.id ? 'is-active' : ''}`}
      disabled={session.readOnly && tool.id !== 'select' && tool.id !== 'measure'}
      aria-label={tool.label} aria-pressed={session.tools.activeTool === tool.id}
      title={`${tool.label} · ${tool.hint} (${index + 1})`} onClick={() => session.setTool(tool.id)}>
      <tool.icon size={20} strokeWidth={1.6} /><span>{tool.label}</span><small>{index + 1}</small>
    </button>)}</div>
    <div className="rail-history">
      <button className="icon-button" aria-label="↩ 撤销" title="撤销 Ctrl/⌘ Z" disabled={!session.history.canUndo || !session.canEdit} onClick={() => session.undo()}><Undo2 size={19} /></button>
      <button className="icon-button" aria-label="↪ 重做" title="重做 Ctrl/⌘ Shift Z" disabled={!session.history.canRedo || !session.canEdit} onClick={() => session.redo()}><Redo2 size={19} /></button>
    </div>
    <button className="rail-help icon-button" aria-label="快捷键帮助" title="快捷键 (?)" onClick={onHelp}><Keyboard size={20} /></button>
  </nav>;
}

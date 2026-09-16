import { useRef, useState } from 'react';
import { useSession, useSessionTick } from '../session/SessionProvider';
import { DemoAssistAdapter } from '../lib/demo';
import type { SnapshotDocument, ToolId } from '@labelfaster/core';

const TOOLS: Array<{ id: ToolId; label: string; hint: string }> = [
  { id: 'select', label: '选择', hint: '选择/框选/拖动 (1)' },
  { id: 'box', label: '3D框', hint: '两段拖拽绘制 3D 框：先朝向+长，再宽 (2)' },
  { id: 'polyline', label: '折线', hint: '车道线等，双击结束 (3)' },
  { id: 'polygon', label: '多边形', hint: '人行横道等，双击结束 (4)' },
  { id: 'vertexEdit', label: '顶点', hint: '拖拽几何顶点 (5)' },
  { id: 'measure', label: '测量', hint: '两点距离测量 (6)' },
];

export function Toolbar() {
  const session = useSession();
  useSessionTick(['toolChanged', 'historyChanged', 'manifestLoaded', 'storeChanged', 'labelsChanged', 'blinkChanged']);
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [showAllBadges, setShowAllBadges] = useState(false);

  const dynamicLabels = session.labels.filter((l) => l.dynamic);
  const staticLabels = session.labels.filter((l) => !l.dynamic);

  const download = (data: unknown, name: string) => {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-[#1d2530] bg-[#0e1218] px-3 py-1.5 text-xs">
      <span className="font-semibold text-white">Labelfaster 4D</span>

      <div className="mx-1 h-4 w-px bg-[#283242]" />

      {TOOLS.map((tool) => (
        <button
          key={tool.id}
          title={tool.hint}
          className={`rounded px-2 py-1 ${
            session.tools.activeTool === tool.id ? 'bg-[#2b6cff] text-white' : 'bg-[#1d2530] text-slate-300 hover:bg-[#283242]'
          }`}
          onClick={() => session.setTool(tool.id)}
        >
          {tool.label}
        </button>
      ))}

      <div className="mx-1 h-4 w-px bg-[#283242]" />

      <select
        className="rounded bg-[#1d2530] px-1 py-1 text-slate-300 outline-none"
        value={session.activeLabel}
        onChange={(e) => {
          session.activeLabel = e.target.value;
        }}
        title="动态类别"
      >
        {dynamicLabels.map((label) => (
          <option key={label.name} value={label.name}>{label.name}</option>
        ))}
      </select>
      <select
        className="rounded bg-[#1d2530] px-1 py-1 text-slate-300 outline-none"
        value={session.activeGeometryKind}
        onChange={(e) => {
          session.activeGeometryKind = e.target.value as typeof session.activeGeometryKind;
        }}
        title="静态元素类型"
      >
        {staticLabels.map((label) => (
          <option key={label.name} value={label.name.toLowerCase()}>{label.name}</option>
        ))}
      </select>

      <div className="mx-1 h-4 w-px bg-[#283242]" />

      <button
        className="btn disabled:opacity-40"
        disabled={!session.history.canUndo}
        onClick={() => session.undo()}
      >
        ↩ 撤销
      </button>
      <button
        className="btn disabled:opacity-40"
        disabled={!session.history.canRedo}
        onClick={() => session.redo()}
      >
        ↪ 重做
      </button>

      <label className="flex items-center gap-1 text-slate-400">
        <input
          type="checkbox"
          checked={showAllBadges}
          onChange={(e) => {
            setShowAllBadges(e.target.checked);
            window.dispatchEvent(new CustomEvent('lf:badges', { detail: e.target.checked }));
          }}
        />
        属性标签
      </label>

      <div className="mx-1 h-4 w-px bg-[#283242]" />

      {/* 闪烁高亮动效：按类别筛选并触发闪烁 */}
      <select
        className="rounded bg-[#1d2530] px-1 py-1 text-slate-300 outline-none"
        value={session.blinkLabel ?? ''}
        onChange={(e) => session.setBlinkLabel(e.target.value || null)}
        title="闪烁高亮类别"
      >
        <option value="">闪烁: 关</option>
        {dynamicLabels.map((label) => (
          <option key={label.name} value={label.name}>{label.name}</option>
        ))}
      </select>

      {session.hiddenLabels.size > 0 && (
        <button className="btn" onClick={() => session.showAllLabels()}>
          显示全部 ({session.hiddenLabels.size} 隐藏)
        </button>
      )}

      <div className="mx-1 h-4 w-px bg-[#283242]" />

      <button
        className="btn"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const imported = await session.runAssist(new DemoAssistAdapter(session.frameCount), 0.5);
          setBusy(false);
          window.alert(`模型辅助：导入 ${imported} 条候选轨迹（一个撤销步骤）`);
        }}
      >
        {busy ? '推理中…' : '模型预标注'}
      </button>
      <button
        className="btn"
        onClick={() => download(session.exportSnapshot(), `${session.manifest?.id ?? 'sequence'}.snapshot.json`)}
      >
        导出快照
      </button>
      <button
        className="btn"
        onClick={() => download(session.exportNuScenes({ sampleStep: 5 }), `${session.manifest?.id ?? 'sequence'}.nuscenes.json`)}
      >
        导出 nuScenes
      </button>
      <button className="btn" onClick={() => fileRef.current?.click()}>
        导入快照
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          try {
            session.importSnapshot(JSON.parse(await file.text()) as SnapshotDocument);
          } catch (error) {
            window.alert(`导入失败：${String(error)}`);
          }
        }}
      />

      <select
        className="ml-auto rounded bg-[#1d2530] px-1 py-1 text-slate-300 outline-none"
        value={session.qa.status}
        onChange={(e) => {
          session.qa = { ...session.qa, status: e.target.value as typeof session.qa.status };
        }}
        title="质检状态"
      >
        <option value="pending">QA: 待检</option>
        <option value="pass">QA: 通过</option>
        <option value="reject">QA: 驳回</option>
      </select>
    </div>
  );
}

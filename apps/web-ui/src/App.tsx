import { useEffect, useRef, useState } from 'react';
import { SessionProvider, useSession, useSessionTick } from './session/SessionProvider';
import { Toolbar } from './panels/Toolbar';
import { PlaybackBar } from './panels/PlaybackBar';
import { Timeline } from './panels/Timeline';
import { ObjectList } from './panels/ObjectList';
import { PropertiesPanel } from './panels/PropertiesPanel';
import { ThreeDView } from './views/ThreeDView';
import { BevView } from './views/BevView';
import { CameraView } from './views/CameraView';
import { ThreeViewStrip } from './views/ThreeViewStrip';
import { ContextBar } from './panels/ContextBar';
import { ToolRail } from './panels/ToolRail';
import { ResizeHandle } from './components/ResizeHandle';
import { usePreference } from './components/usePreference';
import { ChevronDown, ChevronUp, Crosshair, Keyboard, Radio, X } from 'lucide-react';
import type { CSSProperties } from 'react';

function Shortcuts({ onHelp, onFocus }: { onHelp: () => void; onFocus: () => void }) {
  const session = useSession();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.closest('dialog[open]') || target.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName))) return;
      if (e.key === ' ' && target?.closest('button,summary,[role=separator]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) session.redo();
        else session.undo();
        return;
      }
      switch (e.key) {
        case '?': e.preventDefault(); onHelp(); break;
        case 'f': case 'F': e.preventDefault(); onFocus(); break;
        case '[': e.preventDefault(); session.setFrame(session.requestedFrame - 1); break;
        case ']': e.preventDefault(); session.setFrame(session.requestedFrame + 1); break;
        case ' ':
          e.preventDefault();
          session.playhead.toggle();
          break;
        case 'Delete':
        case 'Backspace':
          session.deleteSelection();
          break;
        case 'Escape':
          session.tools.cancel();
          break;
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          e.preventDefault();
          // 有选中对象：方向键微调位置（Shift 加速）；无选中：逐帧浏览
          if (session.selection.size > 0) {
            const step = e.shiftKey ? 1.0 : 0.25;
            const delta =
              e.key === 'ArrowLeft' ? { x: -step, y: 0, z: 0 }
              : e.key === 'ArrowRight' ? { x: step, y: 0, z: 0 }
              : e.key === 'ArrowUp' ? { x: 0, y: 0, z: -step }
              : { x: 0, y: 0, z: step };
            session.nudgeSelection(delta);
          } else {
            const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
            if (dir !== 0) session.setFrame(session.requestedFrame + dir * (e.shiftKey ? 10 : 1));
          }
          break;
        }
        case '1':
          session.setTool('select');
          break;
        case '2':
          session.setTool('box');
          break;
        case '3':
          session.setTool('polyline');
          break;
        case '4':
          session.setTool('polygon');
          break;
        case '5':
          session.setTool('vertexEdit');
          break;
        case '6':
          session.setTool('measure');
          break;
        case 'k':
        case 'K':
          if (session.selection.first) session.setKeyframeAtCurrentFrame(session.selection.first);
          break;
        default:
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [session, onHelp, onFocus]);
  return null;
}

function SessionError() {
  const session = useSession();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => session.events.on('error', ({ message }) => setError(message)), [session]);
  return error ? <div role="alert" className="error-banner">
    <span><b>操作未完成</b> {error}</span><button className="icon-button" aria-label="关闭错误提示" onClick={() => setError(null)}><X size={16} /></button>
  </div> : null;
}

function ShortcutHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) ref.current?.showModal(); else ref.current?.close(); }, [open]);
  const shortcuts = [['1 — 6', '切换标注工具'], ['Space', '播放 / 暂停'], ['[ / ]', '上一帧 / 下一帧'], ['方向键', '微调选中对象；未选中时切帧'], ['Shift + 方向键', '加大微调步长；未选中时跳 10 帧'], ['K', '设置当前帧关键帧'], ['⌘ / Ctrl + Z', '撤销'], ['⌘ / Ctrl + Shift + Z', '重做'], ['Esc', '取消当前手势'], ['Delete', '删除选中对象'], ['F', '进入 / 退出专注视图'], ['?', '快捷键帮助']];
  return <dialog ref={ref} className="shortcut-dialog" aria-labelledby="shortcut-title" onCancel={onClose} onClose={onClose} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="dialog-title"><Keyboard size={20} /><h2 id="shortcut-title">让操作更快一点</h2><button className="icon-button" aria-label="关闭快捷键帮助" onClick={onClose}><X size={19} /></button></div>
    <p>点击对象后，方向键会移动对象。用方括号随时切换帧。</p>
    <dl className="shortcut-list">{shortcuts.map(([keys, description]) => <div key={keys}><dt>{description}</dt><dd><kbd>{keys}</kbd></dd></div>)}</dl>
    <div className="dialog-foot">修改自动保存在当前浏览器。交付或备份时请导出快照。</div>
  </dialog>;
}

function Workspace() {
  const session = useSession();
  useSessionTick(['manifestLoaded', 'selectionChanged', 'frameChanged', 'frameStatusChanged']);
  const [mode, setMode] = usePreference<'bev' | 'cloud'>('view', 'cloud');
  const [focus, setFocus] = useState(false);
  const [wide, setWide] = useState(() => window.innerWidth >= 960);
  useEffect(() => { const resize = () => setWide(window.innerWidth >= 960); window.addEventListener('resize', resize); return () => window.removeEventListener('resize', resize); }, []);
  const [help, setHelp] = useState(false);
  const [inspector, setInspector] = useState(() => window.innerWidth > 900);
  const [inspectorWidth, setInspectorWidth] = usePreference('inspectorWidth', 308);
  const [cameraHeight, setCameraHeight] = usePreference('cameraHeight', 158);
  const [timelineHeight, setTimelineHeight] = usePreference('timelineHeight', 88);
  const [timelineOpen, setTimelineOpen] = usePreference('timelineOpen', true);
  const cameraCount = session.projectors.size;
  const style = { '--inspector-width': `${Math.min(420, Math.max(280, inspectorWidth))}px`, '--camera-height': `${Math.min(320, Math.max(90, cameraHeight))}px` } as CSSProperties;
  const toggleFocus = () => setFocus((v) => !v);
  return <div className="app-workspace" style={style}>
    <Shortcuts onHelp={() => setHelp(true)} onFocus={toggleFocus} />
    <Toolbar onToggleInspector={() => setInspector((v) => !v)} inspectorOpen={inspector} />
    <SessionError />
    <div className={`workspace-body ${inspector ? 'inspector-open' : ''}`}>
      <ToolRail onHelp={() => setHelp(true)} />
      <main className={`view-workspace ${focus ? 'is-focused' : ''}`} aria-label="多视图标注工作区">
        <ContextBar mode={mode} onMode={setMode} focus={focus} onFocus={toggleFocus} />
        <div className="primary-views">
          <section className="primary-viewport" aria-label={mode === 'cloud' ? '点云主视图' : 'BEV 主视图'}>
            <div className="viewport-heading"><span><Crosshair size={14} />{mode === 'cloud' ? '空间视图' : '俯视视图'}</span><span className="viewport-meta">{focus ? '专注视图' : '世界坐标'}<span className={`live-dot ${session.frameStatus === 'ready' ? 'ready' : ''}`} />帧 {session.frame}</span></div>
            {mode === 'cloud' ? <ThreeDView /> : <BevView />}
          </section>
          {mode === 'cloud' && !focus && wide && <section className="orthographic-viewport" aria-label="正交三视图">
            <div className="viewport-heading"><span>正交三视图</span><span className="viewport-meta">{session.selection.size ? '跟随选择' : '请选择对象'}</span></div>
            <ThreeViewStrip />
          </section>}
        </div>
        {cameraCount > 0 && !focus && <>
          <div className="camera-divider"><ResizeHandle axis="y" value={cameraHeight} onChange={setCameraHeight} min={90} max={320} reverse label="调整相机区域高度" /></div>
          <section className="camera-section" aria-label="相机视图">
            <div className="viewport-heading"><span><Radio size={14} />相机视图 <span className="count-chip">{cameraCount}</span></span><span className="viewport-meta">同步投影 · 点击选择</span></div>
            <div className="camera-grid">{Array.from({ length: cameraCount }, (_, i) => <CameraView key={i} index={i} />)}</div>
          </section>
        </>}
      </main>
      {inspector && <>
        <div className="inspector-divider"><ResizeHandle axis="x" value={inspectorWidth} onChange={setInspectorWidth} min={280} max={420} reverse label="调整属性面板宽度" /></div>
        <aside className="inspector" aria-label="对象与属性">
          <div className="inspector-heading"><span>对象与属性</span><button className="icon-button" aria-label="关闭属性面板" onClick={() => setInspector(false)}><X size={16} /></button></div>
          <ObjectList /><PropertiesPanel />
        </aside>
      </>}
    </div>
    <section className={`timeline-section ${timelineOpen ? '' : 'is-collapsed'}`} aria-label="轨迹时间轴">
      {timelineOpen && <ResizeHandle axis="y" value={timelineHeight} onChange={setTimelineHeight} min={48} max={230} reverse label="调整时间轴高度" />}
      <div className="timeline-heading"><button className="text-button" aria-expanded={timelineOpen} onClick={() => setTimelineOpen((v) => !v)}>{timelineOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}轨迹时间轴</button>
        <div className="timeline-legend"><span><i className="legend-bar" />{session.readOnly ? "观测帧" : "存在区间"}</span><span><i className="legend-diamond" />{session.readOnly ? "源观测" : "关键帧"}</span><span><i className="legend-line" />当前帧</span></div>
        <span className="timeline-tip">点击轨迹名选择 · 拖动标尺切帧</span>
      </div>
      <div className="timeline-canvas" style={{ height: timelineOpen ? Math.min(230, Math.max(48, timelineHeight)) : 0 }}><Timeline /></div>
    </section>
    <PlaybackBar />
    <ShortcutHelp open={help} onClose={() => setHelp(false)} />
  </div>;
}

export default function App() {
  return <SessionProvider><Workspace /></SessionProvider>;
}

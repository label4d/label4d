import { useEffect, useState } from 'react';
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

function Shortcuts() {
  const session = useSession();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) session.redo();
        else session.undo();
        return;
      }
      switch (e.key) {
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
            if (dir !== 0) session.setFrame(session.frame + dir * (e.shiftKey ? 10 : 1));
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
  }, [session]);
  return null;
}

function Workspace() {
  const session = useSession();
  useSessionTick(['manifestLoaded']);
  const [mode, setMode] = useState<'bev' | 'cloud'>('cloud');
  const cameraCount = session.projectors.size;
  return (
    <div className="flex h-screen w-screen flex-col bg-[#0b0e13] text-slate-200">
      <Shortcuts />
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-1 bg-[#10161f] px-2 py-1">
            {(['cloud', 'bev'] as const).map((m) => (
              <button
                key={m}
                className={`rounded px-3 py-1 text-[11px] ${mode === m ? 'bg-[#2b6cff] text-white' : 'bg-[#1d2530] text-slate-300 hover:bg-[#283242]'}`}
                onClick={() => setMode(m)}
              >
                {m === 'cloud' ? '4D 点云模式' : 'BEV 俯视模式'}
              </button>
            ))}
          </div>
          {mode === 'cloud' ? (
            <div className="flex min-h-0 flex-[3] gap-px bg-[#1d2530]">
              <div className="flex min-w-0 flex-[2] flex-col">
                <span className="bg-[#10161f] px-2 py-0.5 text-[10px] text-slate-500">4D 点云主视图（点云主导）</span>
                <ThreeDView />
              </div>
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="bg-[#10161f] px-2 py-0.5 text-[10px] text-slate-500">三视图</span>
                <ThreeViewStrip />
              </div>
            </div>
          ) : (
            <div className="flex min-h-0 flex-[3] flex-col">
              <span className="bg-[#10161f] px-2 py-0.5 text-[10px] text-slate-500">BEV 俯视图（自上而下固定视角 · 滚轮缩放 / 拖动平移 · Shift+拖动框选）</span>
              <BevView />
            </div>
          )}
          <div className="flex min-h-0 flex-[2] flex-col gap-px bg-[#1d2530] pt-px">
            <div className="flex min-h-0 flex-1 flex-col">
              <span className="bg-[#10161f] px-2 py-0.5 text-[10px] text-slate-500">
                相机图像 · {cameraCount} 路 · 4D 投影全相机同步高亮可点选
              </span>
              <div className="flex min-h-0 flex-1 gap-px">
                {Array.from({ length: Math.max(1, cameraCount) }, (_, i) => (
                  <CameraView key={i} index={i} />
                ))}
                {cameraCount === 0 && <div className="flex flex-1 items-center justify-center text-[10px] text-slate-600">当前数据无相机</div>}
              </div>
            </div>
          </div>
        </div>
        <div className="flex w-64 flex-col border-l border-[#1d2530] bg-[#0e1218]">
          <ObjectList />
          <PropertiesPanel />
        </div>
      </div>
      <div className="h-44 border-t border-[#1d2530]">
        <Timeline />
      </div>
      <PlaybackBar />
    </div>
  );
}

export default function App() {
  return (
    <SessionProvider>
      <Workspace />
    </SessionProvider>
  );
}

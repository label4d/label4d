import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { events, type HighlightEventPayload } from '@labelfaster/core';
import { useCore } from '../lib/core-context';

interface ToolbarProps {
  onReferenceImageLoaded?: (image: ImageBitmap) => void;
}

const modes = [
  { key: 'select', label: '选择' },
  { key: 'draw-polyline', label: '折线' },
  { key: 'draw-rectangle', label: '矩形' },
  { key: 'draw-polygon', label: '多边形' },
  { key: 'move', label: '平移' },
] as const;

type ModeKey = (typeof modes)[number]['key'];

export function Toolbar({ onReferenceImageLoaded }: ToolbarProps): JSX.Element {
  const { mode, history, highlight, selection, heightMap, pointCloud } = useCore();
  const [currentMode, setCurrentMode] = useState<ModeKey>('select');
  const [historyState, setHistoryState] = useState({ undo: false, redo: false });
  const [highlightActive, setHighlightActive] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState<string | null>(null);
  const pointCloudInputRef = useRef<HTMLInputElement | null>(null);
  const heightMapInputRef = useRef<HTMLInputElement | null>(null);
  const referenceImageInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const handleHistory = ({ undoCount, redoCount }: { undoCount: number; redoCount: number }) => {
      setHistoryState({ undo: undoCount > 0, redo: redoCount > 0 });
    };
    const handleHighlight = (payload: HighlightEventPayload) => {
      setHighlightActive(payload.active);
    };

    events.on('historyChanged', handleHistory);
    events.on('highlightChanged', handleHighlight);

    setHistoryState({ undo: history.canUndo(), redo: history.canRedo() });

    return () => {
      events.off('historyChanged', handleHistory);
      events.off('highlightChanged', handleHighlight);
    };
  }, [history]);

  const switchMode = (next: ModeKey) => {
    setCurrentMode(next);
    if (next === 'select') {
      mode.setMode('select');
    } else if (next === 'move') {
      mode.setMode('move');
    } else if (next.startsWith('draw')) {
      const [, shape] = next.split('-');
      if (shape === 'polyline' || shape === 'rectangle' || shape === 'polygon') {
        mode.setDrawMode(shape);
      }
    } else {
      mode.setMode('idle');
    }
  };

  const toggleHighlight = () => {
    const ids = selection.list().map((annotation) => annotation.id);
    if (ids.length === 0) {
      return;
    }
    const active = !highlightActive;
    setHighlightActive(active);
    highlight.setActive(ids, 'flash', active);
  };

  const triggerPointCloudDialog = () => {
    pointCloudInputRef.current?.click();
  };

  const triggerHeightMapDialog = () => {
    heightMapInputRef.current?.click();
  };

  const triggerReferenceDialog = () => {
    referenceImageInputRef.current?.click();
  };

  const handlePointCloudFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      setLoadingMessage('加载点云中…');
      const url = URL.createObjectURL(file);
      await pointCloud.load(url);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error(error);
    } finally {
      event.target.value = '';
      setLoadingMessage(null);
    }
  };

  const handleHeightMapFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    try {
      setLoadingMessage('加载高度图中…');
      const bitmap = await createImageBitmap(file);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('无法创建 Canvas 上下文');
      }
      context.drawImage(bitmap, 0, 0);
      const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
      heightMap.loadFromImageData(imageData);
      if (onReferenceImageLoaded) {
        onReferenceImageLoaded(bitmap);
      }
    } catch (error) {
      console.error(error);
    } finally {
      event.target.value = '';
      setLoadingMessage(null);
    }
  };

  const handleReferenceImageFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file || !onReferenceImageLoaded) {
      return;
    }
    try {
      setLoadingMessage('加载参考图中…');
      const bitmap = await createImageBitmap(file);
      onReferenceImageLoaded(bitmap);
    } catch (error) {
      console.error(error);
    } finally {
      event.target.value = '';
      setLoadingMessage(null);
    }
  };

  return (
    <div className="flex items-center gap-2 border-b border-border bg-background/80 px-4 py-2">
      <span className="font-semibold">Labelfaster</span>
      <div className="flex items-center gap-2">
        {modes.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => switchMode(item.key)}
            className={`rounded-md px-3 py-1 text-sm transition ${currentMode === item.key ? 'bg-primary text-primary-foreground shadow' : 'bg-secondary text-secondary-foreground'}`}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => history.undo()}
          disabled={!historyState.undo}
          className="rounded-md bg-secondary px-3 py-1 text-sm disabled:opacity-50"
        >
          撤销
        </button>
        <button
          type="button"
          onClick={() => history.redo()}
          disabled={!historyState.redo}
          className="rounded-md bg-secondary px-3 py-1 text-sm disabled:opacity-50"
        >
          重做
        </button>
        <button
          type="button"
          onClick={toggleHighlight}
          className={`rounded-md px-3 py-1 text-sm ${highlightActive ? 'bg-primary text-primary-foreground' : 'bg-secondary text-secondary-foreground'}`}
        >
          高亮闪烁
        </button>
        <button
          type="button"
          onClick={triggerPointCloudDialog}
          className="rounded-md bg-secondary px-3 py-1 text-sm"
        >
          加载点云
        </button>
        <button
          type="button"
          onClick={triggerHeightMapDialog}
          className="rounded-md bg-secondary px-3 py-1 text-sm"
        >
          加载高度图
        </button>
        <button
          type="button"
          onClick={triggerReferenceDialog}
          className="rounded-md bg-secondary px-3 py-1 text-sm"
        >
          加载参考图
        </button>
        {loadingMessage ? <span className="text-xs text-secondary-foreground/80">{loadingMessage}</span> : null}
        <input
          ref={pointCloudInputRef}
          type="file"
          accept=".pcd"
          className="hidden"
          onChange={handlePointCloudFile}
        />
        <input
          ref={heightMapInputRef}
          type="file"
          accept="image/png"
          className="hidden"
          onChange={handleHeightMapFile}
        />
        <input
          ref={referenceImageInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={handleReferenceImageFile}
        />
      </div>
    </div>
  );
}

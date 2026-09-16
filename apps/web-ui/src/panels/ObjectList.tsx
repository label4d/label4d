import { useState } from 'react';
import { useSession, useSessionTick } from '../session/SessionProvider';
import { colorForLabel } from '@labelfaster/core';

export function ObjectList() {
  const session = useSession();
  useSessionTick(['frameChanged', 'storeChanged', 'selectionChanged']);
  const [filter, setFilter] = useState('');

  const active = session.store
    .activeTrackIds(session.frame)
    .map((id) => session.store.getTrack(id))
    .filter((record): record is NonNullable<typeof record> => !!record)
    .filter((record) => !filter || record.meta.label.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="flex min-h-0 flex-col border-b border-[#1d2530]">
      <div className="flex items-center justify-between px-3 py-1.5 text-xs text-slate-400">
        <span>当前帧对象 ({active.length})</span>
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="筛选类别"
          className="w-20 rounded bg-[#1d2530] px-1 py-0.5 text-[10px] text-slate-300 outline-none"
        />
      </div>
      <div className="max-h-48 min-h-0 overflow-y-auto">
        {active.map((record) => {
          const selected = session.selection.has(record.meta.id);
          const kf = session.store.getKeyframes(record.meta.id);
          const isKeyframe = kf?.frames.includes(session.frame) ?? false;
          return (
            <button
              key={record.meta.id}
              className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs hover:bg-[#1a2230] ${
                selected ? 'bg-[#20293a] text-white' : 'text-slate-300'
              }`}
              onClick={() => session.selection.select([record.meta.id], selected ? 'toggle' : 'replace')}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: colorForLabel(session.labels, record.meta.label) }} />
              <span className="flex-1 truncate">
                {record.meta.label}·{record.meta.id.slice(-4)}
                {record.meta.source === 'model' && <span className="ml-1 text-[9px] text-amber-400">AI</span>}
              </span>
              {isKeyframe && <span className="text-[9px] text-white" title="当前帧为关键帧">◆</span>}
              <span className="text-[9px] text-slate-500">[{record.meta.startFrame}-{record.meta.endFrame}]</span>
            </button>
          );
        })}
        {active.length === 0 && <div className="px-3 py-2 text-[10px] text-slate-600">当前帧无对象</div>}
      </div>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { events } from '@labelfaster/core';
import { useCore } from '../lib/core-context';

export function StatusBar(): JSX.Element {
  const { mode } = useCore();
  const [selectionCount, setSelectionCount] = useState(0);
  const [tooltip, setTooltip] = useState('准备就绪');

  useEffect(() => {
    const handleSelection = ({ selectedIds }: { selectedIds: string[] }) => {
      setSelectionCount(selectedIds.length);
      if (selectedIds.length > 0) {
        setTooltip(`已选中 ${selectedIds.length} 个标注`);
      } else {
        setTooltip('未选中任何标注');
      }
    };

    events.on('selectionChanged', handleSelection);

    return () => {
      events.off('selectionChanged', handleSelection);
    };
  }, []);

  return (
    <div className="flex items-center justify-between border-t border-border bg-background/90 px-4 py-2 text-xs text-secondary-foreground">
      <span>模式：{mode.getMode()}</span>
      <span>{tooltip}</span>
      <span>选择数量：{selectionCount}</span>
    </div>
  );
}

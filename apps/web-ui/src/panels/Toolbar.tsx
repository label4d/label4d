import { useRef, useState } from 'react';
import { Check, CircleDashed, CloudOff, Download, FileJson, FolderOpen, Loader2, PanelRight, Upload } from 'lucide-react';
import { useSession, useSessionTick } from '../session/SessionProvider';
import { BrandMark } from '../components/BrandMark';
import { Dropdown } from '../components/Dropdown';
import type { SnapshotDocument } from '@label4d/core';

export function Toolbar({ onToggleInspector, inspectorOpen }: { onToggleInspector: () => void; inspectorOpen: boolean }) {
  const session = useSession();
  useSessionTick(['manifestLoaded', 'qaChanged', 'saveChanged', 'frameStatusChanged', 'historyChanged']);
  const fileRef = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState('');
  const saved = session.saveStatus === 'saved';
  const loading = ['saving', 'loading'].includes(session.saveStatus);
  const datasets = [
    { name: 'KITTI', manifest: '/kitti-camera/manifest.json' },
    { name: 'Waymo', manifest: '/datasets/waymo-normalized-198/sequence.json' },
  ];
  const currentUrl = new URL(window.location.href);
  const requestedManifest = currentUrl.searchParams.get('manifest') || datasets[0].manifest;
  const selected = datasets.find((dataset) => new URL(dataset.manifest, currentUrl).href === new URL(requestedManifest, currentUrl).href)?.manifest ?? requestedManifest;
  const canSwitchDataset = () => Boolean(session.manifest) && !['saving', 'loading', 'error'].includes(session.saveStatus) && !session.history.pending;
  const switchBlocked = !canSwitchDataset();
  const switchHint = session.saveStatus === 'error' ? '请先重试保存，再切换数据集' : switchBlocked ? '等待数据加载或保存完成' : '切换数据集；返回 KITTI 时恢复已保存标注';
  const download = (data: unknown, name: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
    const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
    setNotice(`已导出 ${name}`);
  };
  return <header className="app-header">
    <div className="brand"><BrandMark /><span>Label4D</span></div>
    <select className="dataset-switch" aria-label="切换数据集" title={switchHint} value={selected} disabled={switchBlocked} onChange={(e) => {
      if (!canSwitchDataset() || e.target.value === selected) return;
      session.pause();
      const next = new URL(window.location.href);
      next.searchParams.set('manifest', e.target.value);
      window.location.assign(next.href);
    }}>
      {datasets.map((dataset) => <option key={dataset.manifest} value={dataset.manifest}>{dataset.name}</option>)}
      {!datasets.some((dataset) => dataset.manifest === selected) && <option value={selected}>自定义数据集</option>}
    </select>
    <div className="sequence-heading"><FolderOpen size={16} /><span>{session.manifest?.id ?? '加载序列…'}</span>
      <span className="sequence-kind">{session.readOnly ? '源观测 · 只读' : '标注序列'}</span></div>
    <div className="header-actions">
      <div className={`save-indicator ${saved ? 'is-saved' : session.saveStatus === 'error' ? 'is-error' : ''}`}>
        {saved ? <Check size={15} /> : loading ? <Loader2 size={15} className="spin" /> : <CloudOff size={15} />}
        <span role="status" aria-label="本地保存状态" title="修改自动保存到当前浏览器">
          {session.readOnly ? '只读浏览 · 不写入标注文档' : saved ? `已保存 r${session.savedRevision}` : session.saveStatus === 'saving' ? '保存中…' : session.saveStatus === 'loading' ? '恢复中…' : session.saveStatus === 'error' ? '保存失败' : '未启用本地保存'}
        </span>
        {session.saveStatus === 'error' && <button className="text-button" onClick={() => session.history.retryFailed()}>重试</button>}
      </div>
      <label className={`review-select review-${session.qa.status}`}><CircleDashed size={14} />
        <select aria-label="质检状态" disabled={!session.canEdit} value={session.qa.status} onChange={(e) => session.setQA(e.target.value as typeof session.qa.status)}>
          <option value="pending">待复核</option><option value="pass">复核通过</option><option value="reject">需修正</option>
        </select>
      </label>
      <Dropdown label="文件与导出" className="file-dropdown">
        <div className="menu-heading">序列文件</div>
        <button className="menu-action" disabled={!session.canEdit} onClick={() => fileRef.current?.click()}><Upload size={16} /><span>导入快照<small>替换当前序列的标注</small></span></button>
        <button className="menu-action" disabled={loading || session.readOnly} onClick={() => download(session.exportSnapshot(), `${session.manifest?.id ?? 'sequence'}.snapshot.json`)}><Download size={16} /><span>导出快照<small>当前已提交的标注内容</small></span></button>
        <button className="menu-action" disabled={loading || session.readOnly} onClick={() => download(session.exportNuScenes({ sampleStep: 5 }), `${session.manifest?.id ?? 'sequence'}.nuscenes.json`)}><FileJson size={16} /><span>导出 nuScenes 草稿<small>草稿格式，尚未完成兼容验收</small></span></button>
      </Dropdown>
      <button className={`icon-button inspector-toggle ${inspectorOpen ? 'is-active' : ''}`} aria-label="切换属性面板" aria-pressed={inspectorOpen} title="显示或隐藏对象与属性" onClick={onToggleInspector}><PanelRight size={19} /></button>
    </div>
    <input ref={fileRef} type="file" aria-label="导入快照文件" accept="application/json" hidden onChange={async (e) => {
      const file = e.target.files?.[0]; if (!file) return;
      try { session.importSnapshot(JSON.parse(await file.text()) as SnapshotDocument); setNotice('快照已读取，请等待保存完成'); }
      catch (error) { session.events.emit('error', { message: `导入失败：${String(error)}` }); }
      e.target.value = '';
    }} />
    {notice && <div className="notice-toast" role="status" aria-label="操作反馈"><Check size={16} /><span>{notice}</span><button className="text-button" onClick={() => setNotice('')}>关闭</button></div>}
  </header>;
}

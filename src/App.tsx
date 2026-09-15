import { useEffect, useCallback, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import { CalendarDays, FilePenLine, Maximize2, Minus, Plus, Search, Settings2, Target, X } from 'lucide-react';
import { useAppStore, applyTheme } from './stores/appStore';
import { getNotionToken, fetchTodos, fetchReports, fetchProjects } from './lib/notion';
import ProjectView from './components/ProjectView';
import Reports from './components/Reports';
import Agenda from './components/Agenda';
import Settings from './components/Settings';
import SearchModal from './components/SearchModal';
import AssistantPanel, { VOICE_LABELS } from './components/AssistantPanel';
import { useDialogFocus } from './lib/useDialogFocus';
import type { Page } from './types';

const NAV_ITEMS = [
  { id: 'agenda' as Page, label: '日程', Icon: CalendarDays },
  { id: 'reports' as Page, label: '日报', Icon: FilePenLine },
  { id: 'goals' as Page, label: '目标', Icon: Target },
];

export default function App() {
  const { currentPage, setCurrentPage, setTodos, setReports, setProjects, setNotionConnected, setNotionSync, updateSettings, notionConnected, settings } = useAppStore();
  const [showSettings, setShowSettings] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [showAssistant, setShowAssistant] = useState(false);
  const [voiceState, setVoiceState] = useState('idle');
  const [briefingRequest, setBriefingRequest] = useState(0);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const loadingRef = useRef<Promise<void> | null>(null);
  const settingsRef = useDialogFocus(showSettings, () => setShowSettings(false));
  const openSettings = useCallback(() => { setShowAssistant(false); setShowSearch(false); setShowSettings(true); }, []);
  const voiceActive = !['idle', 'disconnected'].includes(voiceState);

  useEffect(() => {
    applyTheme(settings);
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => { if (settings.theme === 'auto') applyTheme(settings); };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, [settings]);

  const loadData = useCallback(() => {
    if (loadingRef.current) return loadingRef.current;
    const operation = async () => {
      setLoading(true); setLoadError('');
      try {
        const token = settings.notionToken.trim() || (isTauri() ? await getNotionToken() : '');
        if (!token) { setNotionConnected(false); setNotionSync({error:'尚未配置 Notion'}); return; }
        if (!settings.notionToken.trim()) updateSettings({notionToken: token});
        const results = await Promise.allSettled([fetchTodos(token), fetchReports(token), fetchProjects(token)]);
        if (results[0].status === 'fulfilled') setTodos(results[0].value);
        if (results[1].status === 'fulfilled') setReports(results[1].value);
        if (results[2].status === 'fulfilled') setProjects(results[2].value);
        const failed = results.some(r => r.status === 'rejected');
        setNotionConnected(!failed);
        setNotionSync(failed?{error:'部分日程数据同步失败，当前内容可能已过期'}:{at:Date.now(),error:''});
        if (failed) setLoadError('部分数据未能同步，已保留当前内容。请检查 Notion 连接后重试。');
      } catch { setNotionSync({error:'Notion 连接失败，请检查配置后重试'}); setNotionConnected(false); setLoadError('暂时无法连接 Notion，请检查设置后重试。'); }
      finally { setLoading(false); loadingRef.current = null; }
    };
    const promise = operation(); loadingRef.current = promise;
    // The no-token path may finish synchronously; clear only this operation.
    void promise.finally(() => { if (loadingRef.current === promise) loadingRef.current = null; });
    return promise;
  }, [settings.notionToken, setTodos, setReports, setProjects, setNotionConnected, updateSettings]);
  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => {
    if (!voiceActive || !settings.autoBriefing) return;
    const timer = setInterval(() => void loadData(), 120000);
    return () => clearInterval(timer);
  }, [voiceActive, settings.autoBriefing, loadData]);

  useEffect(() => {
    if (!isTauri() || import.meta.env.DEV) return;
    void (async () => {
      try {
        if (await invoke<boolean>('is_development_build')) return;
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (update?.available) { await update.downloadAndInstall(); const { relaunch } = await import('@tauri-apps/plugin-process'); await relaunch(); }
      } catch { /* Manual update remains available in Settings. */ }
    })();
  }, []);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); setShowSearch(v => !v); setShowSettings(false); setShowAssistant(false); }
      if (e.key === 'Escape' && !showAssistant && !showSettings) setShowSearch(false);
    };
    window.addEventListener('keydown', handler); return () => window.removeEventListener('keydown', handler);
  }, [showAssistant, showSettings]);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined; let assistantOff:(()=>void)|undefined;
    void listen('pm:open-assistant',()=>{setShowSettings(false);setShowAssistant(true);void getCurrentWindow().show();void getCurrentWindow().setFocus();}).then(fn=>{if(disposed)fn();else assistantOff=fn;});
    void listen('open-settings', openSettings).then(fn => {if (disposed) fn(); else unlisten = fn;});
    return () => {disposed = true; unlisten?.();assistantOff?.();};
  }, [openSettings]);
  useEffect(() => {
    if (!isTauri()) return;
    const win = getCurrentWindow();
    const key = 'antdesk_window_glass_v2';
    try {
      const saved = JSON.parse(localStorage.getItem(key) || 'null');
      if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
        void win.setSize(new LogicalSize(Math.min(Math.max(saved.width, 300), 600), Math.min(Math.max(saved.height, 480), 960))).catch(() => {});
        if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) void win.setPosition(new PhysicalPosition(saved.x, saved.y)).catch(() => {});
      }
    } catch { /* Invalid window preferences do not block launch. */ }
    const save = async () => {
      try {
        const [size, pos, scale] = await Promise.all([win.innerSize(), win.outerPosition(), win.scaleFactor()]);
        localStorage.setItem(key, JSON.stringify({width: size.width / scale, height: size.height / scale, x: pos.x, y: pos.y}));
      } catch { /* OS window may already be closed. */ }
    };
    const resized = win.onResized(save); const moved = win.onMoved(save);
    return () => {void resized.then(f => f()).catch(() => {}); void moved.then(f => f()).catch(() => {});};
  }, []);

  return <div className="app-shell flex flex-col h-screen relative overflow-hidden">
    <div className="workspace-layer" inert={showAssistant || showSettings || showSearch}>
      <header className="titlebar" data-tauri-drag-region>
        <div className="titlebar-brand" data-tauri-drag-region>
          <img src="/assets/brand/app-icon.png" className="brand-avatar" alt=""/>
          <div data-tauri-drag-region><strong>AntDesk</strong><span>{loading ? '正在同步' : notionConnected ? '日程已同步' : '你的桌面伙伴'}</span></div>
        </div>
        <div className="titlebar-actions">
          <button className="icon-button" aria-label="全局搜索" title="搜索 ⌘K" onClick={() => setShowSearch(true)}><Search size={16}/></button>
          <button className="icon-button" aria-label="设置" onClick={openSettings}><Settings2 size={16}/></button>
          {isTauri() && <><span className="toolbar-divider"/><button className="icon-button" aria-label="最小化" onClick={() => void getCurrentWindow().minimize()}><Minus size={16}/></button><button className="icon-button" aria-label="隐藏窗口" onClick={() => void getCurrentWindow().hide()}><X size={15}/></button></>}
        </div>
      </header>
      <main className="main-surface">
        <div className="main-scroll custom-scrollbar">
          {loadError && <div className="inline-notice" role="status">{loadError}<button className="text-button" disabled={loading} onClick={() => void loadData()}>重试</button></div>}
          {!settings.notionToken && !notionConnected && !loading && <button className="connection-banner" onClick={openSettings}><span className="connection-symbol"><Plus size={15}/></span><span><strong>连接你的日程</strong><small>在设置中连接 Notion，让助理了解你的安排</small></span><Maximize2 size={14}/></button>}
          <div className="page-content-wrapper">
            {currentPage === 'agenda' && <Agenda onRefresh={() => void loadData()} onAssistant={() => setShowAssistant(true)} onBriefing={() => {setShowAssistant(true); setBriefingRequest(v => v + 1);}} refreshing={loading}/>}
            {currentPage === 'reports' && <Reports/>}
            {currentPage === 'goals' && <ProjectView/>}
          </div>
        </div>
      </main>
      <footer className="bottom-dock">
        <nav className="nav-pill" aria-label="主导航">
          <span className="nav-lens" style={{transform: `translateX(${NAV_ITEMS.findIndex(n => n.id === currentPage) * 100}%)`}}/>
          {NAV_ITEMS.map(({id, label, Icon}) => <button key={id} onClick={() => setCurrentPage(id)} aria-current={currentPage === id ? 'page' : undefined} className={`nav-item ${currentPage === id ? 'active' : ''}`}><Icon size={19}/><span className="nav-label">{label}</span></button>)}
        </nav>
        <button className={`assistant-dock-button ${voiceActive ? 'is-live' : ''}`} aria-label={`打开助理：${VOICE_LABELS[voiceState]}`} onClick={() => setShowAssistant(true)}><img src="/assets/assistant/pearl.png" alt=""/>{voiceActive && <span className="live-dot"/>}</button>
      </footer>
    </div>
    <AssistantPanel open={showAssistant} onClose={() => setShowAssistant(false)} onSettings={openSettings} onState={setVoiceState} requestBriefing={briefingRequest}/>
    {showSettings && <div className="settings-backdrop" onClick={() => setShowSettings(false)}><section ref={settingsRef} className="settings-sheet" role="dialog" aria-modal="true" aria-label="设置" onClick={e => e.stopPropagation()}><header className="settings-heading"><div><h2>设置</h2></div><button className="icon-button" aria-label="关闭设置" onClick={() => setShowSettings(false)}><X size={18}/></button></header><Settings voiceState={voiceState}/></section></div>}
    {showSearch && <SearchModal onClose={() => setShowSearch(false)}/>}
  </div>;
}

import { useEffect, useCallback, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { X } from 'lucide-react';
import { useAppStore, applyTheme } from './stores/appStore';
import { getNotionToken, fetchTodos, fetchReports, fetchProjects } from './lib/notion';
import { useDrawer } from './lib/useDrawer';
import { useDialogFocus } from './lib/useDialogFocus';
import ProjectView from './components/ProjectView';
import Reports from './components/Reports';
import Settings from './components/Settings';
import AssistantPanel from './components/AssistantPanel';
import PlannerDrawer from './components/planner/PlannerDrawer';
import Sheet from './components/planner/Sheet';
import './drawer.css';

export default function App() {
  const { setTodos, setReports, setProjects, setNotionConnected, setNotionSync, updateSettings, notionConnected, settings } = useAppStore();
  const todos = useAppStore(state => state.todos);
  const [overlay, setOverlay] = useState<'settings' | 'assistant' | 'projects' | 'reports' | null>(null);
  const [interacting, setInteracting] = useState(false);
  const [pinned, setPinned] = useState(false);
  const drawer = useDrawer(Boolean(overlay) || interacting || pinned);
  const showSettings = overlay === 'settings', showAssistant = overlay === 'assistant';
  const settingsReturn = useRef<'assistant' | null>(null);
  const [availableUpdate, setAvailableUpdate] = useState('');
  const [voiceState, setVoiceState] = useState('idle');
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const loadingRef = useRef<Promise<void> | null>(null);
  const closeSettings = useCallback(() => setOverlay(settingsReturn.current), []);
  const settingsRef = useDialogFocus(showSettings, closeSettings);
  const openSettings = useCallback(() => { settingsReturn.current = null; setOverlay('settings'); void drawer.change('expanded'); }, [drawer.change]);
  const openAssistant = useCallback(() => { setOverlay('assistant'); void drawer.change('expanded'); }, [drawer.change]);
  const openAssistantSettings = () => { settingsReturn.current = 'assistant'; setOverlay('settings'); };
  const openAssistantWorkspace = useCallback(() => {
    settingsReturn.current = null;
    setOverlay(null);
    window.dispatchEvent(new CustomEvent('antdesk:open-assistants'));
    void drawer.change('expanded');
  }, [drawer.change]);
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
        if (!token) { setNotionConnected(false); setNotionSync({error: ''}); return; }
        if (!settings.notionToken.trim()) updateSettings({notionToken: token});
        const results = await Promise.allSettled([fetchTodos(token), fetchReports(token), fetchProjects(token)]);
        if (results[0].status === 'fulfilled') setTodos(results[0].value);
        if (results[1].status === 'fulfilled') setReports(results[1].value);
        if (results[2].status === 'fulfilled') setProjects(results[2].value);
        const failed = results.some(r => r.status === 'rejected');
        setNotionConnected(!failed);
        setNotionSync(failed ? {error: '部分数据同步失败，当前内容可能已过期'} : {at: Date.now(), error: ''});
        if (failed) setLoadError('Notion 同步不完整，已保留当前内容。');
      } catch {
        setNotionSync({error: 'Notion 连接失败'}); setNotionConnected(false);
        setLoadError('暂时无法同步 Notion，本地事项仍可使用。');
      } finally { setLoading(false); }
    };
    const promise = operation(); loadingRef.current = promise;
    void promise.finally(() => { if (loadingRef.current === promise) loadingRef.current = null; });
    return promise;
  }, [settings.notionToken, setTodos, setReports, setProjects, setNotionConnected, setNotionSync, updateSettings]);
  useEffect(() => { void loadData(); }, [loadData]);
  useEffect(() => {
    if (!settings.notionToken) return;
    const timer = setInterval(() => void loadData(), voiceActive && settings.autoBriefing ? 120000 : 300000);
    return () => clearInterval(timer);
  }, [voiceActive, settings.autoBriefing, settings.notionToken, loadData]);

  useEffect(() => {
    if (!isTauri() || import.meta.env.DEV) return;
    void (async () => {
      try {
        if (await invoke<boolean>('is_development_build')) return;
        const { check } = await import('@tauri-apps/plugin-updater');
        const update = await check();
        if (update?.available) setAvailableUpdate(update.version);
      } catch { /* Manual update remains available in Settings. */ }
    })();
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    for (const [name, handler] of [['pm:open-assistant', openAssistant], ['open-settings', openSettings]] as const) {
      void listen(name, handler).then(fn => disposed ? fn() : cleanups.push(fn));
    }
    return () => { disposed = true; cleanups.forEach(fn => fn()); };
  }, [openAssistant, openSettings]);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !overlay && !interacting && !drawer.docking && drawer.mode !== 'collapsed') {
        e.preventDefault(); void drawer.change('collapsed');
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [overlay, interacting, drawer.mode, drawer.docking, drawer.change]);

  return <div className="priority-app" data-edge={drawer.edge} data-mode={drawer.mode} data-closing={drawer.closing} data-docking={drawer.docking} data-reduce-motion={settings.reduceMotion} onMouseEnter={drawer.enter} onMouseLeave={drawer.leave}>
    <div className="pd-base" inert={Boolean(overlay)}>
      <PlannerDrawer drawer={drawer} pinned={pinned} onPin={() => setPinned(value => !value)} onSettings={openSettings} onChat={openAssistant}
        onLegacy={page => setOverlay(page)} onInteractionChange={setInteracting} loading={loading} syncError={loadError}
        connected={notionConnected} voiceActive={voiceActive} onRefresh={() => void loadData()} updateVersion={availableUpdate}/>
    </div>
    <AssistantPanel open={showAssistant} onClose={() => setOverlay(null)} onSettings={openAssistantSettings} onAssistants={openAssistantWorkspace} onState={setVoiceState} requestBriefing={0}/>
    {showSettings && <div className="settings-backdrop" onClick={closeSettings}><section ref={settingsRef} className="settings-sheet" role="dialog" aria-modal="true" aria-label="设置" onClick={e => e.stopPropagation()}><header className="settings-heading"><h2>设置</h2><button className="icon-button" aria-label="关闭设置" onClick={closeSettings}><X size={18}/></button></header><Settings voiceState={voiceState} onAssistants={openAssistantWorkspace}/></section></div>}
    {(overlay === 'projects' || overlay === 'reports') && <Sheet title={overlay === 'projects' ? '项目' : '日报'} onClose={() => setOverlay(null)}>{overlay === 'projects' ? <ProjectView/> : <Reports/>}</Sheet>}
  </div>;
}

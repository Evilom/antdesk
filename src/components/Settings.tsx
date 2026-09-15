import { useState, useEffect, useRef } from "react";
import AssistantSettings, {type AssistantSettingsArea} from "./AssistantSettings";
import {SettingsGroup, SettingToggle} from "./SettingsControls";
import {Bell, ChevronLeft, ChevronRight, FolderOpen, Mic, Palette, SlidersHorizontal} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/appStore";
import { IconCheck } from "./Icons";
import {
  WINDOW_INTERACTION_HINT,
  WINDOW_INTERACTION_LABEL,
  readWindowInteractionMode,
  writeWindowInteractionMode,
  type WindowInteractionMode,
} from "../lib/DesktopWorldBridge";
import type { ThemeMode, AccentColor, FontSize, GlassIntensity } from "../types";

const ACCENT_OPTIONS: { id: AccentColor; label: string; color: string }[] = [
  { id: "blue",   label: "蓝", color: "#0a84ff" },
  { id: "purple", label: "紫", color: "#bf5af2" },
  { id: "green",  label: "绿", color: "#30d158" },
  { id: "orange", label: "橙", color: "#ff9f0a" },
  { id: "red",    label: "红", color: "#ff453a" },
  { id: "pink",   label: "粉", color: "#ff375f" },
];

const FONT_OPTIONS: { id: FontSize; label: string; size: string }[] = [
  { id: "small",  label: "小", size: "12px" },
  { id: "medium", label: "中", size: "13px" },
  { id: "large",  label: "大", size: "14px" },
];

const GLASS_OPTIONS: { id: GlassIntensity; label: string; desc: string }[] = [
  { id: "low",    label: "轻", desc: "更实" },
  { id: "medium", label: "中", desc: "平衡" },
  { id: "high",   label: "透", desc: "更透" },
];

const PET_MODE_OPTIONS: WindowInteractionMode[] = ["off", "standard", "enhanced"];

const CATEGORIES = [
  {id:'voice', title:'语音与助理', description:'连接服务、选择声音', icon:Mic},
  {id:'memory', title:'项目与记忆', description:'项目目录、Hermes 知识、长期记忆', icon:FolderOpen},
  {id:'briefing', title:'提醒与简报', description:'关键事件、每日汇报', icon:Bell},
  {id:'appearance', title:'外观与桌宠', description:'主题、玻璃效果、陪伴方式', icon:Palette},
  {id:'services', title:'连接与应用', description:'Notion、文字 AI、更新与启动', icon:SlidersHorizontal},
] as const;
type SettingsCategory = typeof CATEGORIES[number]['id'];
export default function Settings({voiceState='idle'}: {voiceState?:string}) {
  const [category, setCategory] = useState<SettingsCategory|null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const lastCategory = useRef<SettingsCategory|null>(null);
  const navigate = (next:SettingsCategory|null) => { if(next)lastCategory.current=next; setCategory(next); };
  useEffect(()=>{
    contentRef.current?.scrollTo({top:0});
    if(category) backRef.current?.focus();
    else if(lastCategory.current) contentRef.current?.querySelector<HTMLButtonElement>(`[data-category="${lastCategory.current}"]`)?.focus();
  },[category]);
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const notionConnected = useAppStore((s) => s.notionConnected);

  const [tokenInput, setTokenInput] = useState(settings.notionToken);
  const [endpointInput, setEndpointInput] = useState(settings.aiEndpoint);
  const [modelInput, setModelInput] = useState(settings.aiModel);
  const [petMode, setPetMode] = useState<WindowInteractionMode>(() => readWindowInteractionMode());

  // Autostart
  const [autostartEnabled, setAutostartEnabled] = useState(false);

  // Update
  const [updateStatus, setUpdateStatus] = useState("");
  const [checking, setChecking] = useState(false);
  const [saved, setSaved] = useState('');
  const [kanbanInput,setKanbanInput] = useState(settings.kanbanEndpoint || localStorage.getItem('antdesk_kanban_endpoint') || '');

  useEffect(() => {
    invoke<boolean>("plugin:autostart|is_enabled")
      .then((enabled) => setAutostartEnabled(enabled))
      .catch(() => {});
  }, []);

  // Sync inputs when settings change externally
  useEffect(() => {
    setTokenInput(settings.notionToken);
    setEndpointInput(settings.aiEndpoint);
    setModelInput(settings.aiModel);
  }, [settings.notionToken, settings.aiEndpoint, settings.aiModel]);

  const saveConnection = (kind:'notion'|'ai'|'kanban') => {
    if(kind==='notion') updateSettings({notionToken:tokenInput.trim()});
    if(kind==='ai') updateSettings({aiEndpoint:endpointInput.trim(),aiModel:modelInput.trim()});
    if(kind==='kanban') {
      updateSettings({kanbanEndpoint:kanbanInput.trim()});
      localStorage.setItem('antdesk_kanban_endpoint',kanbanInput.trim());
    }
    setSaved(kind);
  };

  const handlePetModeChange = (mode: WindowInteractionMode) => {
    setPetMode(mode);
    writeWindowInteractionMode(mode);
    emit("set-window-interaction-mode", mode).catch(() => {});
  };

  const handleClearCache = async () => {
    try {
      await invoke("clear_token_cache");
      setTokenInput("");
    } catch {}
  };

  const handleToggleAutostart = async () => {
    try {
      if (autostartEnabled) {
        await invoke("plugin:autostart|disable");
        setAutostartEnabled(false);
        setUpdateStatus("已关闭开机自启");
      } else {
        await invoke("plugin:autostart|enable");
        setAutostartEnabled(true);
        setUpdateStatus("已开启开机自启");
      }
      setTimeout(() => setUpdateStatus(""), 3000);
    } catch (e) {
      console.error("Autostart toggle failed:", e);
      setUpdateStatus(`自启设置失败: ${e}`);
      setTimeout(() => setUpdateStatus(""), 5000);
    }
  };

  const isDev = import.meta.env.DEV;

  const handleCheckUpdate = async () => {
    if (isDev) {
      setUpdateStatus("开发模式下不支持自动更新");
      setTimeout(() => setUpdateStatus(""), 3000);
      return;
    }
    setChecking(true);
    setUpdateStatus("检查中...");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 30_000 });
      if (update?.available) {
        setUpdateStatus(`发现 v${update.version}，下载中...`);
        try {
          await update.downloadAndInstall((progress) => {
            if (progress.event === "Started" && progress.data.contentLength) {
              const mb = (progress.data.contentLength / 1024 / 1024).toFixed(1);
              setUpdateStatus(`发现 v${update.version}，下载 ${mb} MB...`);
            } else if (progress.event === "Progress") {
              setUpdateStatus(`发现 v${update.version}，下载中...`);
            } else if (progress.event === "Finished") {
              setUpdateStatus("下载完成，安装中...");
            }
          }, { timeout: 120_000 });
          setUpdateStatus("安装完成，即将重启...");
          const { relaunch } = await import("@tauri-apps/plugin-process");
          try {
            await relaunch();
          } catch (e: any) {
            console.error("Relaunch after update failed:", e);
            setUpdateStatus("安装完成，请手动重启 AntDesk");
          }
        } catch (e: any) {
          console.error("Update download failed:", e);
          setUpdateStatus(`下载失败: ${e?.message || e}`);
        }
      } else {
        setUpdateStatus("已是最新版本");
      }
    } catch (e: any) {
      console.error("Update check failed:", e);
      setUpdateStatus(`检查失败: ${e?.message || e}`);
    } finally {
      setChecking(false);
      setTimeout(() => setUpdateStatus(""), 8000);
    }
  };

  const selected = CATEGORIES.find(item=>item.id===category);
  return <div className="settings-shell">
    {selected&&<div className="settings-subheading"><button ref={backRef} className="text-button" onClick={()=>navigate(null)}><ChevronLeft size={16}/>全部设置</button><h3>{selected.title}</h3></div>}
    <div className="settings-content" ref={contentRef}>
      <div hidden={category!==null} className="settings-home">
        <p className="settings-intro">把助理调成适合你的样子。</p>
        <nav aria-label="设置分类" className="settings-categories">{CATEGORIES.map(({id,title,description,icon:Icon})=><button key={id} data-category={id} onClick={()=>navigate(id)}><span className="settings-category-icon"><Icon size={20}/></span><span><strong>{title}</strong><small>{description}</small></span><ChevronRight size={16}/></button>)}</nav>
        <p className="settings-footnote">开关和外观即时保存。连接信息验证或保存后生效。</p>
        <AppVersion/>
      </div>
      <AssistantSettings area={['voice','memory','briefing'].includes(category||'')?category as AssistantSettingsArea:null} voiceState={voiceState}/>
      <div hidden={category!=='appearance'} className="settings-page">
        <SettingsGroup title="外观" description="调整后立即预览。">
          <label>主题</label><div className="settings-segments">{(['dark','light','auto'] as ThemeMode[]).map(mode=><button key={mode} aria-pressed={settings.theme===mode} onClick={()=>updateSettings({theme:mode})}>{mode==='dark'?'深色':mode==='light'?'浅色':'跟随系统'}</button>)}</div>
          <label>主题色</label><div className="settings-colors">{ACCENT_OPTIONS.map(opt=><button key={opt.id} aria-label={`${opt.label}色`} aria-pressed={settings.accent===opt.id} onClick={()=>updateSettings({accent:opt.id})} style={{background:opt.color}}>{settings.accent===opt.id&&<IconCheck size={15}/>}</button>)}</div>
          <label>文字大小</label><div className="settings-segments">{FONT_OPTIONS.map(opt=><button key={opt.id} aria-pressed={settings.fontSize===opt.id} onClick={()=>updateSettings({fontSize:opt.id})}>{opt.label}</button>)}</div>
          <label htmlFor="settings-transparency">玻璃透明度 <span className="muted-copy">{settings.transparency??100}</span></label><input id="settings-transparency" type="range" min={0} max={175} value={settings.transparency??100} onChange={e=>updateSettings({transparency:Number(e.target.value)})}/>
          <SettingToggle title="减少动态效果" description="保留玻璃层次，关闭浮动和过渡动画。" checked={settings.reduceMotion} onChange={reduceMotion=>updateSettings({reduceMotion})}/>
        </SettingsGroup>
        <SettingsGroup title="桌宠陪伴">
          <div className="settings-choice-list">{PET_MODE_OPTIONS.map(mode=><button key={mode} aria-pressed={petMode===mode} onClick={()=>handlePetModeChange(mode)}><span><strong>{WINDOW_INTERACTION_LABEL[mode]}</strong><small>{WINDOW_INTERACTION_HINT[mode]}</small></span>{petMode===mode&&<IconCheck size={17}/>}</button>)}</div>
          <p className="muted-copy">标准与增强模式只使用窗口位置做避让，敏感窗口会在本机过滤。</p>
        </SettingsGroup>
      </div>
      <div hidden={category!=='services'} className="settings-page">
        <SettingsGroup title="数据与文字服务" description="根据需要连接，彼此独立。">
          <details className="settings-disclosure"><summary>Notion 日程 <span>{notionConnected?'已连接':'未连接'}</span></summary>
            <label htmlFor="settings-notion-token">Notion Token</label><input id="settings-notion-token" type="password" autoComplete="off" value={tokenInput} onChange={e=>{setTokenInput(e.target.value);setSaved('');}} placeholder="ntn_..." className="input-field"/>
            <button className="btn-primary" onClick={()=>saveConnection('notion')}>{saved==='notion'?'已保存':'保存 Notion 连接'}</button>
            <button onClick={handleClearCache} className="text-button">清除凭据缓存</button>
          </details>
          <details className="settings-disclosure"><summary>文字 AI <span>{settings.aiEndpoint?'已配置':'未配置'}</span></summary>
            <p className="muted-copy">未通话时用于文字聊天，与语音服务独立。</p>
            <label htmlFor="settings-ai-endpoint">服务端点</label><input id="settings-ai-endpoint" value={endpointInput} onChange={e=>{setEndpointInput(e.target.value);setSaved('');}} className="input-field"/>
            <label htmlFor="settings-ai-model">模型</label><input id="settings-ai-model" value={modelInput} onChange={e=>{setModelInput(e.target.value);setSaved('');}} className="input-field"/>
            <button className="btn-primary" onClick={()=>saveConnection('ai')}>{saved==='ai'?'已保存':'保存文字 AI'}</button>
          </details>
          <details className="settings-disclosure"><summary>Hermes 看板 <span>{settings.kanbanEndpoint?'已配置':'未配置'}</span></summary>
            <label htmlFor="settings-kanban">看板地址</label><input id="settings-kanban" value={kanbanInput} onChange={e=>{setKanbanInput(e.target.value);setSaved('');}} placeholder="https://你的服务/kanban.json" className="input-field"/>
            <button className="btn-primary" onClick={()=>saveConnection('kanban')}>{saved==='kanban'?'已保存':'保存看板连接'}</button>
          </details>
        </SettingsGroup>
        <SettingsGroup title="应用">
          <SettingToggle title="开机自启动" checked={autostartEnabled} onChange={()=>void handleToggleAutostart()}/>
          <div className="setting-row"><strong>应用更新</strong><button className="text-button" onClick={()=>void handleCheckUpdate()} disabled={checking}>{checking?'检查中…':'检查更新'}</button></div>
          {updateStatus&&<p role="status" className="service-status">{updateStatus}</p>}
          <AppVersion/>
        </SettingsGroup>
      </div>
    </div>
  </div>;
}

function AppVersion() {
  const [ver,setVer]=useState('');
  useEffect(()=>{import('@tauri-apps/api/app').then(({getVersion})=>getVersion()).then(setVer).catch(()=>{});},[]);
  return <p className="settings-version">AntDesk {ver?`v${ver}`:''}</p>;
}

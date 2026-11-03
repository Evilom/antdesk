import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { createVoiceClient, hasVoiceKey, setVoiceKey } from '../lib/assistant';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { remember } from '../lib/pm';
import {SettingsGroup, SettingToggle} from './SettingsControls';

export type AssistantSettingsArea = 'voice' | 'memory' | 'briefing';
export default function AssistantSettings({area, voiceState}: {area:AssistantSettingsArea|null; voiceState:string}) {
  const {settings, updateSettings} = useAppStore();
  const [url, setUrl] = useState(settings.voiceGatewayUrl);
  const [key, setKey] = useState('');
  const [keyReady, setKeyReady] = useState(false);
  const [status, setStatus] = useState('');
  const [testing, setTesting] = useState(false);
  const [directories,setDirectories]=useState<string[]>([]);
  const [directory,setDirectory]=useState('');
  const [pmStatus,setPmStatus]=useState('');
  const [memory,setMemory]=useState('');
  const [memories,setMemories]=useState<Array<{text:string;source:string;created:number}>>([]);
  const [pmBusy,setPmBusy]=useState(false);
  const reloadMemory=()=>invoke<{recall:{memories:Array<{text:string;source:string;created:number}>}}>('pm_context',{query:''}).then(v=>setMemories(v.recall.memories));
  useEffect(()=>{
    if(!isTauri() || area!=='memory')return;
    void invoke<string[]>('pm_directories').then(setDirectories).catch(e=>setPmStatus(String(e)));
    void reloadMemory().catch(e=>setPmStatus(String(e)));
  },[area]);
  useEffect(() => { void hasVoiceKey().then(setKeyReady).catch(() => {}); }, []);
  const active = !['idle','disconnected'].includes(voiceState);
  const connect = async () => {
    if (testing || active) return;
    setTesting(true); setStatus('正在检查连接…');
    try {
      if (key.trim()) {await setVoiceKey(key); setKey('');}
      const ready = await hasVoiceKey(); setKeyReady(ready);
      if (!ready) throw new Error('请输入语音网关为 AntDesk 签发的设备密钥');
      const candidate = {...settings, voiceGatewayUrl: url.trim()};
      const client = createVoiceClient(candidate, new Audio(), '');
      await client.request('/v1/capabilities', {timeout: 8000});
      updateSettings({voiceGatewayUrl: candidate.voiceGatewayUrl});
      setStatus('服务验证通过，配置已保存。返回助理即可开始通话。');
    } catch (e) {setStatus(e instanceof Error ? e.message : String(e));}
    finally {setTesting(false);}
  };
  return <>
    <div hidden={area!=='voice'} className="settings-page connection-settings">
    <div className="settings-call-status" role="status"><span className={active?'live-dot':''}/><div><strong>{voiceState==='stopping'?'正在断开':voiceState==='connected'?'通话中':active?'正在连接':'未通话'}</strong><p>{active?'修改服务地址或密钥前请先结束通话。':'点击麦克风按钮即可发起语音通话。'}</p></div></div>
    <SettingsGroup title="语音服务" description={keyReady?'设备密钥已配置。':'连接本地或远程语音网关。'}>
    {isTauri()&&<button type="button" className="btn-primary mt-3" disabled={testing||active} onClick={async()=>{
      if(testing||active)return;
      setTesting(true);setStatus('正在连接本机语音…');
      try{const result=await invoke<{baseUrl:string;ready:boolean}>('connect_local_voice');setUrl(result.baseUrl);setKeyReady(result.ready);updateSettings({voiceGatewayUrl:result.baseUrl});setStatus('本机语音服务已就绪。');}
      catch(e){setStatus(String(e));}finally{setTesting(false);}
    }}>{testing?'连接中…':'自动连接本机语音'}</button>}
    <details className="settings-disclosure"><summary>服务地址与设备密钥</summary>
    <label htmlFor="voice-gateway">语音服务地址</label>
    <input id="voice-gateway" disabled={testing||active} className="input-field" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:6080"/>
    <label htmlFor="voice-device-key">设备密钥 {keyReady && <span>· 已就绪</span>}</label>
    <input id="voice-device-key" disabled={testing||active} type="password" autoComplete="off" className="input-field" value={key} onChange={e => setKey(e.target.value)} placeholder={keyReady ? '已配置，留空沿用' : '输入设备密钥'}/>
    <p className="muted-copy mt-2">填写语音网关签发的设备密钥（非 ChatGPT 登录令牌）。</p>
    <button type="button" className="btn-primary mt-3" onClick={() => void connect()} disabled={testing||active}>{testing ? '检查中…' : '验证并保存'}</button>
    </details>
    {status && <p role="status" className="service-status">{status}</p>}
    </SettingsGroup>
    <SettingsGroup title="语音设置" description="切换后在下次通话生效。">
    <label htmlFor="assistant-voice">音色</label>
    <select id="assistant-voice" value={settings.voiceName} onChange={e => updateSettings({voiceName: e.target.value})} className="input-field">
      {['juniper', 'breeze', 'cove', 'ember', 'fathom', 'glimmer', 'maple', 'orbit', 'vale'].map(voice => <option key={voice} value={voice}>{voice[0].toUpperCase() + voice.slice(1)}</option>)}
    </select>
    <p className="muted-copy">对话上下文持续保留，点击“新对话”可重置。</p>
    </SettingsGroup>
    </div>
    <div hidden={area!=='memory'} className="settings-page connection-settings">
    <SettingsGroup title="项目目录" description="授权读取本地项目或资料文件夹。">
      <label htmlFor="pm-directory">本地文件夹路径</label>
      <input id="pm-directory" className="input-field" placeholder="粘贴本地文件夹路径" value={directory} onChange={e=>setDirectory(e.target.value)}/>
      <button type="button" className="text-button" disabled={!isTauri()||!directory.trim()||pmBusy} onClick={async()=>{
        setPmBusy(true);try{setDirectories(await invoke('pm_add_directory',{path:directory}));setDirectory('');setPmStatus('目录已添加。');}catch(e){setPmStatus(String(e));}finally{setPmBusy(false);}
      }}>添加目录</button>
      <p className="muted-copy">仅只读检索文本文件，自动跳过隐藏目录、密钥与构建产物。</p>
      {directories.map(path=><div className="pm-task" key={path}><span style={{overflowWrap:'anywhere'}}>{path}</span><button className="text-button" disabled={pmBusy} onClick={async()=>{setPmBusy(true);try{setDirectories(await invoke('pm_remove_directory',{path}));setPmStatus('已移除该目录。');}catch(e){setPmStatus(String(e));}finally{setPmBusy(false);}}}>移除</button></div>)}
      {!directories.length&&<p className="muted-copy">暂未添加目录。</p>}
    </SettingsGroup>
    <SettingsGroup title="长期记忆" description="跨对话保留的偏好与备忘。">
      <label htmlFor="pm-memory">新增记忆</label>
      <textarea id="pm-memory" className="input-field" maxLength={2000} rows={3} value={memory} onChange={e=>setMemory(e.target.value)} placeholder="例如：本周先完成湃特蒙首发验收，新增想法进入候选池。"/>
      <button type="button" className="text-button" disabled={!isTauri()||!memory.trim()||pmBusy} onClick={async()=>{setPmBusy(true);try{await remember(memory,`用户在设置保存:${crypto.randomUUID()}`);setMemory('');await reloadMemory();setPmStatus('已保存。');}catch(e){setPmStatus(String(e));}finally{setPmBusy(false);}}}>保存记忆</button>
      <p className="muted-copy">也可在对话中发送“记住：……”快速添加。</p>
      {!!memories.length&&<details><summary>已保存记忆（{memories.length}）</summary>{memories.map((m,i)=><div className="pm-task" key={i}><strong>{m.text}</strong><span>{new Date(m.created*1000).toLocaleString()} · {m.source}</span></div>)}</details>}
      {pmStatus&&<p role="status" className="service-status">{pmStatus}</p>}
    </SettingsGroup>

    </div>
    <div hidden={area!=='briefing'} className="settings-page connection-settings">
    <SettingsGroup title="主动提醒">
      <SettingToggle title="通话中主动汇报" description="日程变更或 Codex 任务完成时在通话中简短提醒。" checked={settings.autoBriefing} onChange={autoBriefing=>updateSettings({autoBriefing})}/>
      <SettingToggle title="项目关键事件简报" description="Git 提交、CI 检查或工作包变更时生成简报。" checked={settings.projectBriefingEvents} onChange={projectBriefingEvents=>updateSettings({projectBriefingEvents})}/>
    </SettingsGroup>
    <SettingsGroup title="每日项目简报">
      <SettingToggle title="定时简报" description="按设定时间自动生成今日项目简报。" checked={Boolean(settings.projectBriefingTime)} onChange={enabled=>updateSettings({projectBriefingTime:enabled?'18:00':''})}/>
      {settings.projectBriefingTime&&<><label htmlFor="project-briefing-time">生成时间</label><input id="project-briefing-time" type="time" className="input-field" value={settings.projectBriefingTime} onChange={e=>updateSettings({projectBriefingTime:e.target.value})}/></>}
      <p className="muted-copy">仅在应用运行期间生成；通话中且开启主动汇报时会自动播报。</p>
    </SettingsGroup>
    </div>
  </>;
}

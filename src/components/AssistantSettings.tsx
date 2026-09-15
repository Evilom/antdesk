import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { createVoiceClient, getKnowledgeStatus, hasVoiceKey, setVoiceKey } from '../lib/assistant';
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
  const [knowledgeStatus, setKnowledgeStatus] = useState('');
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
    <div className="settings-call-status" role="status"><span className={active?'live-dot':''}/><div><strong>{voiceState==='stopping'?'正在释放旧通话':voiceState==='connected'?'通话保持中':active?'语音连接中':'当前未通话'}</strong><p>{active?'修改服务地址或密钥前，请先结束通话。':'点击助理或宠物的麦克风，开始聊天。'}</p></div></div>
    <SettingsGroup title="语音服务" description={keyReady?'设备密钥已配置，通话状态以助理中的显示为准。':'首次使用，先连接本机语音服务。'}>
    {isTauri()&&<button type="button" className="btn-primary mt-3" disabled={testing||active} onClick={async()=>{
      if(testing||active)return;
      setTesting(true);setStatus('正在连接本机语音…');
      try{const result=await invoke<{baseUrl:string;ready:boolean}>('connect_local_voice');setUrl(result.baseUrl);setKeyReady(result.ready);updateSettings({voiceGatewayUrl:result.baseUrl});setStatus('本机服务配置已就绪。返回助理即可开始通话。');}
      catch(e){setStatus(String(e));}finally{setTesting(false);}
    }}>{testing?'连接中…':'自动连接本机语音'}</button>}
    <details className="settings-disclosure"><summary>服务地址与设备密钥</summary>
    <label htmlFor="voice-gateway">语音服务地址</label>
    <input id="voice-gateway" disabled={testing||active} className="input-field" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:6080"/>
    <label htmlFor="voice-device-key">设备密钥 {keyReady && <span>· 已就绪</span>}</label>
    <input id="voice-device-key" disabled={testing||active} type="password" autoComplete="off" className="input-field" value={key} onChange={e => setKey(e.target.value)} placeholder={keyReady ? '已配置，留空继续使用' : '输入设备密钥'}/>
    <p className="muted-copy mt-2">Mac 桌面端会将设备密钥保存在系统钥匙串，重启后可继续使用；其他平台可通过本机环境变量提供。不要填 ChatGPT 登录令牌。</p>
    <button type="button" className="btn-primary mt-3" onClick={() => void connect()} disabled={testing||active}>{testing ? '检查中…' : '验证并保存'}</button>
    </details>
    {status && <p role="status" className="service-status">{status}</p>}
    </SettingsGroup>
    <SettingsGroup title="说话方式" description="声音在下一次通话生效。">
    <label htmlFor="assistant-voice">助理声音</label>
    <select id="assistant-voice" value={settings.voiceName} onChange={e => updateSettings({voiceName: e.target.value})} className="input-field">
      {['juniper', 'breeze', 'cove', 'ember', 'fathom', 'glimmer', 'maple', 'orbit', 'vale'].map(voice => <option key={voice} value={voice}>{voice[0].toUpperCase() + voice.slice(1)}</option>)}
    </select>

    <p className="muted-copy">对话持续保留，跨午夜也不自动新建。网页语音网关支持续期时保持当前连接；真正断线后从过去 24 小时记录接着聊。电脑需保持运行和联网，网页服务的额度或中断仍可能结束语音。</p>
    <p className="muted-copy">只有点击“新对话”才另开聊天。麦克风按钮开启语音，尚未启用唤醒词。</p>
    </SettingsGroup>
    </div>
    <div hidden={area!=='memory'} className="settings-page connection-settings">
    <SettingsGroup title="Hermes 知识库">
    <SettingToggle title="关联 Hermes 知识" description="提问时检索相关资料，并保留来源。" checked={settings.knowledgeEnabled} onChange={knowledgeEnabled=>updateSettings({knowledgeEnabled})}/>
    <button className="text-button" onClick={() => {
      setKnowledgeStatus('检查中…');
      void getKnowledgeStatus().then(s => setKnowledgeStatus(s.authenticated ? '本机 QMD 索引可访问，复用 Hermes 原有凭据。' : 'QMD 正在运行，但未找到本机凭据。')).catch(e => setKnowledgeStatus(e instanceof Error ? e.message : String(e)));
    }}>检查知识库连接</button>
    {knowledgeStatus && <p role="status" className="service-status">{knowledgeStatus}</p>}

    </SettingsGroup>
    <SettingsGroup title="项目目录" description="只读取这台设备明确连接的文件夹。">
      <label htmlFor="pm-directory">这台设备允许读取的项目或参考文件夹</label>
      <input id="pm-directory" className="input-field" placeholder="安装后选择本设备的文件夹路径" value={directory} onChange={e=>setDirectory(e.target.value)}/>
      <button type="button" className="text-button" disabled={!isTauri()||!directory.trim()||pmBusy} onClick={async()=>{
        setPmBusy(true);try{setDirectories(await invoke('pm_add_directory',{path:directory}));setDirectory('');setPmStatus('目录已连接，相关文本片段会随提问提供给语音或文字服务。');}catch(e){setPmStatus(String(e));}finally{setPmBusy(false);}
      }}>连接目录</button>
      <p className="muted-copy">按问题读取文本并保留来源；跳过隐藏配置、密钥文件、依赖和构建目录。这里不修改文件。</p>
      {directories.map(path=><div className="pm-task" key={path}><span style={{overflowWrap:'anywhere'}}>{path}</span><button className="text-button" disabled={pmBusy} onClick={async()=>{setPmBusy(true);try{setDirectories(await invoke('pm_remove_directory',{path}));setPmStatus('已停止读取该目录。既有对话中的引用仍保留。');}catch(e){setPmStatus(String(e));}finally{setPmBusy(false);}}}>断开</button></div>)}
      {!directories.length&&<p className="muted-copy">尚未连接目录。</p>}
    </SettingsGroup>
    <SettingsGroup title="长期记忆" description="对话结束或切换后，保存的安排与偏好仍可找回。">
      <label htmlFor="pm-memory">长期记住的安排或偏好</label>
      <textarea id="pm-memory" className="input-field" maxLength={2000} rows={3} value={memory} onChange={e=>setMemory(e.target.value)} placeholder="例如：本周先完成语音助手，再处理网站改版。"/>
      <button type="button" className="text-button" disabled={!isTauri()||!memory.trim()||pmBusy} onClick={async()=>{setPmBusy(true);try{await remember(memory,`用户在设置保存:${crypto.randomUUID()}`);setMemory('');await reloadMemory();setPmStatus('长期记忆已保存，新对话仍可使用。');}catch(e){setPmStatus(String(e));}finally{setPmBusy(false);}}}>记住这件事</button>
      <p className="muted-copy">也可以在对话中说“记住：……”。对话记录与长期记忆独立保存在本机，不会随通话结束清空。</p>
      {!!memories.length&&<details><summary>最近保存的记忆（{memories.length}）</summary>{memories.map((m,i)=><div className="pm-task" key={i}><strong>{m.text}</strong><span>{new Date(m.created*1000).toLocaleString()} · {m.source}</span></div>)}</details>}
      {pmStatus&&<p role="status" className="service-status">{pmStatus}</p>}
    </SettingsGroup>

    </div>
    <div hidden={area!=='briefing'} className="settings-page connection-settings">
    <SettingsGroup title="主动提醒" description="开关即时保存，可按需要开启。">
      <SettingToggle title="通话中主动汇报" description="日程发生变化、Codex 最近一轮完成或中断时简短提醒。" checked={settings.autoBriefing} onChange={autoBriefing=>updateSettings({autoBriefing})}/>
      <SettingToggle title="项目关键事件简报" description="提交、检查或工作包变化后留一条简报，两分钟内合并提醒。" checked={settings.projectBriefingEvents} onChange={projectBriefingEvents=>updateSettings({projectBriefingEvents})}/>
    </SettingsGroup>
    <SettingsGroup title="每日项目简报" description="按本机时间生成文字简报。">
      <SettingToggle title="定时简报" checked={Boolean(settings.projectBriefingTime)} onChange={enabled=>updateSettings({projectBriefingTime:enabled?'18:00':''})}/>
      {settings.projectBriefingTime&&<><label htmlFor="project-briefing-time">汇报时间</label><input id="project-briefing-time" type="time" className="input-field" value={settings.projectBriefingTime} onChange={e=>updateSettings({projectBriefingTime:e.target.value})}/></>}
      <p className="muted-copy">应用运行时生成；正在通话且开启主动汇报时才播报。休眠或退出期间不唤醒电脑，超过半小时的简报不补发。</p>
    </SettingsGroup>
    </div>
  </>;
}

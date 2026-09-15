import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { createVoiceClient, getKnowledgeStatus, hasVoiceKey, setVoiceKey } from '../lib/assistant';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { remember } from '../lib/pm';

export default function AssistantSettings() {
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
    if(!isTauri())return;
    void invoke<string[]>('pm_directories').then(setDirectories).catch(e=>setPmStatus(String(e)));
    void reloadMemory().catch(e=>setPmStatus(String(e)));
  },[]);
  useEffect(() => { void hasVoiceKey().then(setKeyReady).catch(() => {}); }, []);
  const connect = async () => {
    setTesting(true); setStatus('正在检查连接…');
    try {
      if (key.trim()) {await setVoiceKey(key); setKey('');}
      const ready = await hasVoiceKey(); setKeyReady(ready);
      if (!ready) throw new Error('请输入语音网关为 AntDesk 签发的设备密钥');
      const candidate = {...settings, voiceGatewayUrl: url.trim()};
      const client = createVoiceClient(candidate, new Audio(), '');
      await client.request('/v1/capabilities', {timeout: 8000});
      updateSettings({voiceGatewayUrl: candidate.voiceGatewayUrl});
      setStatus('语音网关已连接。可返回助理开始通话。');
    } catch (e) {setStatus(e instanceof Error ? e.message : String(e));}
    finally {setTesting(false);}
  };
  return <section className="card connection-settings p-4">
    <h3>个人 PM 助手</h3>
    <p className="muted-copy">连接已有的 ChatGPT 语音服务，在 AntDesk 中实时聊天。</p>
    {isTauri()&&<button type="button" className="btn-primary mt-3" disabled={testing} onClick={async()=>{
      setTesting(true);setStatus('正在连接本机语音…');
      try{const result=await invoke<{baseUrl:string;ready:boolean}>('connect_local_voice');setUrl(result.baseUrl);setKeyReady(result.ready);updateSettings({voiceGatewayUrl:result.baseUrl});setStatus('本机语音已连接，返回宠物点麦克风即可。');}
      catch(e){setStatus(String(e));}finally{setTesting(false);}
    }}>{testing?'连接中…':'自动连接本机语音'}</button>}
    <details open={!isTauri()}><summary>手动连接其他语音网关</summary>
    <label htmlFor="voice-gateway">语音服务地址</label>
    <input id="voice-gateway" className="input-field" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:6080"/>
    <label htmlFor="voice-device-key">设备密钥 {keyReady && <span>· 已就绪</span>}</label>
    <input id="voice-device-key" type="password" autoComplete="off" className="input-field" value={key} onChange={e => setKey(e.target.value)} placeholder={keyReady ? '已配置，留空继续使用' : '输入设备密钥'}/>
    <p className="muted-copy mt-2">Mac 桌面端会将设备密钥保存在系统钥匙串，重启后可继续使用；其他平台可通过本机环境变量提供。不要填 ChatGPT 登录令牌。</p>
    <button type="button" className="btn-primary mt-3" onClick={() => void connect()} disabled={testing}>{testing ? '检查中…' : '连接语音服务'}</button>
    </details>
    {status && <p role="status" className="service-status">{status}</p>}
    <label htmlFor="assistant-voice">助理声音</label>
    <select id="assistant-voice" value={settings.voiceName} onChange={e => updateSettings({voiceName: e.target.value})} className="input-field">
      {['juniper', 'breeze', 'cove', 'ember', 'fathom', 'glimmer', 'maple', 'orbit', 'vale'].map(voice => <option key={voice} value={voice}>{voice[0].toUpperCase() + voice.slice(1)}</option>)}
    </select><p className="muted-copy mt-2">在下一次通话生效。</p>
    <label className="setting-row"><div><strong>关联 Hermes 知识</strong><small>按当前问题检索，只将相关来源带入助理对话。</small></div><input type="checkbox" checked={settings.knowledgeEnabled} onChange={e => updateSettings({knowledgeEnabled: e.target.checked})}/></label>
    <button className="text-button" onClick={() => {
      setKnowledgeStatus('检查中…');
      void getKnowledgeStatus().then(s => setKnowledgeStatus(s.authenticated ? '本机 QMD 索引可访问，复用 Hermes 原有凭据。' : 'QMD 正在运行，但未找到本机凭据。')).catch(e => setKnowledgeStatus(e instanceof Error ? e.message : String(e)));
    }}>检查知识库连接</button>
    {knowledgeStatus && <p role="status" className="service-status">{knowledgeStatus}</p>}
    <label className="setting-row"><div><strong>通话中主动汇报</strong><small>每两分钟同步日程，Codex 最近一轮完成或中断时简短提醒。</small></div><input type="checkbox" checked={settings.autoBriefing} onChange={e => updateSettings({autoBriefing: e.target.checked})}/></label>
    <label className="setting-row"><div><strong>项目关键事件简报</strong><small>提交、检查结果或工作包变化后自动留一条简报；两分钟内合并提醒。</small></div><input type="checkbox" checked={settings.projectBriefingEvents} onChange={e=>updateSettings({projectBriefingEvents:e.target.checked})}/></label>
    <label htmlFor="project-briefing-time">每日项目简报</label>
    <input id="project-briefing-time" type="time" className="input-field" value={settings.projectBriefingTime} onChange={e=>updateSettings({projectBriefingTime:e.target.value})}/>
    <button className="text-button" onClick={()=>updateSettings({projectBriefingTime:''})}>关闭定时简报</button>
    <p className="muted-copy">按本机时间，在应用运行时生成文字简报；已开启主动汇报且正在通话时才播报。休眠或退出期间不唤醒电脑，超过半小时的错过简报不补发。</p>
    <p className="muted-copy">当前没有后台唤醒词检测。点击宠物麦克风才开始通话，静音时不发送麦克风音频。</p>
    <details className="pm-settings" open>
      <summary>本机目录与长期记忆</summary>
      <p className="muted-copy mt-2">点宠物麦克风即可持续通话。断网后自动重连；新对话保留本机历史并按问题找回。账号额度耗尽或麦克风权限关闭时会停止。</p>
      <label htmlFor="pm-directory">这台设备允许读取的项目或参考文件夹</label>
      <input id="pm-directory" className="input-field" placeholder="安装后选择本设备的文件夹路径" value={directory} onChange={e=>setDirectory(e.target.value)}/>
      <button type="button" className="text-button" disabled={!isTauri()||!directory.trim()||pmBusy} onClick={async()=>{
        setPmBusy(true);try{setDirectories(await invoke('pm_add_directory',{path:directory}));setDirectory('');setPmStatus('目录已连接，相关文本片段会随提问提供给语音或文字服务。');}catch(e){setPmStatus(String(e));}finally{setPmBusy(false);}
      }}>连接目录</button>
      <p className="muted-copy">按问题读取文本并保留来源；跳过隐藏配置、密钥文件、依赖和构建目录。这里不修改文件。</p>
      {directories.map(path=><div className="pm-task" key={path}><span style={{overflowWrap:'anywhere'}}>{path}</span><button className="text-button" disabled={pmBusy} onClick={async()=>{setPmBusy(true);try{setDirectories(await invoke('pm_remove_directory',{path}));setPmStatus('已停止读取该目录。既有对话中的引用仍保留。');}catch(e){setPmStatus(String(e));}finally{setPmBusy(false);}}}>断开</button></div>)}
      {!directories.length&&<p className="muted-copy">尚未连接目录。</p>}
      <label htmlFor="pm-memory">长期记住的安排或偏好</label>
      <textarea id="pm-memory" className="input-field" maxLength={2000} rows={3} value={memory} onChange={e=>setMemory(e.target.value)} placeholder="例如：本周先完成语音助手，再处理网站改版。"/>
      <button type="button" className="text-button" disabled={!isTauri()||!memory.trim()||pmBusy} onClick={async()=>{setPmBusy(true);try{await remember(memory,`用户在设置保存:${crypto.randomUUID()}`);setMemory('');await reloadMemory();setPmStatus('长期记忆已保存，新对话仍可使用。');}catch(e){setPmStatus(String(e));}finally{setPmBusy(false);}}}>记住这件事</button>
      <p className="muted-copy">也可以在对话中说“记住：……”。对话记录与长期记忆独立保存在本机，不会随通话结束清空。</p>
      {!!memories.length&&<details><summary>最近保存的记忆（{memories.length}）</summary>{memories.map((m,i)=><div className="pm-task" key={i}><strong>{m.text}</strong><span>{new Date(m.created*1000).toLocaleString()} · {m.source}</span></div>)}</details>}
      {pmStatus&&<p role="status" className="service-status">{pmStatus}</p>}
    </details>
    <label className="setting-row"><div><strong>减少动态效果</strong><small>保留玻璃层次，关闭浮动与过渡动画。</small></div><input type="checkbox" checked={settings.reduceMotion} onChange={e => updateSettings({reduceMotion: e.target.checked})}/></label>
  </section>;
}

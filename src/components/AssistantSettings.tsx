import { useEffect, useState } from 'react';
import { useAppStore } from '../stores/appStore';
import { createVoiceClient, getKnowledgeStatus, hasVoiceKey, setVoiceKey } from '../lib/assistant';

export default function AssistantSettings() {
  const {settings, updateSettings} = useAppStore();
  const [url, setUrl] = useState(settings.voiceGatewayUrl);
  const [key, setKey] = useState('');
  const [keyReady, setKeyReady] = useState(false);
  const [status, setStatus] = useState('');
  const [testing, setTesting] = useState(false);
  const [knowledgeStatus, setKnowledgeStatus] = useState('');
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
    <h3>助理与知识</h3>
    <p className="muted-copy">连接已有的 ChatGPT 语音服务，在 AntDesk 中实时聊天。</p>
    <label htmlFor="voice-gateway">语音服务地址</label>
    <input id="voice-gateway" className="input-field" value={url} onChange={e => setUrl(e.target.value)} placeholder="http://127.0.0.1:6080"/>
    <label htmlFor="voice-device-key">设备密钥 {keyReady && <span>· 已就绪</span>}</label>
    <input id="voice-device-key" type="password" autoComplete="off" className="input-field" value={key} onChange={e => setKey(e.target.value)} placeholder={keyReady ? '已配置，留空继续使用' : '输入设备密钥'}/>
    <p className="muted-copy mt-2">密钥仅在本次运行中使用；也可通过本机环境变量提供。不要填 ChatGPT 登录令牌。</p>
    <button type="button" className="btn-primary mt-3" onClick={() => void connect()} disabled={testing}>{testing ? '检查中…' : '连接语音服务'}</button>
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
    <label className="setting-row"><div><strong>通话中主动汇报</strong><small>每两分钟同步日程，到期任务变化时提醒一次。</small></div><input type="checkbox" checked={settings.autoBriefing} onChange={e => updateSettings({autoBriefing: e.target.checked})}/></label>
    <label className="setting-row"><div><strong>减少动态效果</strong><small>保留玻璃层次，关闭浮动与过渡动画。</small></div><input type="checkbox" checked={settings.reduceMotion} onChange={e => updateSettings({reduceMotion: e.target.checked})}/></label>
  </section>;
}

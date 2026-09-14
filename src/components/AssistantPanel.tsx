import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { ArrowUp, BookOpen, ChevronLeft, Headphones, Mic, MicOff, PhoneOff, Search, Settings2, Sparkles, Square, Volume2, X } from 'lucide-react';
import { useAppStore } from '../stores/appStore';
import { sendChatMessage } from '../lib/chat';
import { ASSISTANT_PERSONA, agendaContext, briefingSignature, createVoiceClient, getKnowledgeStatus, hasVoiceKey, knowledgeContext, readKnowledge, searchKnowledge, type KnowledgeSource, type KnowledgeStatus } from '../lib/assistant';
import type { Caption, RealtimeAssistant } from '../lib/vendor/realtime-client.mjs';
import { useDialogFocus } from '../lib/useDialogFocus';
import { codexStatus, loadHistory, localContext, packContext, PM_INSTRUCTIONS, publish, remember, saveMessages, subscribe, TASK_LABELS, type CodexSnapshot, type PetSnapshot, type LocalContext } from '../lib/pm';

export const VOICE_LABELS: Record<string, string> = { idle: '随时聊聊', checking: '检查语音服务', microphone: '等待麦克风授权', connecting: '正在连接', connected: '正在通话', reconnecting: '正在重新连接', disconnected: '通话已结束' };
interface Message { id: string; role: 'user' | 'assistant'; text: string; sources?: KnowledgeSource[] }
interface Props { open: boolean; onClose: () => void; onSettings: () => void; onState: (state: string) => void; requestBriefing: number }

export default function AssistantPanel({ open, onClose, onSettings, onState, requestBriefing }: Props) {
  const { settings, todos, projects, reports, notionConnected } = useAppStore();
  const [voiceState, setVoiceState] = useState('idle');
  const [muted, setMuted] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [memoryReady, setMemoryReady] = useState(false);
  const [memoryError, setMemoryError] = useState('');
  const [workOpen, setWorkOpen] = useState(false);
  const [work, setWork] = useState<CodexSnapshot | null>(null);
  const [workError, setWorkError] = useState('');
  const [memoryNotice, setMemoryNotice] = useState('');
  const conversationRef = useRef(crypto.randomUUID() as string);
  const messagesRef = useRef<Message[]>([]);
  messagesRef.current = messages;
  const petRef = useRef<PetSnapshot | null>(null);
  const commandRef = useRef<(action:string)=>void>(()=>{});
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [knowledge, setKnowledge] = useState<KnowledgeStatus | null>(null);
  const [knowledgeError, setKnowledgeError] = useState('');
  const [query, setQuery] = useState('');
  const [semantic, setSemantic] = useState(false);
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [searching, setSearching] = useState(false);
  const [document, setDocument] = useState<{title: string; text: string} | null>(null);
  const clientRef = useRef<RealtimeAssistant | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const captionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastCaption = useRef('');
  const sentIds = useRef(new Set<string>());
  const voiceEpoch = useRef(0);
  const requestEpoch = useRef(0);
  const operationBusy = useRef(false);
  const latest = useRef({ settings, todos, projects, reports, notionConnected });
  latest.current = { settings, todos, projects, reports, notionConnected };
  const voiceActive = !['idle', 'disconnected'].includes(voiceState);
  const connected = voiceState === 'connected';
  const dialogRef = useDialogFocus(open, onClose);
  const context = () => { const s = latest.current; return agendaContext(s.todos, s.projects, s.reports, s.notionConnected); };

  useEffect(() => {
    let active = true;
    void loadHistory().then(saved => {
      if (!active) return;
      if (saved.conversation) conversationRef.current = saved.conversation;
      setMessages(saved.messages); setMemoryReady(true);
    }).catch(e => { if (active) setMemoryError(`历史记录读取失败：${String(e)}。请先检查本机存储，避免新对话覆盖未读记录。`); });
    return ()=>{active=false;};
  }, []);
  useEffect(() => {
    if (!memoryReady || !messages.length) return;
    const conversation = conversationRef.current;
    const timer=setTimeout(()=>void saveMessages(conversation,messages).then(()=>{
      setMemoryError('');
      // Bound rendering during all-day calls; the durable journal retains older messages.
      setMessages(current=>current===messages&&current.length>120?current.slice(-100):current);
    }).catch(e=>setMemoryError(`对话尚未保存：${String(e)}`)),400);
    return ()=>clearTimeout(timer);
  }, [messages,memoryReady]);
  useEffect(() => {
    let disposed=false;const unlisten:Array<()=>void>=[];
    const subscriptions=[
      subscribe<PetSnapshot>('pm:pet:snapshot',value=>{petRef.current=value;}),
      subscribe<string>('pm:voice:command',action=>commandRef.current(action)),
      subscribe('pm:voice:request',()=>commandRef.current('status')),
    ];
    for (const subscription of subscriptions) void subscription.then(fn=>{if(disposed)fn();else unlisten.push(fn);});
    return ()=>{disposed=true;unlisten.forEach(fn=>fn());};
  }, []);
  const publishedStatus = {state:voiceState,muted,error,caption:messages.filter(m=>m.role==='assistant').at(-1)?.text.slice(-180)||''};
  useEffect(()=>{void publish('pm:voice:status',publishedStatus);},[voiceState,muted,error,messages]);

  const background = async (query='', includeWork=false) => {
    const [pm,codex]=await Promise.all([
      localContext(query).catch((e):LocalContext=>({error:String(e)})),
      (includeWork || /codex|工作|进度|任务|项目|状态|汇报/i.test(query)) ? codexStatus().catch(e=>({error:String(e)})) : Promise.resolve(null),
    ]);
    const pet=petRef.current;
    return `${ASSISTANT_PERSONA}\n${PM_INSTRUCTIONS}\n日程：${context().slice(0,900)}\n长期记忆：${packContext(pm.recall?.memories||[],1000)}\n相关历史（历史回答不是已验证事实）：${packContext(pm.recall?.history||[],800)}\n已连接目录：${packContext(pm.directories||[],300)}\n目录片段及来源：${packContext(pm.files||[],1500)}\n记忆状态：${pm.error||pm.reason||'本机存储可用'}\nCodex：${packContext(codex,1200)}\n宠物内部状态：${packContext(pet ? {...pet,stale:Date.now()-pet.observedAt>30000} : {available:false},500)}`;
  };

  useEffect(() => { onState(voiceState); }, [voiceState, onState]);
  useEffect(() => { transcriptRef.current?.scrollTo({top: transcriptRef.current.scrollHeight, behavior: 'instant'}); }, [messages, busy, open]);
  useEffect(() => {
    // getContext reads current data before each new WebRTC session.
  }, [todos, projects, reports, notionConnected]);
  useEffect(() => {
    if (!open || !settings.knowledgeEnabled || knowledge) return;
    let active = true;
    getKnowledgeStatus().then(v => { if (active) { setKnowledge(v); setKnowledgeError(''); } })
      .catch(e => { if (active) setKnowledgeError(String(e instanceof Error ? e.message : e)); });
    return () => { active = false; };
  }, [open, settings.knowledgeEnabled, knowledge]);
  useEffect(() => {
    const stop = () => { ++voiceEpoch.current; void saveMessages(conversationRef.current,messagesRef.current); clientRef.current?.stop(); abortRef.current?.abort(); };
    window.addEventListener('beforeunload', stop);
    return () => { window.removeEventListener('beforeunload', stop); stop(); if (captionTimer.current) clearTimeout(captionTimer.current); };
  }, []);

  const pushCaption = (caption: Caption) => {
    if (!caption.text.trim()) return;
    // Context sent over the relay is echoed as a user message. Never display or
    // retrieve against that echo, otherwise knowledge injection can loop.
    if (caption.role === 'user' && sentIds.current.has(caption.id)) return;
    const id = `voice:${caption.id || caption.role}`;
    setMessages(old => {
      const found = old.findIndex(m => m.id === id);
      const next = { id, role: caption.role, text: caption.text };
      return found < 0 ? [...old, next] : old.map((m, i) => i === found ? next : m);
    });
    if (caption.role !== 'user') return;
    if (captionTimer.current) clearTimeout(captionTimer.current);
    const epoch = voiceEpoch.current;
    captionTimer.current = setTimeout(async () => {
      const key = `${caption.id}:${caption.text}`;
      if (key === lastCaption.current) return;
      lastCaption.current = key;
      try {
        const memory=caption.text.match(/^(?:请)?(?:帮我)?记住[：:，,\s]*(.+)/s);
        let saved='';
        if(memory && !/^(了吗|吗|了没)[？?。]*$/.test(memory[1])) {
          await remember(memory[1],`${conversationRef.current}:${caption.id}`);
          saved='本机长期记忆已保存成功。';setMemoryNotice(saved);
        }
        const pm=await background(caption.text);
        const result = latest.current.settings.knowledgeEnabled && /知识|以前|之前|资料|记得|文档|项目|hermes/i.test(caption.text)
          ? await searchKnowledge(caption.text).catch(e=>{setKnowledgeError(String(e));return [];}) : [];
        if (epoch !== voiceEpoch.current || !clientRef.current?.wanted) return;
        setSources(result);
        if (saved || result.length || /目录|文件|codex|工作|状态|宠物|进度|记忆|记得|之前|以前|昨天|继续|上次|项目|汇报/i.test(caption.text)) {
          clientRef.current.sendText(`${pm}\n${saved}\n相关知识：${knowledgeContext(result).slice(0,1500)}\n这是对大师刚才问题“${caption.text.slice(0,300)}”的补充资料，请据此回答；没有新信息时无需重复回答。`.slice(0,8000));
        }
        if (result.length) {
          setMessages(old => [...old, {id: crypto.randomUUID(), role: 'assistant', text: '为这次对话找到了以下知识来源。', sources: result}]);
        }
      } catch (e) { setMemoryError(e instanceof Error ? e.message : String(e)); }
    }, 1100);
  };

  const startVoice = async (brief = false) => {
    if (clientRef.current?.wanted || !audioRef.current || operationBusy.current) return;
    if (!memoryReady) {setError('正在恢复记忆，请稍后再试；读取失败时请检查设置。');return;}
    operationBusy.current = true;
    setError(''); setMuted(false); setPlaybackBlocked(false);
    const epoch = ++voiceEpoch.current;
    try {
      if (!(await hasVoiceKey())) throw new Error('还没有配置语音设备密钥，请打开设置连接语音服务。');
      if (epoch !== voiceEpoch.current) return;
      const client = createVoiceClient(latest.current.settings, audioRef.current,
        `${ASSISTANT_PERSONA}\n当前日程数据：${context()}\n${brief ? '请先为大师做一个简短的今日汇报。未同步时请说明还没有日程数据。' : '简短打个招呼，然后等待大师说话。'}`);
      clientRef.current = client;
      client.getContext=async()=>`${await background('',true)}\n近期对话（仅作衔接，不重复回答历史问题）：${packContext(messagesRef.current.slice(-6).map(m=>({role:m.role,text:m.text.slice(-250)})),1700)}\n${brief?'请做一个简短的今日汇报。':'继续陪伴大师，简短问候后等待说话。'}`.slice(0,8000);
      sentIds.current.clear();
      client.addEventListener('sent', event => sentIds.current.add((event as CustomEvent<{id: string}>).detail.id));
      client.addEventListener('state', event => { if (clientRef.current === client) {const state=(event as CustomEvent<string>).detail;setVoiceState(state);if(state==='connected')setError('');} });
      client.addEventListener('caption', event => { if (clientRef.current === client) pushCaption((event as CustomEvent<Caption>).detail); });
      client.addEventListener('error', event => { if (clientRef.current === client) setError((event as CustomEvent<Error>).detail.message); });
      client.addEventListener('playbackblocked', () => setPlaybackBlocked(true));
      await client.start({voice: latest.current.settings.voiceName, language: 'zh-CN'});
    } catch (e) {
      if (epoch === voiceEpoch.current) { setError(e instanceof Error ? e.message : String(e)); setVoiceState('disconnected'); }
    } finally { operationBusy.current = false; }
  };
  const stopVoice = async () => {
    ++voiceEpoch.current;
    if (captionTimer.current) clearTimeout(captionTimer.current);
    setMuted(false); setVoiceState('disconnected');
    const client = clientRef.current; clientRef.current = null;
    await client?.stop();
    await saveMessages(conversationRef.current,messagesRef.current).catch(e=>setMemoryError(String(e)));
  };

  const send = async (text: string, attached?: KnowledgeSource[]) => {
    if (!text.trim() || operationBusy.current || !memoryReady) return;
    if (text.length > 4000) { setError('请将问题缩短到 4000 字以内'); return; }
    if (voiceActive && !connected) { setError('语音连接完成后即可发送'); return; }
    if (!connected && !settings.aiEndpoint.trim()) { setError('请先开始语音对话，或在设置中连接文字 AI 服务。'); return; }
    operationBusy.current = true;
    setError(''); setInput(''); setBusy(true);
    const epoch = ++requestEpoch.current;
    const user = {id: crypto.randomUUID(), role: 'user' as const, text};
    setMessages(old => [...old, user]);
    const controller = new AbortController(); abortRef.current = controller;
    try {
      let matches = attached || [];
      if (!attached && settings.knowledgeEnabled) {
        try { matches = await searchKnowledge(text); }
        catch (e) { setKnowledgeError(e instanceof Error ? e.message : String(e)); }
      }
      if (controller.signal.aborted || epoch !== requestEpoch.current) return;
      setSources(matches);
      const memory=text.match(/^(?:请)?(?:帮我)?记住[：:，,\s]*(.+)/s);
      let saved='';
      if(memory && !/^(了吗|吗|了没)[？?。]*$/.test(memory[1])) {await remember(memory[1],`${conversationRef.current}:${user.id}`);saved='本机长期记忆已保存成功。';setMemoryNotice(saved);}
      const prompt = `${await background(text)}\n${saved}\n引用资料：\n${knowledgeContext(matches).slice(0,1500) || '本次没有检索到相关资料。'}`;
      if (controller.signal.aborted || epoch !== requestEpoch.current) return;
      if (connected) {
        clientRef.current?.sendText(`${prompt.slice(0,7900-text.length)}\n大师的问题：${text}`);
        return;
      }
      const id = crypto.randomUUID();
      setMessages(old => [...old, {id, role: 'assistant', text: '', sources: matches}]);
      let answer = '';
      await sendChatMessage(settings.aiEndpoint, settings.aiModel,
        [{role: 'system', content: prompt}, ...[...messages, user].slice(-12).map(m => ({role: m.role, content: m.text}))],
        chunk => { answer += chunk; setMessages(old => old.map(m => m.id === id ? {...m, text: answer} : m)); }, controller.signal);
      if (!answer) throw new Error('AI 服务没有返回内容，请稍后重试');
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (epoch === requestEpoch.current) { setBusy(false); operationBusy.current = false; abortRef.current = null; }
    }
  };
  const briefing = () => connected ? send('请结合当前真实任务，为我做一个简短的今日汇报。', []) : startVoice(true);
  commandRef.current = action => {
    if (action==='toggle') {if(clientRef.current?.wanted)void stopVoice();else void startVoice();}
    if (action==='stop') void stopVoice();
    if (action==='mute' && connected) {clientRef.current?.mute(!muted);setMuted(!muted);}
    if (action==='interrupt' && connected) {try{clientRef.current?.interrupt();}catch{setError('通话尚未连接');}}
    if (action==='briefing') void briefing();
    if (action==='status') void publish('pm:voice:status',publishedStatus);
    if (action==='settings') onSettings();
  };
  const newConversation = async () => {
    if(!memoryReady || busy) return;
    try {
      await saveMessages(conversationRef.current,messagesRef.current);
      await stopVoice();
      conversationRef.current=crypto.randomUUID();messagesRef.current=[];setMessages([]);
      setMemoryNotice('已开始新对话，历史记录和长期记忆仍保留。');
    } catch(e) {setMemoryError(`尚未切换对话：${String(e)}`);}
  };
  const refreshWork = async () => {
    setWorkError('');
    try{setWork(await codexStatus());}catch(e){setWorkError(String(e));}
  };
  useEffect(()=>{
    if(!workOpen) return;
    void refreshWork();const timer=setInterval(()=>void refreshWork(),15000);
    return ()=>clearInterval(timer);
  },[workOpen]);
  const seenBriefingRequest = useRef(0);
  useEffect(() => {
    if (requestBriefing > seenBriefingRequest.current) { seenBriefingRequest.current = requestBriefing; void briefing(); }
  }, [requestBriefing]);
  const signatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!connected || !settings.autoBriefing) { signatureRef.current = null; return; }
    const check = () => {
      const s = latest.current;
      if (!s.notionConnected) return;
      const signature = briefingSignature(s.todos, s.projects);
      if (signatureRef.current === null) { signatureRef.current = signature; return; }
      if (signature !== signatureRef.current && signature && !operationBusy.current) {
        signatureRef.current = signature;
        try { clientRef.current?.sendText(`当前到期任务有变化，请简短提醒大师一次：${context()}`); }
        catch { /* A reconnect will establish a new baseline. */ }
      } else if (!signature) signatureRef.current = signature;
    };
    check(); const timer = setInterval(check, 15000); return () => clearInterval(timer);
  }, [connected, settings.autoBriefing]);

  useEffect(()=>{
    if(!connected || !settings.autoBriefing) return;
    let disposed=false;let polling=false;let previous:Map<string,string>|null=null;
    const check=async()=>{
      if(polling)return;polling=true;
      try{
        const snapshot=await codexStatus();if(disposed)return;
        const changed=previous ? snapshot.tasks.filter(t=>previous!.has(t.id)&&previous!.get(t.id)!==t.status&&['completed','interrupted'].includes(t.status)&&!t.stale) : [];
        previous=new Map(snapshot.tasks.map(t=>[t.id,t.status]));
        if(changed.length && !operationBusy.current) clientRef.current?.sendText(`Codex 本机记录出现以下变化，请简短提醒大师，说明是最近一轮状态，不将一轮完成等同于整个项目完成：${packContext(changed,1800)}`);
      }catch{/* A failed poll never fabricates a task status. */}finally{polling=false;}
    };
    void check();const timer=setInterval(()=>void check(),30000);return ()=>{disposed=true;clearInterval(timer);};
  },[connected,settings.autoBriefing]);

  const runSearch = async () => {
    if (!query.trim() || searching) return;
    setSearching(true); setKnowledgeError(''); setDocument(null);
    try { setSources(await searchKnowledge(query, semantic)); }
    catch (e) { setKnowledgeError(e instanceof Error ? e.message : String(e)); }
    finally { setSearching(false); }
  };
  const openSource = async (source: KnowledgeSource) => {
    setKnowledgeOpen(true); setKnowledgeError(''); setDocument({title: source.title, text: '正在读取…'});
    try { const content = await readKnowledge(source.file); setDocument({title: source.title, text: content}); }
    catch (e) { setDocument(null); setKnowledgeError(e instanceof Error ? e.message : String(e)); }
  };
  const stopText = useCallback(() => {
    abortRef.current?.abort();
    ++requestEpoch.current;
    operationBusy.current = false;
    setBusy(false);
  }, []);

  return <section hidden={!open} className="assistant-layer" role="dialog" aria-modal="true" aria-label="私人助理" ref={dialogRef}>
    <header className="assistant-header">
      <div><span className="eyebrow">ANTDESK ASSISTANT</span><h2>{knowledgeOpen ? 'Hermes 知识库' : '你的私人助理'}</h2></div>
      <div className="assistant-header-actions">
        <button className="text-button" disabled={!memoryReady || busy} onClick={()=>void newConversation()}>新对话</button>
        <button className="icon-button" aria-label="助理设置" onClick={onSettings}><Settings2 size={17}/></button>
        <button className="icon-button" aria-label="收起助理" onClick={onClose}><X size={18}/></button>
      </div>
    </header>
    {workOpen && !knowledgeOpen && <div className="pm-work-view">
      <div className="pm-work-heading"><strong>Codex 工作记录</strong><button className="text-button" onClick={()=>setWorkOpen(false)}>收起</button></div>
      <p className="muted-copy">每 15 秒读取本机记录；未确认的状态不会推断为运行中。</p>
      {workError && <p role="status" className="inline-notice">{workError}</p>}
      {work?.tasks.map(task=><div className="pm-task" key={task.id}><strong>{task.title}</strong><span>{TASK_LABELS[task.status]||'未知'} · {new Date(task.updatedAt*1000).toLocaleString()}{task.stale?' · 较早记录':''}</span>{task.progress&&<span>{task.progress}</span>}</div>)}
    </div>}
    {knowledgeOpen ? <div className="knowledge-view">
      <button className="text-button" onClick={() => {setKnowledgeOpen(false); setDocument(null);}}><ChevronLeft size={15}/>返回对话</button>
      <p className="muted-copy">检索 Hermes 保存的资料，查看原文或带入对话。</p>
      <form className="knowledge-search" onSubmit={e => {e.preventDefault(); void runSearch();}}>
        <Search size={17}/><input aria-label="搜索 Hermes 知识" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索项目、想法、过去的记录" maxLength={500}/>
        <button className="text-button" disabled={searching || !query.trim()}>{searching ? '检索中' : '搜索'}</button>
      </form>
      <label className="check-setting"><input type="checkbox" checked={semantic} onChange={e => setSemantic(e.target.checked)}/>深度语义检索<span>首次可能较慢</span></label>
      {knowledgeError && <p role="status" className="inline-notice">{knowledgeError}</p>}
      {document ? <article className="knowledge-document"><button className="text-button" onClick={() => setDocument(null)}>返回结果</button><h3>{document.title}</h3><pre>{document.text}</pre></article> :
        <div className="knowledge-results">{sources.map(source => <article key={source.file} className="knowledge-result"><BookOpen size={18}/><div><h3>{source.title}</h3><p>{source.snippet}</p><small>{source.file}</small><div className="source-actions"><button onClick={() => void openSource(source)}>查看原文</button><button disabled={busy} onClick={() => {setKnowledgeOpen(false); void send(`请结合这份资料，帮我解读：${source.title}`, [source]);}}>带入对话</button></div></div></article>)}
          {!searching && !sources.length && <div className="knowledge-empty"><BookOpen size={28}/><p>从一个关键词开始</p><span>找到的资料会保留来源，方便核对。</span></div>}
        </div>}
      {knowledge && <details className="knowledge-status"><summary>本地索引状态</summary><pre>{knowledge.status}</pre></details>}
    </div> : <>
      {!messages.length ? <div className="assistant-welcome">
        <img src="/assets/assistant/pearl.png" alt="珠光玻璃助理" className={`assistant-orb ${connected ? 'is-live' : ''}`}/>
        <span className="eyebrow">A LITTLE SPACE, JUST FOR YOU</span><h3>大师，我在这里。</h3><p>聊聊想法，理清今天。<br/>让过去积累的知识，陪你一起往前。</p>
        <div className="assistant-prompts"><button onClick={() => void briefing()}><Headphones size={16}/>听今日汇报</button><button onClick={() => setKnowledgeOpen(true)}><BookOpen size={16}/>翻翻知识库</button></div>
      </div> : <div className="assistant-transcript" ref={transcriptRef} role="log" aria-label="对话记录" aria-live="polite">
        {messages.map(m => <article key={m.id} className={`assistant-message ${m.role}`}><span>{m.role === 'user' ? '你' : '助理'}</span><p>{m.text || (busy ? '正在思考…' : '这条回复未完成')}</p>{!!m.sources?.length && <div className="message-sources">{m.sources.map((s, i) => <button key={s.file} onClick={() => void openSource(s)}>[{i + 1}] {s.title}</button>)}</div>}</article>)}
        {busy && <p className="muted-copy" role="status">正在整理资料…</p>}
      </div>}
      <footer className="assistant-composer">
        {memoryError && <p className="inline-notice" role="alert">{memoryError}</p>}
        {memoryNotice && <p className="muted-copy" role="status">{memoryNotice}</p>}
        {knowledgeError && settings.knowledgeEnabled && <button className="knowledge-warning" onClick={() => setKnowledgeOpen(true)}><BookOpen size={13}/>知识库暂不可用，查看详情</button>}
        {error && <div className="inline-notice" role="alert">{error}<button className="text-button" onClick={onSettings}>打开设置</button></div>}
        {playbackBlocked && <button className="playback-button" onClick={() => audioRef.current?.play().then(() => setPlaybackBlocked(false)).catch(() => setError('声音尚未播放，请检查系统音频设置'))}><Volume2 size={16}/>点击播放助理声音</button>}
        {voiceActive && <div className="voice-session-bar" role="status"><span className="live-dot"/>{VOICE_LABELS[voiceState]}{connected && <span>{muted ? '麦克风已静音' : '麦克风开启'}</span>}
          <button className="icon-button" disabled={!connected} aria-label={muted ? '打开麦克风' : '静音麦克风'} onClick={() => {clientRef.current?.mute(!muted); setMuted(!muted);}}>{muted ? <MicOff size={16}/> : <Mic size={16}/>}</button>
          <button className="icon-button" disabled={!connected} aria-label="打断助理" onClick={() => {try {clientRef.current?.interrupt();} catch {setError('通话已断开，请重新连接');}}}><Square size={13}/></button>
          <button className="icon-button hangup" aria-label="结束通话" onClick={() => void stopVoice()}><PhoneOff size={16}/></button></div>}
        <form className="assistant-input" onSubmit={e => {e.preventDefault(); void send(input);}}>
          <input aria-label="给助理发消息" value={input} onChange={e => setInput(e.target.value)} maxLength={4000} placeholder={connected ? '也可以打字给我…' : '有什么想和我聊的？'}/>
          {busy ? <button type="button" aria-label="停止回复" onClick={stopText}><Square size={15}/></button> : input.trim() ? <button type="submit" aria-label="发送消息"><ArrowUp size={19}/></button> : <button type="button" aria-label={voiceActive ? '语音通话中' : '开始语音对话'} disabled={voiceActive} onClick={() => void startVoice()}><Mic size={19}/></button>}
        </form>
        <div className="composer-caption"><button onClick={() => setKnowledgeOpen(true)}><BookOpen size={12}/>知识</button><button onClick={()=>setWorkOpen(v=>!v)}>工作状态</button><span>{voiceActive ? '收起也可继续通话' : memoryReady ? (isTauri()?'记忆随对话保留':'桌面端可保存记忆') : '正在恢复记忆…'}</span></div>
      </footer>
    </>}
    <audio ref={audioRef} autoPlay/>
  </section>;
}

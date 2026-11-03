import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Check, ChevronRight, KeyRound, LoaderCircle, LogOut, MessageCircle, RefreshCw, ShieldCheck } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import {
  cancelRuntimeLogin, configureRuntime, listRuntimeAgents, listRuntimeProviders, listRuntimeSessions,
  logoutRuntime, openAssistantUrl, runtimeLoginStatus, runtimeReadinessLabel, startRuntimeLogin,
  type RuntimeAgent, type RuntimeAuthMode, type RuntimeLogin, type RuntimeProvider, type RuntimeProviderId, type RuntimeSession,
} from '../../lib/assistantRuntime';
import type { AssistantProfile } from './AgentProfileEditor';
import DotsConnection from './DotsConnection';

interface RuntimeConnectionProps {
  profile: AssistantProfile; onChange: (next: Partial<AssistantProfile>) => void;
  onBusy: (busy: boolean) => void; onUpdated?: () => void;
}
export default function RuntimeConnection(props: RuntimeConnectionProps) {
  return props.profile.protocol === 'dots-direct'
    ? <DotsConnection {...props} renderDirect={onBusy => <RuntimeConnectionBody {...props} onBusy={onBusy}/>}/>
    : <RuntimeConnectionBody {...props}/>;
}
function RuntimeConnectionBody({ profile, onChange, onBusy, onUpdated }: RuntimeConnectionProps) {
  const providerId = profile.protocol as RuntimeProviderId;
  const grok = providerId === 'grok-direct';
  const dots = providerId === 'dots-direct';
  const roster = grok || dots;
  const personal = providerId === 'muse-personal';
  const deepseek = providerId === 'deepseek-harness';
  const supportsKey = deepseek || providerId === 'muse-code';
  const desktop = isTauri();
  const [provider, setProvider] = useState<RuntimeProvider>();
  const [login, setLogin] = useState<RuntimeLogin>();
  const [agents, setAgents] = useState<RuntimeAgent[]>([]);
  const [sessions, setSessions] = useState<RuntimeSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [authMode, setAuthMode] = useState<RuntimeAuthMode>('account');
  const modeChosen = useRef(false);
  const loginRequested = useRef(false);
  const loginEpoch = useRef(0);
  const openedUrls = useRef(new Set<string>());
  const api = supportsKey && authMode === 'api_key';
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [agentsLoading, setAgentsLoading] = useState(false);
  const [sessionsLoading, setSessionsLoading] = useState(false);
  const mounted = useRef(true);
  const ready = provider?.readiness === 'ready';
  const pending = login?.state === 'pending';
  const accountConnected = dots && login?.state === 'ready';
  const diagnostic = login?.diagnostic || provider?.diagnostic;
  const load = useCallback(async () => {
    try {
      const providers = await listRuntimeProviders();
      if (mounted.current) {
        const value = providers.find(item => item.id === providerId || item.protocol === providerId);
        setProvider(value);
        if (deepseek && value?.authentication?.mode && !modeChosen.current) setAuthMode(value.authentication.mode);
        if (!value) throw new Error('连接服务尚未提供这位助理，请更新服务后重试。');
      }
    } catch (cause) { if (mounted.current) setProvider(undefined); throw cause; }
  }, [providerId, deepseek]);
  const openLoginPage = useCallback(async (result: RuntimeLogin) => {
    if (!mounted.current || !loginRequested.current || result.state !== 'pending' || result.browserOpened || !result.url || openedUrls.current.has(result.url)) return;
    openedUrls.current.add(result.url);
    try { await openAssistantUrl(result.url); }
    catch { if (mounted.current) setNotice('浏览器未能自动打开，请点击“继续登录”。'); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    if (!desktop) { setLoading(false); return; }
    void load().catch(cause => { if (mounted.current) setError(String(cause)); }).finally(() => { if (mounted.current) setLoading(false); });
    void runtimeLoginStatus(providerId).then(value => { if (mounted.current) setLogin(value); }).catch(() => { /* Provider status remains the source of readiness. */ });
    return () => { mounted.current = false; loginRequested.current = false; loginEpoch.current++; };
  }, [desktop, load, providerId]);
  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => {
    if (!pending) return;
    let stopped = false;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const epoch = loginEpoch.current;
      try {
        const result = await runtimeLoginStatus(providerId);
        if (!stopped && mounted.current && epoch === loginEpoch.current) {
          setLogin(result);
          await openLoginPage(result);
          if (result.state !== 'pending') { loginRequested.current = false; await load(); onUpdated?.(); }
          if (result.state === 'failed') setError(result.message || '登录未完成，请重新尝试。');
        }
      } catch (cause) { if (!stopped) setError(String(cause)); }
      finally { polling = false; }
    };
    const timer = setInterval(() => void poll(), 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [pending, providerId, load, onUpdated, openLoginPage]);
  useEffect(() => {
    if (!ready || !roster) { setAgents([]); return; }
    let stopped = false;
    setAgentsLoading(true);
    void listRuntimeAgents(providerId).then(value => { if (!stopped) setAgents(value); }).catch(cause => { if (!stopped) setError(String(cause)); }).finally(() => { if (!stopped) setAgentsLoading(false); });
    return () => { stopped = true; };
  }, [ready, roster, providerId]);
  useEffect(() => {
    if (!ready || personal || roster && !profile.agentRef) { setSessions([]); return; }
    let stopped = false;
    setSessionsLoading(true);
    void listRuntimeSessions(providerId, roster ? profile.agentRef : undefined).then(value => { if (!stopped) setSessions(value); }).catch(cause => { if (!stopped) setError(String(cause)); }).finally(() => { if (!stopped) setSessionsLoading(false); });
    return () => { stopped = true; };
  }, [ready, roster, personal, profile.agentRef, providerId]);
  const perform = async (operation: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const loginNow = () => perform(async () => {
    const epoch = ++loginEpoch.current;
    loginRequested.current = true;
    openedUrls.current.clear();
    if (deepseek) await configureRuntime(providerId, { authMode: 'account' });
    const result = await startRuntimeLogin(providerId);
    if (!mounted.current || epoch !== loginEpoch.current) return;
    setLogin(result);
    if (result.state === 'failed') throw new Error(result.message || '无法发起登录，请重试。');
    await openLoginPage(result);
    if (result.state === 'ready') { loginRequested.current = false; await load(); onUpdated?.(); }
  });
  const refresh = () => perform(async () => {
    if (dots) await configureRuntime(providerId, { transport: 'direct', action: 'refresh' });
    await load();
    const result = await runtimeLoginStatus(providerId);
    if (mounted.current) setLogin(result);
    if (roster) {
      const available = await listRuntimeAgents(providerId).catch(() => null);
      if (available) setAgents(available);
    }
    onUpdated?.();
  });
  const chooseMode = (mode: RuntimeAuthMode) => perform(async () => {
    modeChosen.current = true;
    loginRequested.current = false;
    loginEpoch.current++;
    if (deepseek) await configureRuntime(providerId, { authMode: mode });
    setAuthMode(mode); setApiKey(''); setLogin(undefined);
    await load(); onUpdated?.();
  });
  const cancelLogin = () => perform(async () => {
    loginRequested.current = false; loginEpoch.current++;
    await cancelRuntimeLogin(providerId);
    setLogin(undefined); await load();
  });
  const saveKey = () => perform(async () => {
    if (!apiKey.trim()) throw new Error(`填写${deepseek ? ' DeepSeek' : ' Meta'} API Key。`);
    const result = await configureRuntime(providerId, { apiKey: apiKey.trim(), ...(deepseek ? { authMode: 'api_key' as const } : {}), ...(profile.model ? { model: profile.model } : {}) });
    setApiKey('');
    await load(); onUpdated?.();
    setNotice(result?.message || '凭据已保存，连接状态已更新。');
  });
  const status = !desktop ? '桌面版可连接' : loading ? '正在读取状态' : pending
    ? login?.browserOpened || login?.url || login?.userCode ? '等待浏览器完成登录'
      : loginRequested.current ? '正在准备登录' : '正在检查登录状态'
    : runtimeReadinessLabel(provider?.readiness);
  return <div className="pd-runtime-connection">
    <ol className="pd-connect-steps" aria-label="连接步骤">
      <li data-complete={ready || accountConnected}><span>{ready || accountConnected ? <Check size={11}/> : '1'}</span>{api ? '配置密钥' : '登录账号'}</li>
      <ChevronRight size={12} aria-hidden="true"/>
      <li data-complete={ready && (!roster || Boolean(profile.agentRef))}><span>{ready && (!roster || profile.agentRef) ? <Check size={11}/> : '2'}</span>{roster ? dots ? '选择 Dot' : '选择 Bot' : personal ? '独立会话' : '选择会话'}</li>
      <ChevronRight size={12} aria-hidden="true"/>
      <li><span>3</span>派发事项</li>
    </ol>
    <section className="pd-runtime-status" data-ready={ready} aria-live="polite">
      <div className="pd-runtime-status-line"><i className={'pd-status-dot ' + (ready ? '' : 'off')}/><strong>{status}</strong>{loading && <LoaderCircle size={13} className="pd-busy"/>}<button type="button" className="pd-icon" aria-label="刷新连接状态" disabled={busy || loading || !desktop} onClick={() => void refresh()}><RefreshCw size={13} className={busy ? 'pd-busy' : undefined}/></button></div>
      <p>{!desktop ? '请在桌面端完成登录与连接。' : pending ? login?.message || '请在浏览器中完成授权，返回后将自动刷新状态。' : provider?.message || (loading ? '正在检查连接状态…' : '无法读取连接状态，请重试。')}</p>
      {provider?.installed && <small>本机已安装{provider.version ? ' · ' + provider.version : ''}</small>}
    </section>
    {supportsKey && <div className="pd-auth-methods" role="group" aria-label="认证方式">
      <button type="button" aria-pressed={!api} disabled={busy || pending || !desktop} onClick={() => void chooseMode('account')}>账号登录</button>
      <button type="button" aria-pressed={api} disabled={busy || pending || !desktop} onClick={() => void chooseMode('api_key')}>官方 API Key</button>
    </div>}
    {api ? <>
      <label htmlFor="runtime-api-key">{deepseek ? 'DeepSeek' : 'Meta'} API Key</label>
      <div className="pd-secret-field"><KeyRound size={15}/><input id="runtime-api-key" type="password" autoComplete="new-password" spellCheck={false} value={apiKey} onChange={e => setApiKey(e.target.value)} placeholder={ready ? '填写新密钥以更换账号' : '粘贴官方 API Key'}/></div>
      {deepseek && <><label htmlFor="runtime-model">模型 · 可选</label><input id="runtime-model" value={profile.model} onChange={e => onChange({ model: e.target.value })} placeholder="留空使用官方可用模型" spellCheck={false}/></>}
      <button type="button" className="pd-primary pd-connect-action" disabled={busy || !desktop || !apiKey.trim()} onClick={() => void saveKey()}>{busy ? <LoaderCircle size={14} className="pd-busy"/> : <KeyRound size={14}/>}保存密钥并检查</button>
      <p className="pd-field-hint"><ShieldCheck size={11} className="pd-inline-icon"/>凭据保存在本机，不会写入页面配置。</p>
    </> : <>
      {!ready && <div className="pd-connect-actions">
        {pending ? <>
          {login?.url && <button type="button" className="pd-primary" disabled={busy} onClick={() => void perform(() => openAssistantUrl(login.url!))}>继续登录<ArrowUpRight size={13}/></button>}
          <button type="button" className="pd-secondary" disabled={busy} onClick={() => void cancelLogin()}>取消登录</button>
        </> : accountConnected ? <><button type="button" className="pd-primary" disabled={busy || loading || !desktop} onClick={() => void refresh()}><RefreshCw size={13} className={busy ? 'pd-busy' : undefined}/>重新检查 Dot</button><button type="button" className="pd-secondary" disabled={busy || loading || !desktop} onClick={() => void loginNow()}>重新登录</button></> : <button type="button" className="pd-primary" disabled={busy || loading || !desktop || provider?.readiness === 'needs_install'} onClick={() => void loginNow()}>{busy ? <LoaderCircle size={14} className="pd-busy"/> : <ArrowUpRight size={14}/>}登录 {grok ? 'Grok' : dots ? 'ChatGPT / Codex' : personal ? 'Muse AI' : deepseek ? 'DeepSeek' : 'Muse Code'}</button>}
      </div>}
      {pending && login?.userCode && <div className="pd-login-code"><span>确认网页上的验证码</span><strong>{login.userCode}</strong></div>}
      {!ready && !pending && <p className="pd-field-hint">{accountConnected ? '账号已授权，若直连受限可切换为上方官方事件连接。' : `点击打开${deepseek ? ' DeepSeek ' : ''}登录页完成授权。`}</p>}
      {deepseek && ready && <><label htmlFor="runtime-account-model">可用模型</label><select id="runtime-account-model" value={profile.model || ''} onChange={e => onChange({ model: e.target.value })}>
        <option value="">使用官方默认模型</option>
        {profile.model && !provider?.models?.some(item => item.id === profile.model) && <option value={profile.model}>已保存 · {profile.model}</option>}
        {provider?.models?.map(item => <option key={item.id} value={item.id}>{item.name || item.id}</option>)}
      </select></>}
    </>}
    {diagnostic && <details className="pd-login-details"><summary>连接详情{diagnostic.retryable ? ' · 可以重试' : ''}</summary><p>{diagnostic.stage} · {diagnostic.code}{diagnostic.httpStatus ? ` · HTTP ${diagnostic.httpStatus}` : ''}</p></details>}
    {roster && <>
      <label htmlFor="runtime-agent">{dots ? '选择 Dot' : '选择 Grok Bot'}</label>
      <select id="runtime-agent" value={profile.agentRef || ''} disabled={!ready || agentsLoading || busy} onChange={e => onChange({ agentRef: e.target.value, sessionId: '' })}>
        <option value="">{agentsLoading ? `正在读取${dots ? ' Dot' : ' Bot'}…` : ready ? `选择要连接的${dots ? ' Dot' : ' Bot'}` : `登录后读取${dots ? ' Dot' : ' Bot'}`}</option>
        {profile.agentRef && !agents.some(agent => agent.id === profile.agentRef) && <option value={profile.agentRef}>已保存 · {profile.agentRef}</option>}
        {agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
      </select>
      {ready && !agentsLoading && !agents.length && <p className="pd-field-hint">未读取到可用{dots ? ' Dot' : ' Bot'}，请确认账号后点击刷新。</p>}
      {agents.find(agent => agent.id === profile.agentRef)?.description && <p className="pd-field-hint">{agents.find(agent => agent.id === profile.agentRef)?.description}</p>}
    </>}
    {personal ? <div className="pd-personal-session-note"><MessageCircle size={14}/><div><strong>按事项独立建立会话</strong><p>每次派发自动创建独立会话，进度与回复同步至工作台。</p></div></div> : <>
    <label htmlFor="runtime-session">工作会话</label>
    <select id="runtime-session" value={profile.sessionId || ''} disabled={!ready || sessionsLoading || busy || roster && !profile.agentRef} onChange={e => onChange({ sessionId: e.target.value })}>
      <option value="">{sessionsLoading ? '正在读取会话…' : dots ? '使用默认工作会话' : '每次派发新建会话'}</option>
      {profile.sessionId && !sessions.some(session => session.id === profile.sessionId) && <option value={profile.sessionId}>已保存 · {profile.sessionId}</option>}
      {sessions.map(session => <option key={session.id} value={session.id}>{session.title || '未命名会话'}</option>)}
    </select>
    </>}
    {(ready || accountConnected) && <button type="button" className="pd-link pd-logout" disabled={busy} onClick={() => void perform(async () => { loginRequested.current = false; loginEpoch.current++; await logoutRuntime(providerId); setApiKey(''); setLogin(undefined); setSessions([]); await load(); onUpdated?.(); })}><LogOut size={12}/>{deepseek && provider?.authentication?.mode === 'api_key' || providerId === 'muse-code' && api ? '移除当前登录凭据' : '退出当前账号'}</button>}
    {notice && <p className="pd-probe-success" role="status">{notice}</p>}
    {error && <p className="pd-inline-error" role="alert">{error}</p>}
  </div>;
}

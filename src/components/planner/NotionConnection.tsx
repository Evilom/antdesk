import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { ArrowUpRight, Check, ChevronRight, CircleCheck, LoaderCircle, LogOut, MessageCircle, RefreshCw } from 'lucide-react';
import {
  cancelRuntimeLogin, configureRuntime, listRuntimeProviders, logoutRuntime,
  openAssistantUrl, runtimeLoginStatus, runtimeReadinessLabel, startRuntimeLogin,
  type RuntimeLogin, type RuntimeProvider,
} from '../../lib/assistantRuntime';
import type { AssistantProfile } from './AgentProfileEditor';
import './notion-connection.css';

const PROVIDER = 'notion-web' as const;

function connectionLabel(provider?: RuntimeProvider) {
  if (provider?.readiness === 'ready') return provider.aiVerified ? '已验证 · 可以使用' : '已登录 · 等待首次回复验证';
  if (provider?.diagnostic?.httpStatus === 402 || ['quota_exceeded', 'insufficient_quota', 'credits_exhausted'].includes(provider?.diagnostic?.code || '')) return '权益或额度待处理';
  if (provider?.readiness === 'needs_subscription') return '请检查工作区的 AI 权益';
  if (provider?.readiness === 'needs_configuration') return '选择工作区';
  return runtimeReadinessLabel(provider?.readiness);
}

export default function NotionConnection({ profile, onChange, onBusy, onUpdated }: {
  profile: AssistantProfile; onChange: (next: Partial<AssistantProfile>) => void;
  onBusy: (busy: boolean) => void; onUpdated?: () => void;
}) {
  const desktop = isTauri();
  const [provider, setProvider] = useState<RuntimeProvider>();
  const [login, setLogin] = useState<RuntimeLogin>();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const mounted = useRef(false);
  const generation = useRef(0);
  const loginRequested = useRef(false);
  const openedUrls = useRef(new Set<string>());
  const onUpdatedRef = useRef(onUpdated);
  onUpdatedRef.current = onUpdated;
  const pending = login?.state === 'pending';
  const ready = provider?.readiness === 'ready';
  const authenticated = ready || Boolean(provider?.account && !['needs_login', 'invalid_credentials', 'needs_install'].includes(provider.readiness));
  const workspaces = provider?.workspaces || [];
  const modelOptions = (provider?.models || []).filter(model => model.id && model.id !== 'auto');
  const currentModel = profile.model === 'auto' ? '' : profile.model || '';
  const modelListed = !currentModel || modelOptions.some(model => model.id === currentModel);

  const load = useCallback(async () => {
    const epoch = generation.current;
    const providers = await listRuntimeProviders();
    const value = providers.find(item => item.id === PROVIDER || item.protocol === PROVIDER);
    if (!value) throw new Error('Notion 连接组件尚未就绪，请更新 AntDesk 后重试。');
    if (mounted.current && epoch === generation.current) setProvider(value);
    return value;
  }, []);

  const openLoginPage = useCallback(async (value: RuntimeLogin) => {
    if (!mounted.current || !loginRequested.current || value.state !== 'pending' || value.browserOpened || !value.url || openedUrls.current.has(value.url)) return;
    openedUrls.current.add(value.url);
    try { await openAssistantUrl(value.url); }
    catch { if (mounted.current) setNotice('登录窗口未能自动打开，请点击“继续登录”。'); }
  }, []);

  useEffect(() => {
    mounted.current = true;
    if (!desktop) { setLoading(false); return () => { mounted.current = false; }; }
    const epoch = generation.current;
    void load().catch(cause => {
      if (mounted.current && epoch === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (mounted.current && epoch === generation.current) setLoading(false); });
    void runtimeLoginStatus(PROVIDER).then(value => {
      if (mounted.current && epoch === generation.current) setLogin(value);
    }).catch(() => { /* The provider state still explains availability. */ });
    return () => { mounted.current = false; loginRequested.current = false; generation.current++; };
  }, [desktop, load]);

  useEffect(() => { onBusy(busy); }, [busy, onBusy]);
  useEffect(() => {
    if (!desktop || provider?.readiness === 'ready') return;
    let stopped = false;
    const timer = setInterval(() => {
      void load().then(value => {
        if (!stopped && value?.readiness === 'ready') onUpdatedRef.current?.();
      }).catch(() => { /* The visible status remains until the next successful read. */ });
    }, 3000);
    return () => { stopped = true; clearInterval(timer); };
  }, [desktop, provider?.readiness, load]);
  useEffect(() => {
    if (!desktop || (!pending && provider?.readiness !== 'connecting')) return;
    let stopped = false, polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      const epoch = generation.current;
      try {
        const value = await runtimeLoginStatus(PROVIDER);
        if (stopped || !mounted.current || epoch !== generation.current) return;
        setLogin(value);
        await openLoginPage(value);
        if (value.state !== 'pending') {
          loginRequested.current = false;
          await load();
          if (!stopped && mounted.current && epoch === generation.current) {
            onUpdatedRef.current?.();
            if (value.state === 'failed') setError(value.message || '登录未完成，请重新登录。');
          }
        }
      } catch (cause) {
        if (!stopped && mounted.current && epoch === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
      } finally { polling = false; }
    };
    const timer = setInterval(() => void poll(), 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [desktop, pending, provider?.readiness, load, openLoginPage]);

  const perform = async (operation: () => Promise<void>) => {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const startLogin = (changeAccount = false) => perform(async () => {
    const epoch = ++generation.current;
    loginRequested.current = true; openedUrls.current.clear();
    if (changeAccount) {
      await logoutRuntime(PROVIDER);
      if (!mounted.current || epoch !== generation.current) return;
      setProvider(undefined); setLogin(undefined); onUpdatedRef.current?.();
    }
    const value = await startRuntimeLogin(PROVIDER);
    if (!mounted.current || epoch !== generation.current) return;
    setLogin(value);
    if (value.state === 'failed') { loginRequested.current = false; throw new Error(value.message || '无法打开 Notion 登录，请重试。'); }
    await openLoginPage(value);
    if (value.state === 'ready') { loginRequested.current = false; await load(); onUpdatedRef.current?.(); }
  });
  const refresh = () => perform(async () => {
    const epoch = generation.current;
    if (provider?.installed && authenticated && !pending) await configureRuntime(PROVIDER, { action: 'refresh' });
    await load();
    const value = await runtimeLoginStatus(PROVIDER);
    if (mounted.current && epoch === generation.current) { setLogin(value); onUpdatedRef.current?.(); }
  });
  const cancelLogin = () => perform(async () => {
    loginRequested.current = false; generation.current++;
    await cancelRuntimeLogin(PROVIDER);
    if (!mounted.current) return;
    setLogin(undefined); await load(); onUpdatedRef.current?.();
  });
  const chooseWorkspace = (workspaceId: string) => perform(async () => {
    if (!workspaceId || workspaceId === provider?.workspaceId) return;
    const epoch = ++generation.current;
    const value = await configureRuntime(PROVIDER, { workspaceId, model: '' });
    if (!mounted.current || epoch !== generation.current) return;
    setProvider(value); onChange({ model: '', sessionId: '' }); onUpdatedRef.current?.();
    setNotice('工作区已切换，后续消息将使用这个工作区。');
  });
  const disconnect = () => perform(async () => {
    loginRequested.current = false; generation.current++;
    await logoutRuntime(PROVIDER);
    if (!mounted.current) return;
    setLogin(undefined); setProvider(undefined); await load(); onUpdatedRef.current?.();
    setNotice('已断开 Notion AI，已有待办和对话记录保留。');
  });
  const status = !desktop ? '请在桌面版连接' : loading ? '正在检查连接' : pending ? '等待你完成网页登录' : connectionLabel(provider);
  const diagnostic = login?.diagnostic || provider?.diagnostic;

  return <div className="pd-notion-connection" data-state={pending ? 'logging-in' : provider?.readiness || 'loading'}>
    <ol className="pd-connect-steps" aria-label="Notion 连接步骤">
      <li data-complete={authenticated}><span>{authenticated ? <Check size={11}/> : '1'}</span>登录 Notion</li>
      <ChevronRight size={12} aria-hidden="true"/>
      <li data-complete={Boolean(provider?.workspaceId)}><span>{provider?.workspaceId ? <Check size={11}/> : '2'}</span>选择工作区</li>
      <ChevronRight size={12} aria-hidden="true"/>
      <li data-complete={Boolean(provider?.aiVerified)}><span>{provider?.aiVerified ? <Check size={11}/> : '3'}</span>开始评审</li>
    </ol>
    <section className="pd-runtime-status pd-notion-status" data-ready={ready} aria-live="polite">
      <div className="pd-runtime-status-line"><span className="pd-notion-mark" aria-hidden="true">N</span><strong>{status}</strong>
        <button type="button" className="pd-icon" aria-label="刷新 Notion 连接状态" disabled={busy || loading || !desktop} onClick={() => void refresh()}><RefreshCw size={13} className={busy ? 'pd-busy' : undefined}/></button>
      </div>
      <p>{!desktop ? '在 AntDesk 桌面版打开专用登录窗口。' : pending ? login?.message || '请在打开的 Notion 窗口完成登录，返回后会自动更新。' : provider?.message || (loading ? '正在读取本机连接状态…' : '暂时无法读取连接状态，请刷新重试。')}</p>
      {provider?.account && <div className="pd-notion-account"><span>当前账号</span><strong>{provider.account.name || '已登录的 Notion 账号'}</strong></div>}
    </section>
    {pending ? <div className="pd-connect-actions">
      {login?.url && !login.browserOpened && <button type="button" className="pd-primary" disabled={busy} onClick={() => void perform(() => openAssistantUrl(login.url!))}>继续登录<ArrowUpRight size={13}/></button>}
      <button type="button" className="pd-secondary" disabled={busy} onClick={() => void cancelLogin()}>取消登录</button>
    </div> : !authenticated ? <div className="pd-connect-actions">
      <button type="button" className="pd-primary pd-notion-login" disabled={busy || loading || !desktop || provider?.readiness === 'needs_install'} onClick={() => void startLogin()}>{busy ? <LoaderCircle size={14} className="pd-busy"/> : <ArrowUpRight size={14}/>}登录我的 Notion</button>
    </div> : null}
    {authenticated && <div className="pd-notion-options">
      <label htmlFor="notion-workspace">使用哪个工作区</label>
      <select id="notion-workspace" value={provider?.workspaceId || ''} disabled={busy || pending || !workspaces.length} onChange={event => void chooseWorkspace(event.target.value)}>
        <option value="">{workspaces.length ? '选择有 AI 权益的工作区' : '尚未读取到工作区'}</option>
        {provider?.workspaceId && !workspaces.some(item => item.id === provider.workspaceId) && <option value={provider.workspaceId}>已保存的工作区 · 待核实</option>}
        {workspaces.map(item => <option key={item.id} value={item.id}>{item.name || '未命名工作区'}{item.aiAvailable === false ? ' · AI 权益待核实' : ''}</option>)}
      </select>
      {!workspaces.length && <p className="pd-field-hint">点击刷新重新读取工作区；不会发送 AI 消息。</p>}
      <label htmlFor="notion-model">回复模型</label>
      <select id="notion-model" value={currentModel} disabled={busy || pending || !provider?.workspaceId} onChange={event => onChange({ model: event.target.value })}>
        <option value="">Auto · 由 Notion 选择</option>
        {!modelListed && <option value={currentModel}>已保存 · {currentModel}（待核实）</option>}
        {modelOptions.map(model => <option key={model.id} value={model.id}>{model.name || model.id}</option>)}
      </select>
      <p className="pd-field-hint">{provider?.modelsSource === 'account' ? '列表来自当前账号；实际可用性与剩余额度以 Notion 回复为准。' : modelOptions.length ? '兼容模型列表，尚未逐个验证账号权限；建议先用 Auto。' : '先使用 Auto。模型列表未确认，不影响保留当前配置。'}</p>
    </div>}
    <div className="pd-notion-purpose"><MessageCircle size={15}/><div><strong>围绕当前任务工作</strong><p>保存后可私聊，或从待办派发评审。回复回到 AntDesk，由你决定是否采纳。</p></div></div>
    {authenticated && !provider?.aiVerified && <p className="pd-notion-verification"><CircleCheck size={12}/>登录检查不发送 AI 消息；首次真实回复后再确认可用。</p>}
    <p className="pd-field-hint pd-notion-membership">使用 Notion 网页登录会话，按该工作区的会员权益和额度运行。此连接由社区协议适配。</p>
    {authenticated && !pending && <div className="pd-notion-account-actions">
      <button type="button" className="pd-link" disabled={busy || !desktop} onClick={() => void startLogin(true)}>更换登录账号</button>
      <button type="button" className="pd-link" disabled={busy || !desktop} onClick={() => void disconnect()}><LogOut size={12}/>断开连接</button>
    </div>}
    {diagnostic && <details className="pd-login-details"><summary>连接详情{diagnostic.retryable ? ' · 可重试' : ''}</summary><p>{diagnostic.stage} · {diagnostic.code}{diagnostic.httpStatus ? ` · HTTP ${diagnostic.httpStatus}` : ''}</p></details>}
    {notice && <p className="pd-probe-success" role="status">{notice}</p>}
    {error && <p className="pd-inline-error" role="alert">{error}</p>}
  </div>;
}

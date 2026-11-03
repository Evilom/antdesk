import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { ArrowUpRight, Check, Copy, KeyRound, Link2, LoaderCircle, Play, RefreshCw, ShieldCheck, Square } from 'lucide-react';
import { configureRuntime, listRuntimeProviders, openAssistantUrl, runtimeReadinessLabel, type RuntimeProvider } from '../../lib/assistantRuntime';
import type { AssistantProfile } from './AgentProfileEditor';
import './dots-connection.css';

type Transport = 'events' | 'direct';
export default function DotsConnection({ profile, onChange, onBusy, onUpdated, renderDirect }: {
  profile: AssistantProfile; onChange: (next: Partial<AssistantProfile>) => void;
  onBusy: (busy: boolean) => void; onUpdated?: () => void;
  renderDirect: (onBusy: (busy: boolean) => void) => ReactNode;
}) {
  const desktop = isTauri();
  const [provider, setProvider] = useState<RuntimeProvider>();
  const [transport, setTransport] = useState<Transport>('events');
  const [tunnelId, setTunnelId] = useState('');
  const [runtimeKey, setRuntimeKey] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [directBusy, setDirectBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [showSetup, setShowSetup] = useState(false);
  const mounted = useRef(true), operating = useRef(false), epoch = useRef(0);
  const latestProvider = useRef<RuntimeProvider | undefined>(undefined);
  const chosen = useRef(false), idEdited = useRef(false);
  const lastDirect = useRef({ agentRef: profile.agentRef === 'omdot-events' ? '' : profile.agentRef || '', sessionId: profile.agentRef === 'omdot-events' ? '' : profile.sessionId || '' });
  const actualTransport = provider?.transport || 'events';
  const activeEvents = actualTransport === 'events';
  const configured = Boolean(provider?.tunnel?.configured);
  const tunnelReady = provider?.tunnel?.state === 'ready';
  const ready = activeEvents && provider?.readiness === 'ready' && tunnelReady && (provider.subscriptionCount || 0) > 0;
  const matchingSavedKey = configured && tunnelId.trim() === (provider?.tunnel?.tunnelId || '');
  const needsPolling = provider?.tunnel?.state === 'starting' || activeEvents && tunnelReady && !ready;
  useEffect(() => {
    if (actualTransport === 'direct' && profile.agentRef !== 'omdot-events') lastDirect.current = { agentRef: profile.agentRef || '', sessionId: profile.sessionId || '' };
  }, [actualTransport, profile.agentRef, profile.sessionId]);
  const apply = useCallback((value: RuntimeProvider) => {
    if (!mounted.current) return;
    latestProvider.current = value;
    setProvider(value);
    if (!chosen.current) setTransport(value.transport || 'direct');
    if (!idEdited.current) setTunnelId(value.tunnel?.tunnelId || '');
  }, []);
  const load = useCallback(async () => {
    const version = epoch.current;
    const next = (await listRuntimeProviders()).find(item => item.id === 'dots-direct');
    if (!next) throw new Error('连接服务尚未提供 omdot，请更新后重试。');
    if (mounted.current && epoch.current === version) {
      const previous = latestProvider.current;
      apply(next);
      if (previous && (previous.readiness !== next.readiness || previous.transport !== next.transport || previous.subscriptionCount !== next.subscriptionCount)) onUpdated?.();
    }
  }, [apply, onUpdated]);
  useEffect(() => {
    mounted.current = true;
    if (desktop) void load().catch(cause => { if (mounted.current) setError(String(cause)); }).finally(() => { if (mounted.current) setLoading(false); });
    else setLoading(false);
    return () => { mounted.current = false; epoch.current++; };
  }, [desktop, load]);
  useEffect(() => { onBusy(busy || directBusy); }, [busy, directBusy, onBusy]);
  useEffect(() => {
    if (!desktop || !needsPolling) return;
    let reading = false, stopped = false;
    const timer = setInterval(() => {
      if (reading || operating.current) return;
      reading = true;
      void load().catch(cause => { if (!stopped && mounted.current) setError(String(cause)); }).finally(() => { reading = false; });
    }, 2500);
    return () => { stopped = true; clearInterval(timer); };
  }, [desktop, needsPolling, load]);
  const perform = async (operation: () => Promise<void>) => {
    if (operating.current) return;
    operating.current = true; epoch.current++; setBusy(true); setError(''); setNotice('');
    try { await operation(); }
    catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { operating.current = false; if (mounted.current) setBusy(false); }
  };
  const choose = (value: Transport) => { chosen.current = true; setTransport(value); setRuntimeKey(''); setError(''); setNotice(''); };
  const open = (url: string) => perform(() => openAssistantUrl(url));
  const saveEvents = () => perform(async () => {
    const id = tunnelId.trim(), key = runtimeKey.trim();
    if (!id) throw new Error('先填写官方 Tunnel ID。');
    if (!key && !matchingSavedKey) throw new Error('请填写这个 Tunnel 的运行密钥。');
    try {
      const result = await configureRuntime('dots-direct', { transport: 'events', tunnelId: id, ...(key ? { tunnelApiKey: key } : {}), action: 'start' });
      if (!mounted.current) return;
      idEdited.current = false; apply(result); setTransport('events');
      onChange({ agentRef: 'omdot-events', sessionId: '' }); onUpdated?.();
      setNotice('事件连接已保存。完成下面的订阅后，点击底部“保存配置”。');
    } finally { if (mounted.current) setRuntimeKey(''); }
  });
  const saveDirect = () => perform(async () => {
    const result = await configureRuntime('dots-direct', { transport: 'direct' });
    if (!mounted.current) return;
    apply(result); setTransport('direct');
    onChange(lastDirect.current); onUpdated?.();
    setNotice('已切回客户端直连，请确认 Dot 和会话后保存。');
  });
  const refresh = () => perform(async () => {
    // Inspecting an unsaved tab must not change the active transport.
    apply(await configureRuntime('dots-direct', { transport: actualTransport, action: 'refresh' })); onUpdated?.();
  });
  const stop = () => perform(async () => {
    apply(await configureRuntime('dots-direct', { transport: actualTransport, action: 'stop' })); onUpdated?.();
  });
  const startPlugin = () => perform(async () => {
    apply(await configureRuntime('dots-direct', { transport: actualTransport, action: 'start' })); onUpdated?.();
    setNotice('已启动待办插件连接，原 Dot 的聊天方式保持不变。');
  });
  const copySetup = () => perform(async () => {
    if (!provider?.setupMessage) throw new Error('保存事件连接后再读取订阅说明。');
    try { await navigator.clipboard.writeText(provider.setupMessage); setNotice('已复制订阅说明，请发送给 omdot 完成订阅。'); }
    catch { setShowSetup(true); throw new Error('暂时无法复制，请选中下方订阅消息手动复制。'); }
  });
  return <div className="pd-dots-connection">
    <div className="pd-dots-methods" role="group" aria-label="omdot 连接方式">
      <button type="button" aria-pressed={transport === 'events'} disabled={busy || directBusy} onClick={() => choose('events')}>官方事件连接<span>推荐</span></button>
      <button type="button" aria-pressed={transport === 'direct'} disabled={busy || directBusy} onClick={() => choose('direct')}>客户端直连</button>
    </div>
    {transport === 'events' ? <div className="pd-dots-events">
      <p className="pd-dots-intro"><ShieldCheck size={14}/>通过 ChatGPT 官方插件隧道接收事项并回传结果。</p>
      <ol className="pd-dots-steps" aria-label="官方事件连接进度">
        <li data-complete={configured}><span>{configured ? <Check size={11}/> : '1'}</span>配置隧道</li>
        <li data-complete={tunnelReady}><span>{tunnelReady ? <Check size={11}/> : '2'}</span>隧道在线</li>
        <li data-complete={ready}><span>{ready ? <Check size={11}/> : '3'}</span>事件订阅</li>
      </ol>
      <section className="pd-runtime-status" data-ready={ready} aria-live="polite">
        <div className="pd-runtime-status-line"><i className={'pd-status-dot ' + (ready ? '' : 'off')}/><strong>{!desktop ? '仅桌面版可用' : loading ? '正在读取状态' : !activeEvents ? '待启用事件连接' : ready ? '已就绪' : provider?.readiness === 'ready' ? '等待确认连接与订阅' : runtimeReadinessLabel(provider?.readiness)}</strong><button type="button" className="pd-icon" aria-label="重新检查事件连接" disabled={!desktop || busy || loading} onClick={() => void refresh()}><RefreshCw size={13} className={busy ? 'pd-busy' : undefined}/></button></div>
        <p>{!activeEvents ? '填写官方 Tunnel 信息，保存并启动后启用。' : provider?.message || '等待本机连接状态。'}</p>
        {activeEvents && provider?.tunnel?.state === 'failed' && provider.tunnel.error && <p>{provider.tunnel.error}</p>}
        <small>{provider?.tunnel?.installed ? `隧道组件已安装${provider.tunnel.version ? ' · ' + provider.tunnel.version : ''}` : '隧道组件尚未就绪'}{activeEvents && tunnelReady ? ` · ${provider?.subscriptionCount || 0} 个有效订阅` : ''}</small>
      </section>
      <div className="pd-dots-setup-section"><h3><span>1</span>创建并启动官方隧道</h3>
        <div className="pd-dots-links"><button type="button" disabled={busy} onClick={() => void open('https://platform.openai.com/settings/organization/tunnels')}>创建 Tunnel<ArrowUpRight size={12}/></button><button type="button" disabled={busy} onClick={() => void open('https://platform.openai.com/settings/organization/api-keys')}>创建运行密钥<ArrowUpRight size={12}/></button><button type="button" disabled={busy} onClick={() => void open('https://developers.openai.com/api/docs/guides/secure-mcp-tunnels')}>官方接入说明<ArrowUpRight size={12}/></button></div>
        <label htmlFor="dots-tunnel-id">Tunnel ID</label><input id="dots-tunnel-id" value={tunnelId} maxLength={256} spellCheck={false} autoComplete="off" disabled={busy || !desktop} placeholder="粘贴官方控制台中的 Tunnel ID" onChange={event => { idEdited.current = true; setTunnelId(event.target.value); }}/>
        <label htmlFor="dots-tunnel-key">Tunnel 运行密钥</label><div className="pd-secret-field"><KeyRound size={14}/><input id="dots-tunnel-key" type="password" value={runtimeKey} autoComplete="new-password" spellCheck={false} disabled={busy || !desktop} placeholder={matchingSavedKey ? '已保存，留空沿用；粘贴新密钥可更换' : '仅授予此 Tunnel 运行权限的密钥'} onChange={event => setRuntimeKey(event.target.value)}/></div>
        <p className="pd-field-hint">运行密钥需具备组织级 Tunnels Read + Use 权限（非普通模型 API Key）。</p>
        <div className="pd-dots-actions"><button type="button" className="pd-primary" disabled={!desktop || busy || loading || !tunnelId.trim() || !runtimeKey.trim() && !matchingSavedKey} onClick={() => void saveEvents()}>{busy ? <LoaderCircle size={13} className="pd-busy"/> : <Play size={13}/>}保存并启动</button>{activeEvents && ['starting', 'ready'].includes(provider?.tunnel?.state || '') && <button type="button" className="pd-secondary" disabled={busy} onClick={() => void stop()}><Square size={11}/>停止连接</button>}</div>
      </div>
      <div className="pd-dots-setup-section"><h3><span>2</span>关联 MCP 插件</h3><p>在 ChatGPT 中添加自定义 MCP 插件，选择该 Tunnel 并关联到 omdot。</p><button type="button" className="pd-link" disabled={busy} onClick={() => void open('https://chatgpt.com/plugins')}>打开 ChatGPT 插件设置<ArrowUpRight size={12}/></button></div>
      <div className="pd-dots-setup-section"><h3><span>3</span>发送订阅指令</h3><p>将订阅指令发送给 omdot，收到有效订阅后状态将变为已就绪。</p><button type="button" className="pd-secondary" disabled={!provider?.setupMessage || busy || !activeEvents} onClick={() => void copySetup()}><Copy size={12}/>复制订阅指令</button>{provider?.setupMessage && <details className="pd-dots-setup-message" open={showSetup} onToggle={event => setShowSetup(event.currentTarget.open)}><summary>查看订阅指令</summary><pre>{provider.setupMessage}</pre></details>}</div>
    </div> : actualTransport === 'events' ? <section className="pd-dots-switch"><Link2 size={20}/><h3>当前使用官方事件连接</h3><p>切换后可使用账号登录并选择 Dot。</p><button type="button" className="pd-primary" disabled={!desktop || busy} onClick={() => void saveDirect()}>{busy && <LoaderCircle size={13} className="pd-busy"/>}切换为客户端直连</button></section> : <>
      <div className="pd-dots-direct-note"><strong>待办插件 · {tunnelReady ? '已验证连接' : provider?.tunnel?.state === 'starting' ? '等待平台确认' : configured ? '尚未在线' : '尚未配置'}</strong><p>原 Dot 负责聊天；官方隧道让它读取项目待办、提交评审建议，两条连接可同时使用。</p>{configured && <div className="pd-dots-actions">{['ready', 'starting'].includes(provider?.tunnel?.state || '') ? <button type="button" className="pd-secondary" disabled={busy || directBusy} onClick={() => void stop()}><Square size={11}/>停止待办插件</button> : <button type="button" className="pd-secondary" disabled={!desktop || busy || directBusy} onClick={() => void startPlugin()}><Play size={12}/>启动待办插件</button>}<button type="button" className="pd-icon" aria-label="检查待办插件连接" disabled={busy || directBusy} onClick={() => void refresh()}><RefreshCw size={13}/></button></div>}{provider?.tunnel?.error && <p>{provider.tunnel.error}</p>}</div>
      {renderDirect(setDirectBusy)}
    </>}
    {notice && <p className="pd-probe-success" role="status">{notice}</p>}
    {error && <p className="pd-inline-error" role="alert">{error}</p>}
  </div>;
}

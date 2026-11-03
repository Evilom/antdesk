import { ArrowRight, Bot, Check, ChevronRight, CircleDot, Inbox, LoaderCircle, MessageCircle, RefreshCw, Settings2, Square } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import type { useAgentWorkspace } from './useAgentWorkspace';
import { PROTOCOLS, isActiveRun, isNativeProfile, isProfileConfigured, isRuntimeProfile } from '../../lib/assistant-profiles.mjs';
import { runLabel } from './RunResult';
import type { useAssistantChat } from './useAssistantChat';
import AssistantChat from './AssistantChat';
import './assistant-connections.css';
import './notion-connection.css';

export type AssistantPage = 'chat' | 'workspace' | 'connections';
export default function AgentsView({ agents, chat, page, onPageChange: setPage, onInteractionChange, onChat, voiceActive }: {
  agents: ReturnType<typeof useAgentWorkspace>; onChat: () => void; voiceActive: boolean;
  chat: ReturnType<typeof useAssistantChat>; page: AssistantPage; onPageChange: (page: AssistantPage) => void;
  onInteractionChange: (value: boolean) => void;
}) {
  const readyCount = agents.profiles.filter(profile => agents.connectionCheck(profile)?.ok).length;
  const activeRuns = agents.runs.filter(isActiveRun);
  const attention = activeRuns.filter(run => run.attention);
  const reviewCount = agents.runs.filter(run => run.status === 'review' && !run.reviewed && !run.handedOff).length;
  const runtimeProfiles = agents.profiles;
  const connectedLabel = (profile: { protocol: string }) => profile.protocol === 'notion-web' && !agents.providers.find(item => item.id === 'notion-web')?.aiVerified ? '已登录 · 待首次回复' : '已就绪';
  const refresh = () => { void agents.refresh(); void agents.refreshProviders(); if (page === 'chat') void chat.refresh(); };
  const cards = (profiles: typeof agents.profiles) => profiles.map(profile => {
    const active = activeRuns.find(run => run.agentId === profile.id);
    const check = agents.connectionCheck(profile);
    const dotsEvents = profile.protocol === 'dots-direct' && profile.agentRef === 'omdot-events';
    const metadata = dotsEvents ? { ...PROTOCOLS[profile.protocol], official: true, badge: '官方事件', detail: 'ChatGPT 插件事件连接' } : PROTOCOLS[profile.protocol];
    const description = dotsEvents ? '通过官方插件接收事项与消息并回传结果。' : profile.description;
    const configured = isProfileConfigured(profile);
    const runtime = isRuntimeProfile(profile);
    const pending = profile.protocol === 'muse-manual';
    const status = active ? runLabel(active) : check?.ok ? connectedLabel(profile)
      : check?.readiness === 'needs_login' ? '未登录'
      : check?.readiness === 'needs_api_key' ? '缺少 API Key'
      : check?.readiness === 'needs_configuration' ? profile.protocol === 'notion-web' ? '选择工作区' : '待配置'
      : check?.readiness === 'needs_validation' ? '待验证'
      : check?.readiness === 'invalid_credentials' ? '授权无效'
      : check?.readiness === 'blocked' ? '账号受限'
      : check?.readiness === 'needs_install' ? '需安装组件'
      : check?.readiness === 'needs_subscription' ? profile.protocol === 'notion-web' ? '检查 AI 权益' : '待订阅事件'
      : check?.readiness === 'needs_public_url' ? '缺少公网地址'
      : check?.readiness === 'needs_agent_connection' ? runtime ? profile.protocol === 'dots-direct' ? '未选择 Dot' : '未选择 Bot' : '未绑定助理'
      : check ? '未就绪'
      : pending ? '未接入'
      : runtime ? !isTauri() ? '仅桌面版可用' : agents.runtimeLoading ? '读取中' : '状态未知'
      : configured ? '待检查' : '未配置';
    const avatar = profile.protocol === 'notion-web' ? 'N' : profile.protocol === 'muse-personal' ? 'm' : profile.protocol.startsWith('grok') ? 'G' : 'D';
    return <section className="pd-agent pd-workspace-agent" data-provider={profile.protocol} data-ready={Boolean(check?.ok)} key={profile.id}>
      <div className="pd-agent-heading"><span className="pd-agent-avatar">{avatar}</span><div><div className="pd-agent-name-line"><strong>{pending && ['Muse', 'MuseAI'].includes(profile.name) ? 'Muse 会话' : profile.name}</strong><span className={'pd-route-badge ' + (metadata.official ? 'official' : '')}>{metadata.badge}</span></div><small>{metadata.detail}</small></div><button className="pd-icon" aria-label={'配置 ' + profile.name} onClick={() => agents.configure(profile.id)}><Settings2 size={14}/></button></div>
      <div className="pd-agent-card-bottom"><span className={'pd-agent-state ' + (check?.ok ? 'ready' : '')}>{active && !active.attention ? <LoaderCircle size={11} className="pd-busy"/> : check?.ok ? <Check size={11}/> : <CircleDot size={11}/>} {status}</span><button className="pd-link" onClick={() => active ? agents.showResult(active.id) : agents.configure(profile.id)}>{active ? '查看进度' : check?.ok ? '配置' : pending ? '查看' : '连接'}<ChevronRight size={12}/></button></div>
      {description && page === 'connections' && <p className="pd-reason">{description}</p>}
      {page === 'connections' && check?.message && <p className="pd-field-hint">{check.message}</p>}
    </section>;
  });
  return <div className="pd-workspace" data-view={page}>
    <div className="pd-workspace-tabs" role="tablist" aria-label="助理视图">
      <button role="tab" id="assistant-chat-tab" aria-controls="assistant-chat-panel" aria-selected={page === 'chat'} onClick={() => setPage('chat')}>聊天</button>
      <button role="tab" id="assistant-workspace-tab" aria-controls="assistant-workspace-panel" aria-selected={page === 'workspace'} onClick={() => setPage('workspace')}>任务{attention.length > 0 && <i/>}</button>
      <button role="tab" id="assistant-connections-tab" aria-controls="assistant-connections-panel" aria-selected={page === 'connections'} onClick={() => setPage('connections')}>连接<span>{readyCount}/{agents.profiles.length}</span></button>
      <button className="pd-icon" aria-label="刷新状态" onClick={refresh}><RefreshCw size={13} className={agents.loading || agents.runtimeLoading ? 'pd-busy' : undefined}/></button>
    </div>
    {page === 'chat' ? <div id="assistant-chat-panel" className="pd-chat-panel" role="tabpanel" aria-labelledby="assistant-chat-tab"><AssistantChat chat={chat} agents={agents} onInteractionChange={onInteractionChange} onConnections={() => setPage('connections')}/></div> : page === 'workspace' ? <div id="assistant-workspace-panel" role="tabpanel" aria-labelledby="assistant-workspace-tab">
      <section className="pd-workspace-bar">
        <div className="pd-workspace-metrics">
          <span><strong>{readyCount}</strong> 就绪</span>
          <span><strong>{activeRuns.length}</strong> 进行中</span>
          <span><strong>{reviewCount}</strong> 待确认</span>
        </div>
        <div className="pd-workspace-bar-actions">
          <button className="pd-secondary" onClick={onChat}><MessageCircle size={13}/>{voiceActive ? '通话中' : '语音'}</button>
          <button className="pd-primary" onClick={() => readyCount ? agents.dispatch() : setPage('connections')}>{readyCount ? <Bot size={13}/> : <ArrowRight size={13}/>}{readyCount ? '派发任务' : '连接助理'}</button>
        </div>
      </section>
      {attention.map(run => <button className="pd-attention-banner" key={run.id} onClick={() => agents.showResult(run.id)}><span className="pd-attention-orb"><MessageCircle size={15}/></span><span><strong>{run.attention?.title || '待处理请求'}</strong><small>{run.agentName} · {run.taskTitle}</small></span><ChevronRight size={15}/></button>)}
      <div className="pd-section-heading"><h2>助理状态</h2><button className="pd-link" onClick={() => setPage('connections')}>管理<ChevronRight size={11} className="pd-inline-icon"/></button></div>
      <div className="pd-roster-strip">{runtimeProfiles.map(profile => <button key={profile.id} data-provider={profile.protocol} onClick={() => agents.configure(profile.id)}><span className={'pd-status-dot ' + (agents.connectionCheck(profile)?.ok ? '' : 'off')}/><strong>{profile.name}</strong><small>{agents.connectionCheck(profile)?.ok ? connectedLabel(profile) : '未就绪'}</small></button>)}</div>
      <div className="pd-section-heading"><h2>派发记录</h2><span>{agents.runs.length}</span></div>
      {agents.error && <p className="pd-inline-error" role="alert">{agents.error}</p>}
      {agents.loading && !agents.runs.length ? <p className="pd-empty-inline">正在加载…</p> : agents.runs.length ? agents.runs.slice(0, 50).map(run => {
        const active = isActiveRun(run);
        const native = isNativeProfile(run);
        const runtime = isRuntimeProfile(run);
        const canSync = active && native && Boolean(run.externalRunId || run.sessionId);
        const syncing = agents.syncing.includes(run.id);
        const lastMessage = [...(run.messages || [])].reverse().find(message => message.role === 'assistant' && message.text);
        return <article className="pd-run pd-workspace-run" data-attention={Boolean(active && run.attention)} key={run.id}>
          <div className="pd-run-title">{active && !run.attention && run.status !== 'interrupted' && <LoaderCircle size={12} className="pd-busy"/>}<strong>{run.taskTitle}</strong><span className={'pd-tag ' + (run.status === 'review' && !run.reviewed ? 'good' : run.attention || run.status === 'failed' || run.deliveryStatus === 'unknown' ? 'warn' : '')}>{runLabel(run)}</span></div>
          <div className="pd-meta"><span>{run.agentName}</span><span>{new Date(run.updatedAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})}</span>{run.parentRunId && <span>接力</span>}{run.sessionId && <span>已关联会话</span>}</div>
          {(run.progress || lastMessage) && <p className="pd-run-progress compact">{run.progress || lastMessage?.text}</p>}
          {run.error && <p className="pd-field-hint">{run.error}</p>}
          <div className="pd-run-actions pd-native-run-actions">
            <button className={run.attention ? 'pd-primary' : 'pd-secondary'} onClick={() => agents.showResult(run.id)}>{active && run.attention ? '处理' : run.result ? '查看结果' : run.messages?.length ? '打开会话' : active ? '查看进度' : '详情'}<ArrowRight size={11}/></button>
            {canSync && <button className="pd-secondary" disabled={syncing} onClick={() => void agents.sync(run.id)}><RefreshCw size={11} className={syncing ? 'pd-busy' : undefined}/>{run.status === 'interrupted' ? '恢复同步' : '同步'}</button>}
            {active ? <button className="pd-link" onClick={() => void agents.cancel(run.id)}><Square size={10} className="pd-inline-icon"/>{native && !runtime ? '停止等待' : '取消'}</button> : !run.result && <button className="pd-link" onClick={() => agents.dispatch(run.taskId)}>重新派发</button>}
          </div>
        </article>;
      }) : <section className="pd-workspace-empty"><div><Inbox size={20}/></div><h3>暂无派发记录</h3><p>将待办派给助理后，执行进度与返回结果会显示在这里。</p></section>}
    </div> : <div id="assistant-connections-panel" role="tabpanel" aria-labelledby="assistant-connections-tab">
      {!isTauri() && <p className="pd-preview-note">当前为浏览器预览，账号登录与派发需在桌面端使用。</p>}
      {agents.runtimeError && <div className="pd-connection-result pending" role="status"><strong>无法读取连接状态</strong><p>{agents.runtimeError}</p><button className="pd-link" onClick={() => void agents.refreshProviders()}>重试</button></div>}
      {cards(runtimeProfiles)}
    </div>}
  </div>;
}

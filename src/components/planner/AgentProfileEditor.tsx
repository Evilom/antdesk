import { useState } from 'react';
import { Check, Copy, ExternalLink, LoaderCircle, PlugZap, ShieldCheck } from 'lucide-react';
import { isTauri } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import { BRIDGE_ENDPOINT, PROTOCOLS, isNativeProfile, isRuntimeProfile, isProfileConfigured, validateProfile, type ProfileData } from '../../lib/assistant-profiles.mjs';
import type { ProbeResult } from '../../lib/agentHub';
import Sheet from './Sheet';
import RuntimeConnection from './RuntimeConnection';
import NotionConnection from './NotionConnection';
import './assistant-connections.css';

export interface AssistantProfile extends ProfileData {}
export interface ConnectionCredentials { primary: string; bridge: string }

function setupInstruction(profile: AssistantProfile, mcpUrl?: string) {
  const agent = profile.agentRef?.trim() || profile.id;
  const shared = '使用消息里的 run_id，通过 AntDesk MCP 的 get_task 读取事项，claim_task 领取，report_progress 汇报进度，submit_result 提交完整结果；无法完成时使用 fail_task。提交结果后等待我复核，不自行宣称事项已被采纳。';
  if (profile.protocol === 'dots-mcp') return '连接 AntDesk 的公网 HTTPS MCP 服务' + (mcpUrl ? '（' + mcpUrl + '）' : '（使用我提供的地址）') + '，订阅 antdesk.task.assigned 事件，过滤条件 arguments.agent_id = ' + agent + '。收到事件后，' + shared;
  return '连接 AntDesk 的公网 HTTPS MCP 服务' + (mcpUrl ? '（' + mcpUrl + '）' : '（使用我提供的地址）') + '，为当前 Grok Bot 创建一个由 Webhook 触发的工作流程，只处理助理标识为 ' + agent + ' 的事项。Webhook JSON 包含事项与运行编号，' + shared + ' 创建后请给我这个工作流程的 POST URL 和 Bearer key。';
}

export default function AgentProfileEditor({ profile, onSave, onProbe, onClearCredential, onClose, onRuntimeUpdated }: {
  profile: AssistantProfile;
  onSave: (profile: AssistantProfile, credentials: ConnectionCredentials, checked?: ProbeResult | null) => Promise<void>;
  onProbe: (profile: AssistantProfile, credentials: ConnectionCredentials) => Promise<ProbeResult>;
  onClearCredential: () => Promise<void>; onClose: () => void; onRuntimeUpdated?: () => void;
}) {
  const [draft, setDraft] = useState({ ...profile });
  const [credentials, setCredentials] = useState<ConnectionCredentials>({ primary: '', bridge: '' });
  const [busy, setBusy] = useState(false);
  const [runtimeBusy, setRuntimeBusy] = useState(false);
  const [check, setCheck] = useState<ProbeResult | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const runtime = isRuntimeProfile(draft);
  const native = isNativeProfile(draft) && !runtime;
  const pending = draft.protocol === 'muse-manual';
  const dotsEvents = draft.protocol === 'dots-direct' && draft.agentRef === 'omdot-events';
  const metadata = dotsEvents ? { ...PROTOCOLS[draft.protocol], official: true, badge: '官方事件', detail: 'ChatGPT 插件事件连接' } : PROTOCOLS[draft.protocol];
  const change = (next: Partial<AssistantProfile>) => { setDraft(value => ({ ...value, ...next })); setCheck(null); setNotice(''); setError(''); };
  const run = async (test: boolean) => {
    setNotice(''); setError(''); setBusy(true); setCheck(null);
    try {
      const value = validateProfile(draft);
      if (test) setCheck(await onProbe(value, credentials));
      else {
        const verified = value.protocol === 'dots-direct' && isProfileConfigured(value) ? await onProbe(value, credentials).catch(() => ({ok: false, readiness: 'unavailable' as const, message: '配置已保存，Dot 连接状态暂未确认，请刷新重试。'})) : check;
        await onSave(value, credentials, verified); setCredentials({ primary: '', bridge: '' }); onClose();
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const openReference = async (url: string) => {
    try { if (isTauri()) await open(url); else window.open(url, '_blank', 'noopener,noreferrer'); }
    catch { setError('暂时无法打开浏览器。资料地址：' + url); }
  };
  const copySetup = async () => {
    try { await navigator.clipboard.writeText(setupInstruction(draft, check?.mcpUrl)); setNotice('接入说明已复制，可交给这位助理完成订阅或工作流程配置。'); }
    catch { setError('无法访问剪贴板，请直接选中接入说明复制。'); }
  };
  return <Sheet title="助理连接配置" onClose={busy || runtimeBusy ? () => {} : onClose} actions={<>
    {!pending && !runtime && <button className="pd-secondary" onClick={() => void run(true)} disabled={busy}>{busy ? <LoaderCircle size={13} className="pd-busy"/> : <PlugZap size={13}/>}测试连接</button>}
    <button className="pd-primary" onClick={() => void run(false)} disabled={busy || runtimeBusy}>{busy ? <LoaderCircle size={13} className="pd-busy"/> : <Check size={13}/>}保存</button>
  </>}>
    <label htmlFor="agent-name">名称</label><input id="agent-name" data-dialog-autofocus value={draft.name} maxLength={80} onChange={e => change({ name: e.target.value })}/>
    <div className={'pd-route-card ' + (metadata.official ? 'official' : '')} data-protocol={draft.protocol}>
      <div className="pd-route-title">{metadata.official && <ShieldCheck size={14}/>}<strong>{metadata.detail}</strong><span>{metadata.badge}</span></div>
      <p>{draft.protocol === 'grok-direct' ? '登录 Grok 账号，选择 Bot 与工作会话。'
        : draft.protocol === 'notion-web' ? '使用已有 Notion 网页会员，处理当前项目与任务的评审。'
        : draft.protocol === 'dots-direct' ? dotsEvents ? '通过 ChatGPT 官方插件与事件隧道收发消息。' : '通过账号授权连接 Dot 并关联会话。'
        : draft.protocol === 'muse-personal' ? '通过独立浏览器窗口登录 Muse AI，按事项自动建立会话。'
        : draft.protocol === 'muse-code' ? '官方本地助理，支持执行任务、请求审批与回传结果。'
        : draft.protocol === 'deepseek-harness' ? '使用 DeepSeek 账号或 API Key 连接运行环境。'
        : draft.protocol === 'grok-webhook' ? '通过 Webhook 触发 Grok Bot 工作流，经由 MCP 回传进度与结果。'
        : draft.protocol === 'dots-mcp' ? '订阅 AntDesk 事项分配事件并回传执行结果。'
        : pending ? '旧版会话记录入口，暂不支持直接派发。'
        : '连接 OpenAI 兼容接口服务。'}</p>
    </div>
    {runtime && (draft.protocol === 'notion-web'
      ? <NotionConnection profile={draft} onChange={change} onBusy={setRuntimeBusy} onUpdated={onRuntimeUpdated}/>
      : <RuntimeConnection key={draft.protocol} profile={draft} onChange={change} onBusy={setRuntimeBusy} onUpdated={onRuntimeUpdated}/>)}
    {!runtime && <>
    <label htmlFor="agent-description">适合处理</label><input id="agent-description" value={draft.description || ''} maxLength={300} onChange={e => change({ description: e.target.value })} placeholder="例如：调研资料、复核方案、拆分任务"/>
    {native && <>
      <label htmlFor="agent-ref">助理标识</label><input id="agent-ref" value={draft.agentRef || draft.id} maxLength={128} onChange={e => change({ agentRef: e.target.value })} spellCheck={false}/>
      <p className="pd-field-hint">连接服务与这位助理使用同一标识，用来准确分配事项。</p>
    </>}
    {!pending && <>
      <label htmlFor="agent-endpoint">{native ? 'AntDesk 连接服务' : '模型服务地址'}</label><input id="agent-endpoint" value={draft.endpoint} onChange={e => change({ endpoint: e.target.value })} placeholder={native ? BRIDGE_ENDPOINT : 'https://你的服务/v1'} spellCheck={false}/>
      <p className="pd-field-hint">{native ? '桌面端连接这个地址。云端助理需要另外绑定连接服务的公网 HTTPS MCP 地址。' : '填写兼容服务地址或完整的 /chat/completions 地址。'}</p>
    </>}
    {draft.protocol === 'grok-webhook' && <>
      <label htmlFor="agent-webhook">Grok 工作流程 Webhook</label><input id="agent-webhook" value={draft.webhookUrl || ''} onChange={e => change({ webhookUrl: e.target.value })} placeholder="工作流程里的 POST URL" spellCheck={false}/>
      <label htmlFor="agent-credential">Grok Webhook 密钥 · 本次会话</label><input id="agent-credential" type="password" value={credentials.primary} onChange={e => { setCredentials(value => ({ ...value, primary: e.target.value })); setCheck(null); }} autoComplete="off" placeholder="只粘贴 key，不包含 Bearer 前缀"/>
    </>}
    {draft.protocol === 'openai' && <>
      <label htmlFor="agent-model">模型名称</label><input id="agent-model" value={draft.model} onChange={e => change({ model: e.target.value })} placeholder="服务实际提供的模型 ID" spellCheck={false}/>
      <label htmlFor="agent-credential">API Key · 本次会话</label><input id="agent-credential" type="password" value={credentials.primary} onChange={e => { setCredentials(value => ({ ...value, primary: e.target.value })); setCheck(null); }} autoComplete="off" placeholder="留空保留当前会话密钥"/>
    </>}
    {native && <>
      <label htmlFor="agent-bridge-key">连接服务密钥 · 本次会话</label><input id="agent-bridge-key" type="password" value={credentials.bridge} onChange={e => { setCredentials(value => ({ ...value, bridge: e.target.value })); setCheck(null); }} autoComplete="off" placeholder="部署 AntDesk 连接服务时设置的密钥"/>
      <details className="pd-setup-details"><summary>首次接入 · 配置这位助理</summary>
        <ol>{draft.protocol === 'grok-webhook' ? <>
          <li>为这位 Grok 连接 AntDesk 的公网 MCP 服务。</li><li>创建带 Webhook 的工作流程，复制 POST URL 与密钥填入上方。</li><li>检查连接，再从一个测试事项开始。</li>
        </> : <>
          <li>在 ChatGPT 中连接 AntDesk 的公网 MCP 服务，并绑定这位 DOTS。</li><li>让它订阅分配给本标识的事项事件。</li><li>检查显示“已就绪”后，再从一个测试事项开始。</li>
        </>}</ol>
        <p className="pd-setup-text">{setupInstruction(draft, check?.mcpUrl)}</p>
        <button className="pd-link" onClick={() => void copySetup()}><Copy size={12}/>复制给助理的接入说明</button>
        <button className="pd-link" onClick={() => void openReference(draft.protocol === 'grok-webhook' ? 'https://docs.x.ai/grok-bot/skills-routines-and-automations' : 'https://developers.openai.com/plugins/build/mcp-events')}><ExternalLink size={12}/>查看官方文档</button>
      </details>
    </>}
    {pending && <div className="pd-setup-details">
      <p className="pd-field-hint">原有会话可以继续使用。接入事项派发后，才会显示为可分配助理。</p>
      <div className="pd-reference-links"><button className="pd-link" onClick={() => void openReference('https://muse.ai')}><ExternalLink size={12}/>打开原 Muse 服务</button></div>
    </div>}
    {!pending && <>
      <p className="pd-field-hint pd-secret-note">密钥只保存在桌面进程内存，重启后需重新填写；留空保留当前会话密钥。</p>
      <button className="pd-link" disabled={busy} onClick={() => { setBusy(true); setError(''); void onClearCredential().then(() => { setCredentials({ primary: '', bridge: '' }); setCheck(null); setNotice('本次会话密钥已清除。'); }).catch(cause => setError(String(cause))).finally(() => setBusy(false)); }}>清除本次会话密钥</button>
      <p className="pd-field-hint">{native ? '检查连接只读取服务状态，不会启动真实任务。Grok Webhook 密钥要在实际派发时才能确认有效。' : '检查连接会向所配置的模型发送一条简短测试请求。'}</p>
    </>}
    {check && <div className={'pd-connection-result ' + (check.ok ? 'ready' : 'pending')} role="status"><strong>{check.ok ? '连接检查通过' : check.readiness === 'needs_subscription' ? '等待助理订阅' : check.readiness === 'needs_public_url' ? '等待公网连接地址' : check.readiness === 'needs_agent_connection' ? '等待绑定助理' : '连接尚未就绪'}</strong><p>{check.message}</p></div>}
    </>}
    {notice && <p className="pd-probe-success" role="status">{notice}</p>}
    {error && <p className="pd-inline-error" role="alert">{error}</p>}
  </Sheet>;
}

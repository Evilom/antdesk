import { useEffect, useState } from 'react';
import { ArrowRight, Check, Copy, LoaderCircle, MessageCircle, RefreshCw, Send, ShieldCheck, Square } from 'lucide-react';
import { isActiveRun, isNativeProfile, isRuntimeProfile, runStatusLabel } from '../../lib/assistant-profiles.mjs';
import type { AgentRun } from '../../lib/agentHub';
import type { RuntimeResponse } from '../../lib/assistantRuntime';
import Sheet from './Sheet';

export interface RunView {
  id: string; taskId: string; taskTitle: string; agentId: string; agentName: string; status: string;
  result: string; error: string; createdAt: number; updatedAt: number; parentRunId?: string; reviewed?: boolean;
  handedOff?: boolean; reviewDecision?: 'accepted' | 'rejected';
  protocol?: string; progress?: string; deliveryStatus?: string; externalRunId?: string;
  sessionId?: string; turnId?: string; cursor?: string; remoteStopped?: boolean;
  attention?: AgentRun['attention']; messages?: AgentRun['messages'];
}
export const RUN_LABELS: Record<string, string> = {
  queued: '排队中', running: '处理中', review: '待复核', succeeded: '待复核', completed: '待复核',
  failed: '执行失败', cancelled: '已取消', interrupted: '已中断', accepted: '已采纳', rejected: '需重做',
};
export function runLabel(run: RunView) { return runStatusLabel(run); }

export default function RunResult({ run, canDecide, canContinue, onClose, onHandoff, onAccept, onReject, onRetry, onSync, onStop, onRespond, onLogin, operationError }: {
  run: RunView; canDecide: boolean; canContinue: boolean; onClose: () => void; onHandoff: () => void;
  onAccept: () => Promise<void>; onReject: () => Promise<void>; onRetry: () => void;
  onSync?: () => Promise<void>; onStop?: () => Promise<void>; operationError?: string;
  onRespond?: (response: RuntimeResponse) => Promise<void>; onLogin?: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [answer, setAnswer] = useState('');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const native = isNativeProfile(run);
  const runtime = isRuntimeProfile(run);
  const attention = isActiveRun(run) ? run.attention : undefined;
  useEffect(() => { setAnswer(''); setAnswers({}); setError(''); }, [attention?.id]);
  const action = async (perform: () => Promise<void>, close = false) => {
    setBusy(true); setError('');
    try { await perform(); if (close) onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const copy = async () => { try { await navigator.clipboard.writeText(run.result); setCopied(true); } catch { setError('无法访问剪贴板，可以直接选中文字复制。'); } };
  const respond = (decision?: string) => action(async () => {
    if (!attention || !onRespond) throw new Error('这条请求已变化，请同步进度后重试。');
    if (attention.fields?.some(field => field.required && !answers[field.id]?.trim())) throw new Error('请填写需要补充的内容。');
    if (attention.kind === 'input' && !decision && !attention.fields?.length && !answer.trim()) throw new Error('写下你的回复后再发送。');
    await onRespond({ attentionId: attention.id, ...(decision ? { decision } : {}), ...(Object.keys(answers).length ? { answers } : {}), ...(answer.trim() ? { text: answer.trim() } : {}) });
    setAnswer(''); setAnswers({});
  });
  return <Sheet title={run.result ? '执行结果' : '执行进度'} onClose={busy ? () => {} : onClose} actions={<>
    {onSync && <button className="pd-secondary" disabled={busy} onClick={() => void action(onSync)}><RefreshCw size={13} className={busy ? 'pd-busy' : undefined}/>{run.status === 'interrupted' ? '恢复同步' : '同步'}</button>}
    {run.result ? <>{canContinue && <button className="pd-secondary" disabled={busy} onClick={onHandoff}><ArrowRight size={13}/>转交其他助理</button>}{canDecide && <button className="pd-primary" disabled={busy} onClick={() => void action(onAccept, true)}>{busy ? <LoaderCircle size={13} className="pd-busy"/> : <Check size={13}/>}确认完成</button>}</> : canContinue && <button className="pd-primary" onClick={onRetry}>重新派发</button>}
    {!run.result && canContinue && (run.messages?.length || run.progress) && <button className="pd-secondary" disabled={busy} onClick={onHandoff}><ArrowRight size={13}/>转交上下文</button>}
    {!run.result && !onSync && !canContinue && <button className="pd-secondary" onClick={onClose}>关闭</button>}
  </>}>
    <h3 className="pd-result-title">{run.taskTitle}</h3><div className="pd-meta"><span>{run.agentName}</span><span>{runLabel(run)}</span><span>{new Date(run.createdAt).toLocaleString('zh-CN', {month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit'})}</span></div>
    {run.parentRunId && <p className="pd-field-hint">本次运行承接上一位助理的结果。</p>}
    {run.handedOff && <p className="pd-field-hint">这份结果已交给下一位助理，最终复核请查看后续运行。</p>}
    {!canDecide && !run.reviewed && !run.handedOff && run.result && <p className="pd-field-hint">当前事项尚有后续运行或暂不可用，可以阅读和复制这份结果。</p>}
    {attention && <section className="pd-run-attention" aria-label="需要你处理" aria-live="polite">
      <div className="pd-attention-heading">{attention.kind === 'approval' ? <ShieldCheck size={16}/> : <MessageCircle size={16}/>}<div><small>{attention.kind === 'approval' ? '等待你的审批' : attention.kind === 'login' ? '需要重新登录' : '助理需要补充信息'}</small><h3>{attention.title}</h3></div></div>
      {attention.description && <p className="pd-attention-description">{attention.description}</p>}
      {attention.kind === 'login' ? <>{onLogin && <button className="pd-primary" disabled={busy} onClick={onLogin}>前往连接页<ArrowRight size={12}/></button>}<p className="pd-field-hint">{onLogin ? '完成登录后回到这条记录，恢复同步。' : '请在原助理中完成登录，再回到这条记录同步进度。'}</p></> : onRespond ? <>
        {attention.fields?.map(field => <div key={field.id}><label htmlFor={'attention-' + field.id}>{field.label}{field.required ? ' *' : ''}</label><input id={'attention-' + field.id} type={field.secret ? 'password' : 'text'} autoComplete="off" value={answers[field.id] || ''} required={field.required} disabled={busy} onChange={e => setAnswers(value => ({ ...value, [field.id]: e.target.value }))}/></div>)}
        <label htmlFor="attention-answer">{attention.kind === 'approval' ? '补充说明 · 可选' : attention.fields?.length || attention.options?.length ? '补充回复 · 可选' : '你的回复'}</label>
        <textarea id="attention-answer" rows={3} value={answer} maxLength={12000} disabled={busy} onChange={e => setAnswer(e.target.value)} placeholder={attention.kind === 'approval' ? '例如：仅处理当前事项的文件' : '补充信息，让助理继续工作…'}/>
        <div className="pd-attention-actions">{attention.options?.length ? attention.options.map(option => <button key={option.id} className="pd-secondary" disabled={busy} onClick={() => void respond(option.id)}>{option.label}</button>) : attention.kind === 'approval' ? <><button className="pd-secondary" disabled={busy} onClick={() => void respond('reject')}>不允许</button><button className="pd-primary" disabled={busy} onClick={() => void respond('approve')}><Check size={13}/>允许这次操作</button></> : <button className="pd-primary" disabled={busy} onClick={() => void respond()}>{busy ? <LoaderCircle size={13} className="pd-busy"/> : <Send size={13}/>}发送并继续</button>}</div>
      </> : <p className="pd-field-hint">请在原助理会话中处理，然后同步进度。</p>}
    </section>}
    {run.progress && <><div className="pd-section-heading"><h2>最新进度</h2></div><div className="pd-run-progress">{run.progress}</div></>}
    {run.error && <div className="pd-inline-error">{run.error}</div>}
    {Boolean(run.messages?.length) && <><div className="pd-section-heading"><h2>会话记录</h2><span>{run.messages!.length} 条</span></div><div className="pd-run-messages">{run.messages!.map((message, index) => message.role === 'tool' ? <details className="pd-tool-message" key={message.id || index}><summary>工具执行记录{message.complete === false && isActiveRun(run) ? ' · 进行中' : ''}</summary><div>{message.text}</div></details> : <article className="pd-run-message" data-role={message.role} key={message.id || index}><header><strong>{message.role === 'user' ? '你' : run.agentName}</strong>{message.updatedAt && <time>{new Date(message.updatedAt).toLocaleTimeString('zh-CN', {hour: '2-digit', minute: '2-digit'})}</time>}{message.complete === false && isActiveRun(run) && <span>正在回复</span>}</header><div>{message.text || (message.complete === false && isActiveRun(run) ? '等待回复内容…' : '无文字内容')}</div></article>)}</div></>}
    {run.result && <><div className="pd-section-heading"><h2>返回内容</h2><button className="pd-link" onClick={() => void copy()}><Copy size={11} style={{display: 'inline', marginRight: 4}}/>{copied ? '已复制' : '复制'}</button></div><div className="pd-result">{run.result}</div></>}
    {!run.result && !run.error && !run.messages?.length && !attention && <p className="pd-empty-inline">{isActiveRun(run) ? '正在等待助理回复。返回结果后，再由你复核。' : run.status === 'cancelled' ? '本次等待已结束，没有收到可复核的结果。' : run.status === 'interrupted' ? '同步已中断，尚未收到可复核的结果。' : '这次运行尚未返回可复核的内容。'}</p>}
    {(run.sessionId || run.externalRunId) && <details className="pd-session-details"><summary>会话与运行信息</summary>{run.sessionId && <p>会话：{run.sessionId}</p>}{run.externalRunId && <p>运行：{run.externalRunId}</p>}{run.turnId && <p>轮次：{run.turnId}</p>}</details>}
    {onStop && <><button className="pd-link" style={{marginTop: 14}} disabled={busy} onClick={() => void action(onStop)}><Square size={11} style={{display: 'inline', marginRight: 5}}/>{native && !runtime ? '停止等待这个结果' : '取消运行'}</button>{native && !runtime && <p className="pd-native-note">助理端可能继续工作。如需停止，请前往它的会话处理。</p>}</>}
    {runtime && run.status === 'cancelled' && <p className="pd-native-note">{run.remoteStopped ? '助理已确认停止这次运行，会话记录已保留。' : '本地已停止等待，助理端是否停止尚未确认。'}</p>}
    {canDecide && <button className="pd-link" style={{marginTop: 18}} disabled={busy} onClick={() => void action(onReject, true)}>退回待办</button>}
    {(error || operationError) && <p className="pd-inline-error" role="alert">{error || operationError}</p>}
  </Sheet>;
}

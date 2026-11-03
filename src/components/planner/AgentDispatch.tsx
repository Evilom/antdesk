import { useEffect, useState } from 'react';
import { ArrowRight, LoaderCircle } from 'lucide-react';
import Sheet from './Sheet';
import type { AssistantProfile } from './AgentProfileEditor';
import type { TaskView } from './uiTypes';
import { isNativeProfile, isPersonalAssistant, isProfileConfigured, PROTOCOLS } from '../../lib/assistant-profiles.mjs';
import type { ProbeResult } from '../../lib/agentHub';

export interface DispatchDraft { taskId: string; profileId: string; instruction: string; parentRunId?: string }
export default function AgentDispatch({ profiles, connectionCheck, tasks, taskId, previous, onStart, onClose, onConfigure }: {
  profiles: AssistantProfile[]; tasks: TaskView[]; taskId?: string; previous?: { id: string; agentName: string; result: string };
  onStart: (draft: DispatchDraft) => Promise<void>; onClose: () => void; onConfigure: () => void;
  connectionCheck: (profile: AssistantProfile) => ProbeResult | undefined;
}) {
  const connected = profiles.filter(profile => isPersonalAssistant(profile) && isProfileConfigured(profile) && connectionCheck(profile)?.ok);
  const [selectedTask, setSelectedTask] = useState(taskId || tasks.find(task => !['done', 'archived'].includes(task.stage))?.id || '');
  const [profileId, setProfileId] = useState(connected[0]?.id || '');
  const [instruction, setInstruction] = useState(previous ? '请复核上一位助理的执行结果，重点补齐遗漏项并附上验证结果。' : '请围绕该事项的验收标准推进，完成后附上明确结果；如有阻塞请说明。');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const connectedIds = connected.map(profile => profile.id).join('|');
  useEffect(() => { if (!connected.some(profile => profile.id === profileId)) setProfileId(connected[0]?.id || ''); }, [connectedIds, profileId]);
  const start = async () => {
    if (!selectedTask || !profileId || !instruction.trim()) { setError('请选择事项、助理并填写任务说明。'); return; }
    setBusy(true); setError('');
    try { await onStart({ taskId: selectedTask, profileId, instruction: instruction.trim(), parentRunId: previous?.id }); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <Sheet title={previous ? '转交助理' : '派发任务'} onClose={busy ? () => {} : onClose} actions={<>
    <button className="pd-secondary" onClick={onClose} disabled={busy}>取消</button><button className="pd-primary" disabled={busy || !connected.length || !selectedTask} onClick={() => void start()}>{busy ? <LoaderCircle size={14} className="pd-busy"/> : <ArrowRight size={14}/>}派发</button>
  </>}>
    {!connected.length ? <div className="pd-empty"><h2>暂无就绪助理</h2><p>请先连接 Muse AI、Grok Bot 或 GPT · omdot。</p><button className="pd-primary" onClick={onConfigure}>连接助理</button></div> : <>
      <label htmlFor="dispatch-task">选择待办</label><select id="dispatch-task" value={selectedTask} disabled={Boolean(previous)} onChange={e => setSelectedTask(e.target.value)}>{!selectedTask && <option value="">选择事项…</option>}{tasks.filter(task => task.stage !== 'archived' || task.id === selectedTask).map(task => <option key={task.id} value={task.id}>{task.title}</option>)}</select>
      <label htmlFor="dispatch-agent">助理</label><select id="dispatch-agent" data-dialog-autofocus value={profileId} onChange={e => setProfileId(e.target.value)}>{connected.map(profile => <option key={profile.id} value={profile.id}>{profile.name} · {PROTOCOLS[profile.protocol].detail}</option>)}</select>
      <label htmlFor="dispatch-instruction">任务要求与说明</label><textarea id="dispatch-instruction" rows={5} value={instruction} maxLength={20000} placeholder="输入具体推进要求、注意事项或补充背景…" onChange={e => setInstruction(e.target.value)}/>
      {previous && <div className="pd-connection-hint" style={{marginTop: 13}}>将自动附带 {previous.agentName} 的上一步执行结果。</div>}
    </>}
    {error && <p className="pd-inline-error" role="alert">{error}</p>}
  </Sheet>;
}

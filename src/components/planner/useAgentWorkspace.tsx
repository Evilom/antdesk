import { useCallback, useEffect, useRef, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import { cancelRun, listRuns, probeAgent, reviewRun, setAgentCredential, setBridgeCredential, startRun, subscribeRuns, syncRun, type AgentRun, type ProbeResult } from '../../lib/agentHub';
import { useAppStore } from '../../stores/appStore';
import { usePlannerStore } from '../../stores/plannerStore';
import { buildPlan } from '../../lib/planner-model.mjs';
import { taskTransitionIssue } from '../../lib/pmo-model.mjs';
import AgentProfileEditor, { type AssistantProfile, type ConnectionCredentials } from './AgentProfileEditor';
import AgentDispatch, { type DispatchDraft } from './AgentDispatch';
import RunResult, { type RunView } from './RunResult';
import type { TaskView } from './uiTypes';
import { normalizeProfiles, personalAssistantProfiles, validateProfile, connectionKey, credentialScopeKey, isNativeProfile, isActiveRun, isRuntimeProfile, isProfileConfigured } from '../../lib/assistant-profiles.mjs';
import { configureRuntime, listRuntimeProviders, respondRuntimeRun, type RuntimeProvider, type RuntimeResponse } from '../../lib/assistantRuntime';

const PROFILE_KEY = 'antdesk_assistant_profiles_v1';
type Modal = { kind: 'profile'; profile: AssistantProfile } | { kind: 'dispatch'; taskId?: string; parentRunId?: string; key: string } | { kind: 'result'; id: string } | null;
function loadProfiles(): AssistantProfile[] {
  let saved: unknown = null;
  try { saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null'); }
  catch { /* Corrupt settings do not block local planning. */ }
  return normalizeProfiles(saved, useAppStore.getState().settings);
}
function effectiveHandoff(child: AgentRun, parentId: string) {
  return child.parentRunId === parentId && (isActiveRun(child) || child.status === 'review' && Boolean(child.result.trim()) && child.reviewDecision !== 'rejected');
}
function runView(run: AgentRun, runs: AgentRun[]): RunView {
  return { ...run, taskTitle: run.title, reviewed: Boolean(run.reviewedAt || run.reviewDecision), handedOff: runs.some(child => effectiveHandoff(child, run.id)) };
}

export function useAgentWorkspace(tasks: TaskView[], completePersisted: (id: string) => Promise<void>) {
  const [profiles, setProfiles] = useState(loadProfiles);
  const personalProfiles = personalAssistantProfiles(profiles);
  const profilesRef = useRef(profiles);
  profilesRef.current = profiles;
  const [rawRuns, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const [connectionChecks, setConnectionChecks] = useState<Record<string, ProbeResult & { key: string }>>({});
  const [syncing, setSyncing] = useState<string[]>([]);
  const [providers, setProviders] = useState<RuntimeProvider[]>([]);
  const [runtimeError, setRuntimeError] = useState('');
  const [runtimeLoading, setRuntimeLoading] = useState(isTauri());
  const providerRefresh = useRef<Promise<void> | null>(null);
  const mounted = useRef(true);
  const refreshing = useRef<Promise<void> | null>(null);
  const pendingRefresh = useRef(false);
  const mutationEpoch = useRef(0);
  const submissions = useRef(new Map<string, string>());
  const answeredAttention = useRef(new Set<string>());
  const withoutAnsweredAttention = (run: AgentRun): AgentRun => run.attention && answeredAttention.current.has(run.id + ':' + run.attention.id) ? { ...run, attention: undefined } : run;
  const refreshProviders = useCallback(() => {
    if (!isTauri()) return Promise.resolve();
    if (providerRefresh.current) return providerRefresh.current;
    const operation = (async () => {
      try {
        const value = await listRuntimeProviders();
        if (mounted.current) { setProviders(value); setRuntimeError(''); }
        if (value.some(provider => provider.id === 'dots-direct' && provider.readiness === 'ready')) {
          const selected = personalAssistantProfiles(profilesRef.current).filter(profile => profile.protocol === 'dots-direct' && isProfileConfigured(profile));
          const checks = await Promise.all(selected.map(async profile => {
            const result = await probeAgent(profile).catch(() => ({ok: false, readiness: 'unavailable' as const, message: '暂时无法确认原 Dot 的连接，请刷新重试。'}));
            return {profile, result};
          }));
          if (mounted.current) setConnectionChecks(current => {
            const next = {...current};
            for (const {profile, result} of checks) next[profile.id] = {...result, key: connectionKey(profile)};
            return next;
          });
        }
      }
      catch (cause) { if (mounted.current) { setProviders([]); setRuntimeError(String(cause)); } }
      finally { if (mounted.current) setRuntimeLoading(false); }
    })();
    providerRefresh.current = operation;
    void operation.finally(() => { if (providerRefresh.current === operation) providerRefresh.current = null; });
    return operation;
  }, []);
  useEffect(() => {
    void refreshProviders();
    const timer = setInterval(() => void refreshProviders(), 20000);
    return () => clearInterval(timer);
  }, [refreshProviders]);
  const refresh = useCallback(() => {
    if (refreshing.current) { pendingRefresh.current = true; return refreshing.current; }
    const epoch = mutationEpoch.current;
    const request = (async () => {
      try {
        const value = await listRuns();
        if (mounted.current && epoch === mutationEpoch.current && !pendingRefresh.current) {setRuns(value.map(withoutAnsweredAttention).sort((a, b) => b.createdAt - a.createdAt)); setError('');}
      } catch (cause) { if (mounted.current && epoch === mutationEpoch.current) setError(String(cause)); }
      finally { if (mounted.current) setLoading(false); }
    })();
    refreshing.current = request;
    void request.finally(() => {
      if (refreshing.current === request) refreshing.current = null;
      if (pendingRefresh.current && mounted.current) { pendingRefresh.current = false; void refresh(); }
    });
    return request;
  }, []);
  useEffect(() => {
    mounted.current = true;
    let disposed = false;
    let off: (() => void) | undefined;
    void refresh();
    void subscribeRuns(() => void refresh()).then(fn => disposed ? fn() : off = fn).catch(cause => { if (!disposed) setError(String(cause)); });
    const interval = setInterval(() => void refresh(), 8000);
    return () => { disposed = true; mounted.current = false; off?.(); clearInterval(interval); };
  }, [refresh]);
  const applyRun = (run: AgentRun) => {
    mutationEpoch.current++;
    setRuns(current => [withoutAnsweredAttention(run), ...current.filter(item => item.id !== run.id)].sort((a, b) => b.createdAt - a.createdAt));
    void refresh();
  };
  const clearCredentials = async (id: string) => {
    await setAgentCredential(id, '');
    await setBridgeCredential(id, '');
    setConnectionChecks(current => { const next = { ...current }; delete next[id]; return next; });
  };
  const saveProfile = async (input: AssistantProfile, credentials: ConnectionCredentials, checked?: ProbeResult | null) => {
    const profile = validateProfile(input);
    const previous = profiles.find(item => item.id === profile.id);
    if (!isTauri() && (credentials.primary.trim() || credentials.bridge.trim())) throw new Error('会话密钥需要在 AntDesk 桌面版保存。');
    if (previous && credentialScopeKey(previous) !== credentialScopeKey(profile) && isTauri()) await clearCredentials(profile.id);
    const next = profiles.some(item => item.id === profile.id) ? profiles.map(item => item.id === profile.id ? profile : item) : [...profiles, profile];
    if (isTauri() && profile.protocol === 'notion-web') {
      await configureRuntime('notion-web', {model: profile.model || ''});
      await refreshProviders();
    }
    localStorage.setItem(PROFILE_KEY, JSON.stringify(next));
    setProfiles(next);
    try {
      if (credentials.primary.trim()) await setAgentCredential(profile.id, credentials.primary.trim());
      if (credentials.bridge.trim()) await setBridgeCredential(profile.id, credentials.bridge.trim(), profile.endpoint);
    } catch {
      setConnectionChecks(current => { const result = { ...current }; delete result[profile.id]; return result; });
      throw new Error('连接配置已保存，会话密钥尚未保存，请重新填写后重试。');
    }
    setConnectionChecks(current => {
      const result = { ...current };
      if (checked) result[profile.id] = { ...checked, key: connectionKey(profile) };
      else delete result[profile.id];
      return result;
    });
  };
  const probe = async (profile: AssistantProfile, credentials: ConnectionCredentials) => {
    if (profile.protocol === 'dots-direct' && isProfileConfigured(profile)) {
      const result = await probeAgent(profile);
      setConnectionChecks(current => ({...current, [profile.id]: {...result, key: connectionKey(profile)}}));
      return result;
    }
    if (isRuntimeProfile(profile)) {
      const latest = await listRuntimeProviders();
      setProviders(latest);
      const provider = latest.find(item => item.id === profile.protocol);
      if (!provider) return { ok: false, readiness: 'unavailable' as const, message: '连接服务尚未提供这位助理。' };
      if (provider.readiness === 'ready' && !isProfileConfigured(profile)) return { ok: false, readiness: 'needs_agent_connection' as const, message: '登录后选择要使用的原 Bot。' };
      return { ok: provider.readiness === 'ready', readiness: provider.readiness, message: provider.message, official: provider.official };
    }
    const original = profiles.find(item => item.id === profile.id);
    const unchanged = Boolean(original && credentialScopeKey(original) === credentialScopeKey(profile));
    const result = await probeAgent({ ...profile, agentRef: profile.agentRef || profile.id }, {
      apiKey: credentials.primary.trim() || undefined,
      bridgeApiKey: credentials.bridge.trim() || undefined,
      useStoredCredentials: unchanged,
    });
    if (unchanged) setConnectionChecks(current => ({ ...current, [profile.id]: { ...result, key: connectionKey(profile) } }));
    return result;
  };
  const dispatch = (taskId?: string, parentRunId?: string) => { submissions.current.clear(); setModal({kind: 'dispatch', taskId, parentRunId, key: crypto.randomUUID()}); };
  const start = async (draft: DispatchDraft) => {
    const task = tasks.find(item => item.id === draft.taskId);
    const profile = personalProfiles.find(item => item.id === draft.profileId);
    if (!task || !profile || modal?.kind !== 'dispatch') throw new Error('事项或助理已变化，请重新选择。');
    const plannerPayload = usePlannerStore.getState().payload;
    const source = useAppStore.getState();
    const currentPlan = buildPlan(source.todos, source.projects, plannerPayload);
    const managedTask = currentPlan.all.find(item => item.id === task.id);
    const issue = taskTransitionIssue(plannerPayload.pmo, managedTask, 'doing', currentPlan.all);
    if (issue) throw new Error(issue);
    if (profile.protocol === 'muse-manual') throw new Error('Muse 尚未配置可用的任务入口。');
    if (isRuntimeProfile(profile)) {
      const readiness = await probe(profile, { primary: '', bridge: '' });
      if (!readiness.ok) throw new Error(readiness.message || '这位助理尚未就绪，请先完成连接。');
    }
    const freshPayload = usePlannerStore.getState().payload;
    const freshSource = useAppStore.getState();
    const freshPlan = buildPlan(freshSource.todos, freshSource.projects, freshPayload);
    const freshTask = freshPlan.all.find(item => item.id === task.id);
    const freshIssue = taskTransitionIssue(freshPayload.pmo, freshTask, 'doing', freshPlan.all);
    if (freshIssue) throw new Error(freshIssue);
    if (freshPayload.pmo.enabled && !freshPlan.dailyFocus.some(item => item.id === task.id)) {
      throw new Error('这件事尚未进入今日聚焦。先调整同级事项顺序或今日容量，再交给助理执行。');
    }
    if (JSON.stringify(freshPayload) !== JSON.stringify(plannerPayload) || JSON.stringify(freshTask) !== JSON.stringify(managedTask)) {
      throw new Error('检查助理连接期间事项或项目约束已更新，请重新打开派发确认最新范围。');
    }
    if (rawRuns.some(run => run.taskId === task.id && isActiveRun(run))) throw new Error('这件事已有助理正在跟进，请先同步结果或停止等待。');
    const previous = rawRuns.find(run => run.id === draft.parentRunId);
    const context = [
      plannerPayload.pmo?.enabled && '执行原则：围绕该事项的验收标准推进，完成后附上明确结果；如有阻塞请说明原因并提供具体建议。',
      task.description && `事项说明：\n${task.description}`,
      managedTask?.acceptanceCriteria && `验收标准 (DoD)：\n${managedTask.acceptanceCriteria}`,
      managedTask?.owner && `负责人：${managedTask.owner}`,
      managedTask?.verification === 'needs_check' && '注意：现状待核实，请先基于最新事实进行确认。',
      managedTask?.evidence && `已有证据：\n${managedTask.evidence}`,
      managedTask?.sourceRefs?.length && `核对来源：\n${managedTask.sourceRefs.join('\n')}`,
      task.dueDate && `截止日期：${task.dueDate}`,
      `预计用时：${task.estimateMinutes} 分钟`,
      task.dependencies.length && `前置事项：${task.dependencies.map(id => tasks.find(item => item.id === id)?.title || '暂不可用').join('；')}`,
      previous?.result && `上一位助理 ${previous.agentName} 的返回内容（供你复核和继续工作）：\n${previous.result}`,
      previous && !previous.result && previous.messages?.length && `上一位助理 ${previous.agentName} 的会话记录（尚未完成）：\n${previous.messages.map(message => `${message.role}: ${message.text}`).join('\n\n').slice(-30000)}`,
      previous && !previous.result && previous.progress && `上一步进度：${previous.progress}`,
    ].filter(Boolean).join('\n\n');
    const request = {
      taskId: task.id, title: task.title, instruction: draft.instruction,
      profile: {id: profile.id, name: profile.name, endpoint: profile.endpoint, model: profile.model, protocol: profile.protocol, agentRef: ['muse-personal', 'notion-web'].includes(profile.protocol) ? profile.protocol : profile.agentRef || profile.id, webhookUrl: profile.webhookUrl, sessionId: ['muse-personal', 'notion-web'].includes(profile.protocol) ? undefined : profile.sessionId},
      context, parentRunId: draft.parentRunId,
    } as const;
    const signature = JSON.stringify(request);
    if (!submissions.current.has(signature)) submissions.current.set(signature, submissions.current.size ? crypto.randomUUID() : modal.key);
    const result = await startRun({ ...request, idempotencyKey: submissions.current.get(signature)! });
    applyRun(result);
  };
  const cancel = async (id: string) => {
    try { const value = await cancelRun(id); applyRun(value); setError(''); }
    catch (cause) { setError(String(cause)); }
  };
  const sync = async (id: string) => {
    if (syncing.includes(id)) return;
    setSyncing(current => [...current, id]);
    try { applyRun(await syncRun(id)); setError(''); }
    catch (cause) { setError(String(cause)); }
    finally { setSyncing(current => current.filter(value => value !== id)); }
  };
  const respond = async (run: AgentRun, response: RuntimeResponse) => {
    if (!isRuntimeProfile(run) || !run.attention || run.attention.id !== response.attentionId) throw new Error('这条请求的状态已变化，请刷新后重试。');
    if (answeredAttention.current.has(run.id + ':' + response.attentionId)) throw new Error('这条回复已经发送，请同步进度。');
    await respondRuntimeRun(run.externalRunId || run.id, response);
    answeredAttention.current.add(run.id + ':' + response.attentionId);
    mutationEpoch.current++;
    setRuns(current => current.map(withoutAnsweredAttention));
    try { applyRun(await syncRun(run.id)); }
    catch { setError('回复已发送，暂时无法同步最新进度。请点击同步，不必重复回复。'); }
  };
  const connectionCheck = (profile: AssistantProfile): ProbeResult | undefined => {
    if (isRuntimeProfile(profile)) {
      const provider = providers.find(item => item.id === profile.protocol);
      if (!provider) return undefined;
      if (provider.readiness === 'ready' && !isProfileConfigured(profile)) return { ok: false, readiness: 'needs_agent_connection', message: '登录已完成，选择你的原 Bot。', official: provider.official };
      if (profile.protocol === 'dots-direct' && provider.readiness === 'ready') {
        return connectionChecks[profile.id]?.key === connectionKey(profile) ? connectionChecks[profile.id] : {ok: false, readiness: 'needs_validation', message: '正在确认所选原 Dot 的消息会话。', official: false};
      }
      return { ok: provider.readiness === 'ready', readiness: provider.readiness, message: provider.message, official: provider.official };
    }
    return connectionChecks[profile.id]?.key === connectionKey(profile) ? connectionChecks[profile.id] : undefined;
  };
  const selectedRun = modal?.kind === 'result' ? rawRuns.find(run => run.id === modal.id) : undefined;
  const selectedPersonalProfile = personalProfiles.find(profile => profile.id === selectedRun?.agentId);
  const selectedTask = tasks.find(task => task.id === selectedRun?.taskId);
  const activeForTask = selectedRun && rawRuns.some(run => run.taskId === selectedRun.taskId && isActiveRun(run));
  const handedOff = selectedRun && rawRuns.some(run => effectiveHandoff(run, selectedRun.id));
  const pendingReview = selectedRun?.status === 'review' && !selectedRun.reviewDecision && !selectedRun.reviewedAt;
  const canDecide = Boolean(pendingReview && selectedTask && selectedTask.stage !== 'archived' && !activeForTask && !handedOff);
  const canContinue = Boolean(selectedTask && !['done', 'archived'].includes(selectedTask.stage) && !activeForTask);
  const reviewSelected = async (decision: 'accepted' | 'rejected') => {
    if (!selectedRun || !canDecide) throw new Error('这份结果已处理或有后续运行，请刷新执行记录后再复核。');
    // Verify the durable state again before changing the user's plan.
    const latest = await listRuns();
    const actual = latest.find(run => run.id === selectedRun.id);
    if (!actual || actual.status !== 'review' || actual.reviewDecision || actual.reviewedAt || latest.some(run => run.taskId === actual.taskId && (isActiveRun(run) || effectiveHandoff(run, actual.id)))) {
      void refresh(); throw new Error('这份结果的状态已变化，请刷新后再复核。');
    }
    if (decision === 'accepted' && selectedTask?.stage !== 'done') {
      const planner = usePlannerStore.getState();
      if (planner.payload.pmo.enabled) {
        const source = useAppStore.getState();
        const task = buildPlan(source.todos, source.projects, planner.payload).all.find(item => item.id === actual.taskId);
        const previousEvidence = task?.evidence?.trim() || '';
        const result = actual.result?.trim() || '';
        if (!previousEvidence && !result) throw new Error('这份结果没有交付正文，请先在事项中补充可核对的验收证据。');
        if (result && !previousEvidence.includes(`助理结果 ${actual.id}`)) {
          const entry = `用户已核对并采纳 · 助理结果 ${actual.id}\n${result.slice(0, 2200)}${result.length > 2200 ? '\n（以上为摘要，完整正文保留在该助理运行记录中。）' : ''}`;
          const evidence = [previousEvidence, entry].filter(Boolean).join('\n\n');
          if (evidence.length > 6000) throw new Error('现有验收证据较长，请先在事项中整理证据并引用这份助理结果，再采纳完成。');
          planner.updateTask(actual.taskId, { evidence });
        }
      }
      await completePersisted(actual.taskId);
    }
    try { applyRun(await reviewRun(actual.id, decision)); }
    catch (cause) { if (decision === 'accepted') throw new Error('事项已完成并保存，复核记录尚未保存。请再点一次采纳以重试。'); throw cause; }
  };
  const previous = modal?.kind === 'dispatch' ? rawRuns.find(run => run.id === modal.parentRunId) : undefined;
  const close = () => setModal(null);
  const dialogs = modal?.kind === 'profile' ? <AgentProfileEditor key={modal.profile.id} profile={modal.profile} onSave={saveProfile} onProbe={probe} onClearCredential={() => clearCredentials(modal.profile.id)} onClose={close} onRuntimeUpdated={refreshProviders}/>
    : modal?.kind === 'dispatch' ? <AgentDispatch key={modal.key} profiles={personalProfiles} connectionCheck={connectionCheck} tasks={tasks} taskId={modal.taskId} previous={previous ? {id: previous.id, agentName: previous.agentName, result: previous.result} : undefined} onStart={start} onClose={close} onConfigure={() => setModal({kind: 'profile', profile: personalProfiles.find(item => !connectionCheck(item)?.ok) || personalProfiles[0]})}/>
    : selectedRun ? <RunResult key={selectedRun.id} run={runView(selectedRun, rawRuns)} canDecide={canDecide} canContinue={canContinue} operationError={error} onSync={(selectedRun.externalRunId || selectedRun.sessionId) && isNativeProfile(selectedRun) && isActiveRun(selectedRun) ? () => sync(selectedRun.id) : undefined} onStop={isActiveRun(selectedRun) ? () => cancel(selectedRun.id) : undefined} onRespond={isRuntimeProfile(selectedRun) ? response => respond(selectedRun, response) : undefined} onLogin={selectedRun.attention?.kind === 'login' && selectedPersonalProfile ? () => setModal({ kind: 'profile', profile: selectedPersonalProfile }) : undefined} onClose={close} onHandoff={() => dispatch(selectedRun.taskId, selectedRun.id)} onRetry={() => dispatch(selectedRun.taskId)} onAccept={() => reviewSelected('accepted')} onReject={() => reviewSelected('rejected')}/>
    : null;
  return {
    profiles: personalProfiles, runs: rawRuns.filter(run => !run.taskId.startsWith('chat:')).map(run => runView(run, rawRuns)), loading, error, modal, dialogs, refresh, cancel, dispatch, sync, syncing,
    providers, runtimeLoading, runtimeError, refreshProviders, connectionCheck,
    configure: (id: string) => { const profile = personalProfiles.find(item => item.id === id); if (profile) setModal({kind: 'profile', profile}); },
    showResult: (id: string) => { setError(''); setModal({kind: 'result', id}); },
  };
}

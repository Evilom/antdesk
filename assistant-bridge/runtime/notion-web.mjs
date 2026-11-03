import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BridgeError, hash } from '../lib/util.mjs';
import { StdioRpc, isolatedRuntimeEnv } from './stdio-rpc.mjs';

export const NOTION_UPSTREAM_COMMIT = 'cc7fcf4dc78af245f4ce961c5951384c7b78b005';
const ID = 'notion-web';
const clip = (value, max = 262144) => typeof value === 'string' ? value.slice(0, max) : '';
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const safeModel = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value);
const issue = (code, message) => new BridgeError(409, code, message);
const MESSAGES = Object.freeze({
  auth_required: 'Notion 网页登录已过期，请重新登录后再同步原事项。',
  account_ambiguous: '专用窗口存在多个 Notion 身份，请在官方页面明确选择本次账号。',
  account_mismatch: '当前 Notion 账号与这件事项的账号不同，请连接原账号后同步。',
  workspace_unavailable: '请选择你要使用的 Notion 工作区。',
  workspace_mismatch: '当前登录无法访问原工作区，请重新检查连接。',
  access_denied: 'Notion 拒绝了当前请求。请在官方窗口完成验证并检查 AI 权限。',
  credits_exhausted: '当前工作区的 Notion AI 额度不足，请在官方应用查看用量。',
  rate_limited: 'Notion 暂时限制请求频率，请稍后同步原事项；不会自动重发。',
  service_unavailable: 'Notion 服务暂不可用，请稍后同步原事项；不会自动重发。',
  network_timeout: 'Notion 请求超时，送达或完成状态尚未确认；可同步原事项。',
  network_error: '连接 Notion 的网络暂不可用，请稍后重新检查。',
  invalid_response: 'Notion 返回的数据无法识别，当前结果尚未确认。',
  runtime_unavailable: 'Notion 网页连接组件尚未安装或无法启动。',
  runtime_version_mismatch: 'Notion 网页连接组件与已验证版本不一致，请修复安装。',
  model_unavailable: '当前账号未确认支持所选模型，请重新读取可用模型或选择 Auto。',
  approval_required: 'Notion 正在等待操作确认。请在官方会话核对，AntDesk 不会代你批准。',
  incomplete_response: 'Notion 回复尚未完整结束，已保留原线程，可以继续同步。',
  ambiguous_response: '原 Notion 线程的消息归属无法确认，请在官方会话核对；不会重复派发。',
  thread_missing: '未找到这次派发的 Notion 线程；没有重发请求。',
  already_sent: '这件事项已经尝试发送，只能同步原线程。',
  cancelled: '已停止本地等待；Notion 远端可能仍在运行。',
  request_too_large: '本次材料超过连接组件的长度限制，请缩小评审范围后重新发起。',
});
const failureCode = error => error?.code === 'RPC_TIMEOUT' ? 'network_timeout'
  : error?.code === 'ABORT_ERR' ? 'cancelled'
  : Object.hasOwn(MESSAGES, error?.data?.code) ? error.data.code
  : Object.hasOwn(MESSAGES, error?.code) ? error.code : 'invalid_response';
const publicError = error => MESSAGES[failureCode(error)];
const selectModels = rows => (Array.isArray(rows) ? rows : []).filter(m => safeModel(m?.id)).slice(0, 100).map(m => ({ id: m.id, name: clip(m.name, 160) || m.id }));

/** One selected Notion web account. No account pool, API-credit fallback or admin service. */
export function createNotionWebAdapter(options) {
  const { projectRoot, dataDir, toolsDir, getSecret, setSecret } = options;
  const getConfig = options.getConfig || (() => ({}));
  const setConfig = options.setConfig || (() => {});
  const runtimeDir = path.join(toolsDir, 'notion2api');
  const source = path.join(runtimeDir, 'source');
  const python = path.join(runtimeDir, 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'notion_worker.py');
  const home = path.join(dataDir, 'worker-home');
  const makeTransport = options.transportFactory || (settings => new StdioRpc(settings));
  const installed = () => Boolean(options.transportFactory) || fs.existsSync(python) && fs.existsSync(path.join(source, 'app', 'notion_client.py'));
  const active = new Map(), workers = new Set(), cancelled = new Set();
  let closed = false, epoch = 0, checking = null, checkingWorkspace = '', browserPromise, browser;
  let verifiedCandidate = null;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });

  function normalizeIdentity(result) {
    if (!result?.initialized || result.sdkVersion !== NOTION_UPSTREAM_COMMIT || !validId(result.account?.id))
      throw issue('runtime_version_mismatch', MESSAGES.runtime_version_mismatch);
    const workspaces = (Array.isArray(result.workspaces) ? result.workspaces : []).filter(w => validId(w?.id)).slice(0, 100)
      .map(w => ({ id: w.id, name: clip(w.name, 160) || 'Notion 工作区', ...(typeof w.aiAvailable === 'boolean' ? { aiAvailable: w.aiAvailable } : {}) }));
    if (!workspaces.length) throw issue('workspace_unavailable', MESSAGES.workspace_unavailable);
    const workspaceId = workspaces.some(w => w.id === result.workspaceId) ? result.workspaceId : '';
    return { account: { id: result.account.id, name: clip(result.account.name, 160) || '我的 Notion' }, workspaces, workspaceId,
      models: selectModels(result.models), modelsSource: ['account', 'catalog'].includes(result.modelsSource) ? result.modelsSource : 'unavailable' };
  }
  function failAuth(error, cookies, generation) {
    if (!closed && generation === epoch && getSecret('cookies') === cookies && failureCode(error) === 'auth_required')
      setConfig({ authState: 'expired', aiVerified: false, lastIssue: 'auth_required' });
  }
  async function dispose(context) {
    context.closing = true;
    if (context.rpc && !context.rpc.closed) {
      try { await context.rpc.call('shutdown', {}, { timeoutMs: 500 }); } catch {}
      await context.rpc.close();
    }
    workers.delete(context);
    if (context.run && active.get(context.run.id) === context) active.delete(context.run.id);
  }
  async function connect(context, { cookies, workspaceId } = {}) {
    if (closed) throw issue('runtime_unavailable', 'Notion 连接已关闭，请重新打开 AntDesk。');
    if (!installed()) throw issue('runtime_unavailable', MESSAGES.runtime_unavailable);
    context.cookies = cookies ?? getSecret('cookies'); context.epoch = epoch;
    if (!context.cookies) throw issue('auth_required', MESSAGES.auth_required);
    if (context.signal?.aborted) throw issue('cancelled', MESSAGES.cancelled);
    const env = isolatedRuntimeEnv(home, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' });
    for (const name of Object.keys(env)) if (/^(?:NOTION_|AGENT_SERVICE_|API_KEY$|SILICONFLOW_API_KEY$)/i.test(name)) delete env[name];
    const rpc = makeTransport({ command: python, args: ['-I', '-X', 'utf8', '-u', script], cwd: projectRoot, env,
      requestTimeoutMs: 90000, maxFrameBytes: 4 * 1024 * 1024 });
    context.rpc = rpc; workers.add(context);
    await rpc.open();
    const identity = normalizeIdentity(await rpc.call('initialize', { source, cookies: context.cookies,
      workspaceId: workspaceId ?? getConfig().workspaceId ?? '' }, { timeoutMs: 90000, signal: context.signal }));
    if (closed || context.closing || context.signal?.aborted || context.epoch !== epoch) throw issue('cancelled', MESSAGES.cancelled);
    context.identity = identity;
    return rpc;
  }
  async function withWorker(fn, overrides = {}, signal) {
    const context = { signal };
    try { await connect(context, overrides); return await fn(context); }
    catch (error) { if (overrides.cookies === undefined) failAuth(error, context.cookies, context.epoch); throw error; }
    finally { await dispose(context); }
  }
  function saveIdentity(identity, cookies) {
    const cfg = getConfig();
    const same = cfg.account?.id === identity.account.id && cfg.workspaceId === identity.workspaceId && cfg.credentialFingerprint === hash(cookies);
    const model = same && safeModel(cfg.model) ? cfg.model : 'auto';
    setConfig({ ...identity, authState: 'ready', credentialFingerprint: hash(cookies), lastVerifiedAt: Date.now(), lastIssue: '',
      model, aiVerified: same && cfg.aiVerified === true, aiVerifiedModel: same ? cfg.aiVerifiedModel || '' : '' });
  }
  async function refresh(workspaceId) {
    if (checking) {
      if (workspaceId !== checkingWorkspace) throw issue('invalid_response', '工作区核验尚未结束，请稍后再切换。');
      return checking;
    }
    checkingWorkspace = workspaceId;
    const cookies = getSecret('cookies'), generation = epoch;
    checking = withWorker(context => {
      if (generation !== epoch || cookies !== getSecret('cookies')) throw issue('cancelled', MESSAGES.cancelled);
      saveIdentity(context.identity, cookies);
      return context.identity;
    }, { workspaceId }).catch(error => {
      if (generation === epoch && cookies === getSecret('cookies')) setConfig({ lastIssue: failureCode(error) });
      throw issue(failureCode(error), publicError(error));
    }).finally(() => { checking = null; });
    return checking;
  }
  async function status() {
    const cfg = getConfig(), cookies = getSecret('cookies');
    const bound = Boolean(cookies && cfg.authState === 'ready' && validId(cfg.account?.id) && cfg.credentialFingerprint === hash(cookies));
    const selected = bound && validId(cfg.workspaceId) && cfg.workspaces?.some(w => w.id === cfg.workspaceId);
    const ready = selected && !['auth_required', 'access_denied', 'credits_exhausted', 'model_unavailable'].includes(cfg.lastIssue);
    const lastIssue = Object.hasOwn(MESSAGES, cfg.lastIssue) ? cfg.lastIssue : '';
    return { id: ID, protocol: ID, name: 'Notion AI', official: false, installed: installed(),
      version: installed() ? `notion2api ${NOTION_UPSTREAM_COMMIT.slice(0, 8)}` : undefined,
      readiness: closed ? 'unavailable' : !installed() ? 'needs_install' : checking ? 'connecting' : !bound ? 'needs_login' : !selected ? 'needs_configuration' : ready ? 'ready' : 'unavailable',
      message: closed ? 'Notion 连接已关闭。' : !installed() ? MESSAGES.runtime_unavailable : checking ? '正在只读核验 Notion 身份与工作区…'
        : !bound ? cfg.authState === 'expired' ? MESSAGES.auth_required : '登录你已有会员的 Notion 账号，使用独立的官方登录窗口。'
        : !selected ? '登录已确认，请选择有 AI 权益的工作区。'
        : lastIssue ? MESSAGES[lastIssue] : cfg.aiVerified ? '已收到这个工作区的真实 AI 回复；评审结果仍由你采纳。'
        : '登录与工作区已核验；会员额度和模型可用性将在首次真实回复时确认。',
      ...(bound ? { account: cfg.account, workspaces: cfg.workspaces || [], workspaceId: cfg.workspaceId || '', models: cfg.models || [],
        modelsSource: cfg.modelsSource || 'unavailable', model: cfg.model || 'auto', aiVerified: cfg.aiVerified === true,
        lastVerifiedAt: cfg.lastVerifiedAt, ...(selected ? { connectionIdentity: hash(JSON.stringify(['notion-web', cfg.account.id, cfg.workspaceId])), agentId: ID } : {}) } : {}),
      ...(lastIssue ? { diagnostic: { stage: 'verification', code: lastIssue, retryable: ['rate_limited', 'service_unavailable', 'network_timeout', 'network_error'].includes(lastIssue) } } : {}),
    };
  }
  async function browserController() {
    if (!browserPromise) browserPromise = (async () => {
      const factory = options.browserLoginFactory || (await import('./notion-browser-login.mjs')).createNotionBrowserLogin;
      browser = factory({ dataDir, toolsDir, getSecret, setSecret,
        verifyCookies: async (cookies, { signal } = {}) => {
          const generation = epoch;
          // A new login may belong to another workspace. Discover first, then
          // preserve a selected workspace only for the same saved account.
          let identity = await withWorker(context => context.identity, { cookies, workspaceId: '' }, signal);
          const cfg = getConfig();
          if (generation !== epoch || signal?.aborted) return { ok: false };
          if (cfg.account?.id === identity.account.id && cfg.workspaceId !== identity.workspaceId
            && identity.workspaces.some(workspace => workspace.id === cfg.workspaceId)) {
            // Re-read models for that workspace rather than borrowing the
            // catalog from an automatically selected workspace or another user.
            identity = await withWorker(context => context.identity, { cookies, workspaceId: cfg.workspaceId }, signal);
          }
          if (generation !== epoch || signal?.aborted) return { ok: false };
          verifiedCandidate = { fingerprint: hash(cookies), identity, epoch: generation };
          return { ok: true };
        } });
      return browser;
    })().catch(error => { browserPromise = undefined; throw error; });
    return browserPromise;
  }
  function prepare(run, current) {
    if (!current?.account || !current.workspaceId) throw issue('workspace_unavailable', MESSAGES.workspace_unavailable);
    const model = run.model || 'auto';
    if (!safeModel(model) || model !== 'auto' && !current.models?.some(m => m.id === model)) throw issue('model_unavailable', MESSAGES.model_unavailable);
    return { accountId: current.account.id, workspaceId: current.workspaceId, model, threadId: randomUUID(), clientMessageId: randomUUID(), phase: 'prepared' };
  }
  function contextFor(run, emit) {
    if (active.has(run.id)) return null;
    const context = { run, emit, accepted: run.deliveryStatus === 'accepted', cancelled: cancelled.has(run.id), signal: new AbortController().signal };
    active.set(run.id, context);
    return context;
  }
  async function runWorker(run, emit, recover) {
    const data = run.runtimeData || {};
    if (!validId(data.threadId) || !validId(data.accountId) || !validId(data.workspaceId) || !validId(data.clientMessageId)) {
      emit({ type: 'interrupted', message: '缺少本次 Notion 派发的身份或线程记录；没有创建新线程。', deliveryStatus: 'unknown' }); return;
    }
    if (!recover && data.sendIntent || recover && !data.sendIntent) {
      emit({ type: 'interrupted', message: MESSAGES.already_sent, deliveryStatus: run.deliveryStatus === 'accepted' ? 'accepted' : 'unknown' }); return;
    }
    const context = contextFor(run, emit); if (!context) return;
    try {
      if (context.cancelled) return;
      const cfg = getConfig();
      if (cfg.account?.id !== data.accountId || !recover && cfg.workspaceId !== data.workspaceId) throw issue('account_mismatch', MESSAGES.account_mismatch);
      const rpc = await connect(context, { workspaceId: data.workspaceId });
      if (context.cancelled) return;
      if (context.identity.account.id !== data.accountId || context.identity.workspaceId !== data.workspaceId || run.agentId !== ID)
        throw issue('account_mismatch', MESSAGES.account_mismatch);
      rpc.on('notification', (method, event) => {
        if (context.cancelled || context.closing || event?.runId !== run.id || event?.threadId !== data.threadId) return;
        if (method === 'notion/started') { context.accepted = true; emit({ type: 'started', sessionId: data.threadId, turnId: data.clientMessageId }); }
        if (method === 'notion/message' && typeof event.text === 'string') emit({ type: 'message', id: `notion-${data.threadId}`, role: 'assistant', text: clip(event.text, 16384), complete: false });
      });
      const marker = `[AntDesk 事项 ${run.id}]`;
      const text = [marker, '请只分析本次提供的材料并给出建议。不要修改 Notion 页面、数据库或向其他人发送消息。最终决定由用户采纳。',
        run.instruction, run.context ? `本次明确提供的背景资料：\n${run.context}` : ''].filter(Boolean).join('\n\n');
      if (text.length > 200000) throw issue('request_too_large', MESSAGES.request_too_large);
      if (!recover) emit({ type: 'checkpoint', sessionId: data.threadId, turnId: data.clientMessageId, data: { ...data, sendIntent: true, phase: 'sending' } });
      if (context.cancelled) return;
      const result = await rpc.call(recover ? 'chat/recover' : 'chat/send', { runId: run.id, threadId: data.threadId, clientMessageId: data.clientMessageId,
        accountId: data.accountId, workspaceId: data.workspaceId, model: data.model || 'auto', ...(!recover ? { text } : {}) }, { timeoutMs: options.maxWaitMs ?? 310000 });
      if (context.cancelled || closed) return;
      if (result?.completed !== true || result.threadId !== data.threadId || !clip(result.text).trim()) throw issue('incomplete_response', MESSAGES.incomplete_response);
      emit({ type: 'complete', text: clip(result.text), sessionId: data.threadId });
      const current = getConfig();
      if (current.account?.id === data.accountId && current.workspaceId === data.workspaceId && getSecret('cookies') === context.cookies)
        setConfig({ aiVerified: true, aiVerifiedModel: data.model || 'auto', lastIssue: '', lastReplyAt: Date.now() });
    } catch (error) {
      failAuth(error, context.cookies, context.epoch);
      if (!context.cancelled && !closed) {
        const code = failureCode(error);
        if (getConfig().account?.id === data.accountId && getConfig().workspaceId === data.workspaceId) setConfig({ lastIssue: code });
        if (code === 'auth_required' || code === 'approval_required') emit({ type: 'attention', attention: { id: `notion-${code}-${run.id}`,
          kind: code === 'auth_required' ? 'login' : 'approval', title: code === 'auth_required' ? 'Notion 需要重新登录' : 'Notion 需要你确认', description: MESSAGES[code] } });
        emit({ type: 'interrupted', message: publicError(error), deliveryStatus: context.accepted ? 'accepted' : 'unknown' });
      }
    } finally { await dispose(context); }
  }
  async function cancel(run) {
    cancelled.add(run.id);
    const context = active.get(run.id);
    if (context) { context.cancelled = true; await dispose(context); }
    return { remoteStopped: false, message: MESSAGES.cancelled };
  }
  return { id: ID, protocol: ID, status, prepare,
    start: (run, emit) => runWorker(run, emit, false), recover: (run, emit) => runWorker(run, emit, true), cancel,
    async agents() { const result = await status(); return { agents: result.account ? [{ id: ID, name: 'Notion AI', description: result.account.name }] : [] }; },
    async sessions() { return { sessions: [] }; },
    async configure(input = {}) {
      if (closed) throw issue('runtime_unavailable', MESSAGES.runtime_unavailable);
      if (Object.keys(input).some(key => !['workspaceId', 'model', 'action'].includes(key))) throw issue('invalid_response', 'Notion 网页会员连接只接受工作区和模型设置。');
      if (input.action && input.action !== 'refresh') throw issue('invalid_response', '不支持的 Notion 设置操作。');
      const cfg = getConfig();
      if (input.workspaceId !== undefined && (!validId(input.workspaceId) || !cfg.workspaces?.some(w => w.id === input.workspaceId))) throw issue('workspace_unavailable', MESSAGES.workspace_unavailable);
      if (input.workspaceId !== undefined && active.size) throw issue('invalid_response', '当前 Notion 仍有事项在处理，请先完成或停止等待再切换工作区。');
      if (input.workspaceId !== undefined || input.action === 'refresh') await refresh(input.workspaceId ?? cfg.workspaceId ?? '');
      if (input.model !== undefined) {
        const value = input.model || 'auto', current = getConfig();
        if (!safeModel(value) || value !== 'auto' && !current.models?.some(m => m.id === value)) throw issue('model_unavailable', MESSAGES.model_unavailable);
        setConfig({ model: value, aiVerified: current.aiVerified === true && current.aiVerifiedModel === value, ...(current.lastIssue === 'model_unavailable' ? { lastIssue: '' } : {}) });
      }
      return { ok: true, ...await status() };
    },
    async login(action = 'status') {
      if (action === 'logout') {
        epoch++; verifiedCandidate = null;
        for (const context of [...active.values()]) await cancel(context.run);
        setConfig({ authState: 'idle', account: null, workspaces: [], workspaceId: '', models: [], modelsSource: 'unavailable',
          credentialFingerprint: null, aiVerified: false, lastIssue: '', model: 'auto' });
      }
      const result = await (await browserController()).login(action);
      const saved = getSecret('cookies');
      if (result?.state === 'ready' && saved && verifiedCandidate?.epoch === epoch && verifiedCandidate.fingerprint === hash(saved)) {
        saveIdentity(verifiedCandidate.identity, saved);
        verifiedCandidate = null;
      }
      if (result?.state === 'ready' && getConfig().authState === 'expired') return { ...result, state: 'failed', message: MESSAGES.auth_required };
      return result;
    },
    async respond() { throw issue('approval_required', MESSAGES.approval_required); },
    async close() {
      if (closed) return; closed = true; epoch++;
      await Promise.allSettled([...active.values()].map(context => cancel(context.run)));
      await Promise.allSettled([...workers].map(dispose));
      if (browserPromise) { try { await (await browserPromise).close(); } catch {} }
    },
  };
}

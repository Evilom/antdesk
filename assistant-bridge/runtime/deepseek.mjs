import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BridgeError } from '../lib/util.mjs';
import { StdioRpc, isolatedRuntimeEnv } from './stdio-rpc.mjs';
import { deepseekFailure, validateDeepSeekApiKey } from './deepseek-auth.mjs';
import { createDeepSeekAccount } from './deepseek-account.mjs';

const ID = 'deepseek-harness';
const VERSION = '0.2.1rc2';
const clip = (value, limit = 262144) => typeof value === 'string' ? value.slice(0, limit) : '';
const error = (code, message) => new BridgeError(409, code, message);
const successReasons = new Set(['stop', 'completed', 'end_turn', 'endTurn', 'done']);
export const DEEPSEEK_DISABLED_PLUGINS = Object.freeze([
  'persistent-bash', 'persistent-pwsh', 'tool-fs', 'tool-working-directory',
  'plugin-package-inventory-deepseek',
]);

/** Official Python SDK adapter. No direct/compatible chat completion endpoint. */
export function createDeepSeekAdapter(options) {
  const { projectRoot, dataDir, toolsDir, getSecret, setSecret } = options;
  const getConfig = options.getConfig || (() => ({}));
  const setConfig = options.setConfig || (() => {});
  const python = process.platform === 'win32'
    ? path.join(toolsDir, 'deepseek', 'venv', 'Scripts', 'python.exe')
    : path.join(toolsDir, 'deepseek', 'venv', 'bin', 'python');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'deepseek_worker.py');
  const patchPath = path.join(dataDir, 'assistant-safe.patch.json');
  const accountPatchPath = path.join(dataDir, 'account-sdk.patch.json');
  const active = new Map();
  const occupied = new Map();
  const cancelledRuns = new Set();
  const makeTransport = options.transportFactory || (settings => new StdioRpc(settings));
  const validateApiKey = options.apiKeyValidator || validateDeepSeekApiKey;
  let configurationGeneration = 0;
  let closed = false;
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  // The exact SDK 0.2.1rc2 sdk-minimal node IDs are pinned with the runtime.
  // These disable tools, not an OS sandbox; the UI must not claim filesystem isolation.
  const safePatch = [
    ...DEEPSEEK_DISABLED_PLUGINS.map(id => ({ id, disabled: true })),
    { id: 'session-log-deepseek', config: { enabled: false } },
  ];
  fs.writeFileSync(patchPath, JSON.stringify(safePatch, null, 2), { mode: 0o600 });
  // Exact official modules from dsh-v0.2.1-rc.2. Account inference does not
  // require a Web listener: only the separate login Host owns PKCE callbacks.
  fs.writeFileSync(accountPatchPath, JSON.stringify([...safePatch, { insert: [
    { id: 'credentials', name: '@deepseek-ai/dsh-credentials-local' },
    { id: 'authorization', name: '@deepseek-ai/dsh-authorization' },
    { id: 'deepseek-account', name: '@deepseek-ai/dsh-deepseek-account-platform', config: { desktopPlatform: null } },
    { id: 'llm-deepseek-account', name: '@deepseek-ai/dsh-llm-deepseek-account' },
  ] }], null, 2), { mode: 0o600 });
  const account = options.accountController || createDeepSeekAccount({ python, dataDir, ...(options.accountOptions || {}) });

  const installed = () => !!options.transportFactory || fs.existsSync(python);
  const savedSessions = () => getConfig().sessions || {};
  const keyPresent = () => typeof getSecret?.('apiKey') === 'string' && !!getSecret('apiKey').trim();
  const selectedMode = () => ['account', 'api_key'].includes(getConfig().authMode) ? getConfig().authMode : keyPresent() ? 'api_key' : 'account';
  async function status() {
    const exists = installed(), hasKey = keyPresent();
    const mode = selectedMode();
    if (mode === 'account') {
      const current = exists ? await account.status() : { state: 'idle', accountStored: false, models: [], message: '尚未安装官方 DeepSeek Harness SDK 运行时。' };
      const model = getConfig().accountModel || '';
      const modelMissing = current.state === 'ready' && !!model && !current.models.some(row => row.id === model);
      return { id: ID, protocol: ID, name: 'DeepSeek Harness', official: true, installed: exists, version: exists ? VERSION : undefined,
        readiness: !exists ? 'needs_install' : modelMissing || current.code === 'account_models_unavailable' ? 'needs_model'
          : current.state === 'ready' ? 'ready' : current.state === 'pending' ? 'connecting'
            : current.code === 'account_host_unavailable' ? 'unavailable' : current.accountStored ? 'needs_validation' : 'needs_login',
        authentication: { mode, state: current.state, stored: current.accountStored === true, ...(current.code ? { code: current.code } : {}), ...(current.account ? { account: current.account } : {}) },
        models: current.models || [], model, browserOpened: current.browserOpened === true,
        message: modelMissing ? '所选模型不在 DeepSeek 官方账号的可用目录中，请清空模型选择以自动使用官方默认模型。' : current.message };
    }
    const verification = hasKey ? getConfig().apiKeyValidation : undefined;
    return { id: ID, protocol: ID, name: 'DeepSeek Harness', official: true, installed: exists,
      readiness: !exists ? 'needs_install' : !hasKey ? 'needs_api_key' : verification?.state === 'verified' ? 'ready' : verification?.state === 'invalid' ? 'invalid_credentials' : 'needs_validation', version: exists ? VERSION : undefined,
      authentication: { mode, state: hasKey ? verification?.state || 'unverified' : 'missing', ...(verification?.code ? { code: verification.code } : {}) },
      models: verification?.models || [], model: getConfig().model || '',
      message: !exists ? '尚未安装官方 DeepSeek Harness SDK 运行时。' : hasKey
        ? verification?.message || '官方 API 密钥已保存但尚未验证，请重新保存以检查连接。'
        : '请保存 DeepSeek 官方 API 密钥以启用本地 Harness 助理。' };
  }
  function remember(sessionId, patch) {
    const sessions = { ...savedSessions(), [sessionId]: { ...savedSessions()[sessionId], ...patch, id: sessionId, sessionId, updatedAt: Date.now() } };
    const rows = Object.entries(sessions).sort((left, right) => (right[1].updatedAt || 0) - (left[1].updatedAt || 0)).slice(0, 1000);
    setConfig({ sessions: Object.fromEntries(rows) });
  }
  function sessionHome(sessionId) {
    if (!/^antdesk-[a-f0-9-]{36}$/.test(sessionId)) throw error('invalid_session', 'DeepSeek 会话编号不属于本应用。');
    return path.join(dataDir, 'sessions', sessionId);
  }
  function acknowledge(context, payload) {
    if (context.acknowledged || context.finished) return;
    context.acknowledged = true;
    context.messageId = payload.messageId;
    context.emit({ type: 'checkpoint', data: { sessionId: context.sessionId, messageId: payload.messageId, home: context.home, cwd: context.cwd } });
    context.emit({ type: 'started', sessionId: context.sessionId });
  }
  function receive(context, method, params) {
    if (context.finished) return;
    if (method === 'run/accepted' && params.sessionId === context.sessionId) { acknowledge(context, params); return; }
    if (method === 'runtime/request') {
      // This pinned safe profile has no user-input or approval tool. Preserve an
      // unexpected server request for an explicit decline instead of guessing a grant.
      const id = `deepseek-request:${params.requestId}`;
      context.pending.set(id, params);
      context.emit({ type: 'attention', attention: { id, kind: 'approval', title: 'DeepSeek 请求了当前模式不支持的操作',
        description: '当前助理模式仅用于规划和整理。可以拒绝此操作，让官方运行时继续处理。',
        options: [{ id: 'reject', label: '拒绝此操作并继续' }] } });
      return;
    }
    if (method !== 'runtime/notification') return;
    const payload = params.payload || {};
    if (payload.sessionId && payload.sessionId !== context.sessionId) return;
    if (params.method === 'session.status' && payload.status === 'running') context.emit({ type: 'progress', text: 'DeepSeek 官方 Harness 正在处理。' });
    if (params.method !== 'session.event') return;
    const event = payload.event || {};
    const data = event.data || {};
    if (event.type === 'assistant/message') {
      const message = data.message && typeof data.message === 'object' ? data.message : data;
      const content = Array.isArray(message.content) ? message.content : [];
      const rendered = content.filter(block => block?.type === 'text').map(block => clip(block.text)).join('');
      if (rendered) {
        context.lastText = clip(rendered);
        context.emit({ type: 'message', id: String(message.id || data.messageId || `deepseek-${context.sessionId}`), role: 'assistant', text: context.lastText, complete: true });
      }
    } else if (event.type === 'turn/start') {
      if (typeof data.turnId === 'string') { context.turnId = data.turnId; context.emit({ type: 'checkpoint', data: { turnId: data.turnId } }); }
      context.emit({ type: 'progress', text: 'DeepSeek 正在生成任务建议。' });
    }
  }
  function finish(context, type, detail) {
    if (context.finished) return;
    context.finished = true;
    if (type === 'complete') context.emit({ type, text: clip(detail), sessionId: context.sessionId, ...(context.turnId ? { turnId: context.turnId } : {}) });
    else context.emit({ type, message: detail, deliveryStatus: context.acknowledged ? 'accepted' : 'unknown' });
  }

  async function openWorker(context) {
    if (closed) throw error('runtime_closed', 'DeepSeek 连接已关闭。');
    if (!installed()) throw error('runtime_missing', '请先安装 DeepSeek 官方运行时。');
    let apiKey, model;
    if (context.authMode === 'account') {
      const current = await account.refresh();
      if (current.state !== 'ready') throw error(current.code || 'account_login_required', current.message || '请先使用 DeepSeek 官方账号登录。');
      model = getConfig().accountModel || current.models[0]?.id;
      if (!model || !current.models.some(row => row.id === model)) throw error('model_unavailable', '所选模型不在 DeepSeek 官方账号的可用目录中，请选择可用模型。');
    } else {
      apiKey = getSecret?.('apiKey');
      if (!apiKey) throw error('api_key_required', '请先保存 DeepSeek 官方 API 密钥。');
      model = getConfig().model || 'deepseek-v4-flash';
    }
    fs.mkdirSync(context.home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(context.cwd, { recursive: true });
    const rpc = makeTransport({ command: python, args: ['-I', '-X', 'utf8', '-u', script], cwd: context.cwd,
      env: isolatedRuntimeEnv(context.home, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }), requestTimeoutMs: 40000 });
    context.rpc = rpc;
    rpc.on('notification', (method, params) => receive(context, method, params));
    rpc.on('disconnect', () => { if (!context.closing) finish(context, 'interrupted', 'DeepSeek 官方运行时连接中断，可恢复原会话；原任务不会自动重发。'); });
    await rpc.open();
    const init = { home: context.home, cwd: context.cwd, authMode: context.authMode,
      patchPath: context.authMode === 'account' ? accountPatchPath : patchPath, model,
      ...(context.authMode === 'api_key' ? { apiKey } : {}) };
    // A loopback endpoint is an explicit test seam, never a public provider setting.
    if (options.testBaseUrl) {
      const endpoint = new URL(options.testBaseUrl);
      if (endpoint.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) || endpoint.username || endpoint.password) throw error('invalid_test_endpoint', '离线协议测试仅允许本机地址。');
      init.baseUrl = endpoint.href;
    }
    const result = await rpc.call('initialize', init);
    if (!result.initialized || result.sdkVersion !== VERSION || result.runtimeVersion !== VERSION) throw error('runtime_version_mismatch', 'DeepSeek 官方 SDK 与固定安全配置版本不一致，请更新运行时。');
    return rpc;
  }

  function contextFor(run, emit, sessionId) {
    if (occupied.has(sessionId)) throw error('session_busy', '这个 DeepSeek 会话已有任务在处理，请等待它结束。');
    const previous = savedSessions()[sessionId];
    // Existing sessions predate account support and belong to the API-key route.
    // A mode change never silently moves their history onto another identity.
    const authMode = previous?.authMode || (previous ? 'api_key' : selectedMode());
    const context = { run, emit, sessionId, authMode, home: authMode === 'account' ? account.home : sessionHome(sessionId),
      cwd: previous?.cwd || run.workingDirectory || path.join(projectRoot, '.antdesk', 'assistant-workspaces', run.id),
      acknowledged: false, finished: false, closing: false, lastText: '', pending: new Map() };
    active.set(run.id, context); occupied.set(sessionId, context);
    return context;
  }
  async function dispose(context) {
    context.closing = true;
    if (context.rpc && !context.rpc.closed) {
      try { await context.rpc.call('shutdown', {}, { timeoutMs: 6000 }); } catch {}
      await context.rpc.close();
    }
    active.delete(context.run.id);
    if (occupied.get(context.sessionId) === context) occupied.delete(context.sessionId);
  }

  async function start(run, emit) {
    if (cancelledRuns.has(run.id)) { emit({ type: 'interrupted', message: 'DeepSeek 任务已在发送前取消。', deliveryStatus: 'not_sent' }); return; }
    const sessionId = run.sessionId || `antdesk-${randomUUID()}`;
    if (run.sessionId && !savedSessions()[sessionId]) throw error('session_not_found', '找不到本应用的 DeepSeek 原会话，请从会话列表选择。');
    const context = contextFor(run, emit, sessionId);
    remember(sessionId, { name: clip(run.title, 200) || 'DeepSeek 会话', cwd: context.cwd, authMode: context.authMode, status: 'starting' });
    emit({ type: 'checkpoint', data: { sessionId, home: context.home, cwd: context.cwd, authMode: context.authMode } });
    try {
      const rpc = await openWorker(context);
      if (context.cancelRequested || cancelledRuns.has(run.id)) { finish(context, 'interrupted', 'DeepSeek 任务已在发送前取消。'); return; }
      const input = [clip(run.instruction, 40000), run.context ? `\n任务背景：\n${clip(run.context)}` : ''].join('\n');
      const result = await rpc.call('session/run', { sessionId, input, resume: !!run.sessionId }, { timeoutMs: 0 });
      if (context.cancelRequested) { finish(context, 'interrupted', 'DeepSeek 任务已停止。'); return; }
      if (!context.acknowledged && result.accepted) acknowledge(context, { messageId: '' });
      emit({ type: 'checkpoint', data: { sessionId, finishReason: result.finishReason, finalResponse: clip(result.finalResponse) } });
      if (successReasons.has(result.finishReason)) finish(context, 'complete', result.finalResponse);
      else if (['cancelled', 'canceled', 'interrupted', 'aborted'].includes(result.finishReason)) finish(context, 'interrupted', 'DeepSeek 官方运行时已中断这轮任务。');
      else { account.invalidate?.(); finish(context, 'failed', deepseekFailure(result.errorCode, 'DeepSeek 官方运行时没有确认正常完成，请查看已返回内容后决定是否继续。')); }
      remember(sessionId, { status: 'idle' });
    } catch (failure) {
      if (context.authMode === 'account') account.invalidate?.();
      finish(context, 'interrupted', failure instanceof BridgeError ? failure.message : deepseekFailure(failure?.data?.runtimeCode, '未收到 DeepSeek 官方运行时的完成确认，可恢复原会话；原任务不会自动重发。'));
      remember(sessionId, { status: 'interrupted' });
    } finally { await dispose(context); }
  }

  async function recover(run, emit) {
    if (active.has(run.id)) return;
    const sessionId = run.sessionId || run.runtimeData?.sessionId;
    if (!sessionId || !savedSessions()[sessionId]) { emit({ type: 'interrupted', message: '尚无可恢复的 DeepSeek 原会话编号；原任务不会自动重发。', deliveryStatus: 'unknown' }); return; }
    const context = contextFor(run, emit, sessionId);
    context.acknowledged = run.deliveryStatus === 'accepted';
    try {
      const rpc = await openWorker(context);
      await rpc.call('session/recover', { sessionId });
      if (successReasons.has(run.runtimeData?.finishReason)) finish(context, 'complete', run.runtimeData.finalResponse || '');
      else finish(context, 'interrupted', '已通过官方 SDK 恢复原会话历史。等待你明确提交后续任务，原指令没有重发。');
      remember(sessionId, { status: 'idle' });
    } catch { finish(context, 'interrupted', 'DeepSeek 原会话暂时无法恢复，请检查密钥或稍后重试。'); }
    finally { await dispose(context); }
  }

  async function cancel(run) {
    cancelledRuns.add(run.id);
    const context = active.get(run.id);
    if (!context) return { remoteStopped: run.deliveryStatus === 'pending' && !run.runtimeData?.sessionId, message: '已取消本地待发送任务；已发送任务仍以官方进程退出确认为准。' };
    context.cancelRequested = true;
    if (!context.rpc) return { remoteStopped: true, message: '任务尚未发给官方运行时，已取消。' };
    try {
      const result = await context.rpc.call('stop', {}, { timeoutMs: 6000 });
      if (result.stopped) { finish(context, 'interrupted', 'DeepSeek 官方运行时已关闭，这轮任务已停止。'); return { remoteStopped: true }; }
    } catch {}
    return { remoteStopped: false, message: '已请求停止，尚未得到官方进程退出确认。' };
  }

  return { id: ID, protocol: ID, status, start, recover, cancel,
    async configure(body = {}) {
      if (body.authMode !== undefined && !['account', 'api_key'].includes(body.authMode)) throw error('invalid_auth_mode', '请选择 DeepSeek 官方账号或 API Key。');
      const mode = body.authMode || (body.apiKey !== undefined ? 'api_key' : selectedMode());
      if (body.apiKey !== undefined && (typeof body.apiKey !== 'string' || body.apiKey.length > 4096 || /[\r\n\0]/.test(body.apiKey))) throw error('invalid_api_key', 'DeepSeek API 密钥格式无效。');
      if (body.model !== undefined && (typeof body.model !== 'string' || (body.model !== '' && !/^[a-zA-Z0-9._/-]{1,150}$/.test(body.model)))) throw error('invalid_model', 'DeepSeek 模型名称无效。');
      const epoch = ++configurationGeneration;
      if (selectedMode() === 'account' && mode === 'api_key') await account.login('cancel');
      if (closed || epoch !== configurationGeneration) return status();
      setConfig({ authMode: mode });
      if (mode === 'api_key' && body.apiKey !== undefined) {
        setSecret('apiKey', body.apiKey.trim());
        setConfig({ apiKeyValidation: null });
      }
      if (body.model !== undefined) {
        setConfig({ [mode === 'account' ? 'accountModel' : 'model']: body.model });
      }
      const apiKey = getSecret?.('apiKey');
      if (mode === 'api_key' && apiKey) {
        const verification = await validateApiKey(apiKey);
        if (!closed && epoch === configurationGeneration && apiKey === getSecret?.('apiKey')) {
          setConfig({ apiKeyValidation: verification });
        }
      }
      return status();
    },
    async login(action = 'status') {
      if (action === 'start') { configurationGeneration++; setConfig({ authMode: 'account' }); return account.login('start'); }
      if (selectedMode() === 'account') {
        if (action === 'logout') { configurationGeneration++; for (const context of active.values()) if (context.authMode === 'account') await cancel(context.run); }
        return account.login(action);
      }
      if (action === 'logout') { configurationGeneration++; for (const context of active.values()) if (context.authMode === 'api_key') await cancel(context.run); setSecret('apiKey', ''); setConfig({ apiKeyValidation: null }); return { state: 'idle', message: '已清除本应用的 DeepSeek API 密钥；官方账号登录未改动。' }; }
      const current = await status();
      return { state: current.readiness === 'ready' ? 'ready' : keyPresent() ? 'failed' : 'idle', message: current.message };
    },
    async agents() { return { agents: [{ id: ID, name: 'DeepSeek Harness', description: '官方 Harness 事项助理，默认只规划与整理；Shell、文件工具和上传已禁用。' }] }; },
    async sessions() { return { sessions: Object.values(savedSessions()).sort((a, b) => b.updatedAt - a.updatedAt).map(({ id, sessionId, name, status: state, updatedAt }) => ({ id, sessionId, name, status: state, updatedAt })) }; },
    async respond(run, body) {
      const context = active.get(run.id), request = context?.pending.get(body.attentionId);
      if (!request) throw error('attention_stale', 'DeepSeek 的这条确认已经结束。');
      if (body.decision !== 'reject') throw error('unsupported_operation', '当前事项助理模式只能拒绝此操作。');
      await context.rpc.call('request/respond', { requestId: request.requestId });
      context.pending.delete(body.attentionId);
      return { ok: true, message: '已通过官方 SDK 拒绝该操作。' };
    },
    async close() {
      closed = true; configurationGeneration++;
      const contexts = [...active.values()];
      await Promise.allSettled(contexts.map(async context => { await cancel(context.run); await dispose(context); }));
      await account.close();
    },
  };
}

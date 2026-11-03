import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { BridgeError, hash } from '../lib/util.mjs';
import { StdioRpc, isolatedRuntimeEnv } from './stdio-rpc.mjs';

const ID = 'muse-personal';
const VERSION = '0.3.10';
const clip = (value, limit = 262144) => typeof value === 'string' ? value.slice(0, limit) : '';
const error = (code, message) => new BridgeError(409, code, message);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(value);
// The SDK also labels 429/5xx as AuthError. Only a confirmed authorization
// rejection expires a saved login; transient VM/network failures do not.
const authFailure = failure => failure?.data?.code === 'auth_required'
  || (failure?.data?.kind === 'AuthError' && !failure.data.code);
// Never forward upstream exception text: it may contain cookies or signed URLs.
const IDENTITY_ISSUES = Object.freeze({
  network_timeout: 'Muse 身份核验超时，请检查网络或原 Muse 服务状态。',
  network_error: '暂时无法连接 Muse 身份服务，请检查网络。',
  vm_unavailable: '原 Muse 的个人实例暂不可用，尚未确认账号身份。',
  gateway_unavailable: '原 Muse 网关暂不可用，尚未确认账号身份。',
  rate_limited: 'Muse 暂时限制了身份核验请求的频率。',
  service_unavailable: 'Muse 服务暂时不可用，身份核验未完成。',
  access_denied: 'Muse 拒绝了账号身份读取，请在官方应用检查账号权限。',
  invalid_response: 'Muse 身份接口返回的数据无法识别。',
  runtime_unavailable: 'Muse 连接组件暂不可用，请检查安装。',
  runtime_version_mismatch: 'Muse 连接组件未返回有效版本或账号信息，请检查安装。',
});
const identityIssueText = failure => {
  if (failure?.data?.stage === 'wake') return '原 Muse 的个人实例正在从休眠恢复，登录资料会保留。';
  if (failure?.data?.stage === 'gateway') return 'Muse 登录校验已通过，但实时连接网关暂不可用。';
  if (failure?.data?.stage === 'identity') return 'Muse 登录校验已通过，但暂时无法从个人实例读取助理身份。';
  const code = failure?.code === 'RPC_TIMEOUT' ? 'network_timeout' : failure?.data?.code || failure?.code;
  return typeof code === 'string' && Object.hasOwn(IDENTITY_ISSUES, code)
    ? IDENTITY_ISSUES[code] : 'Muse 身份核验未完成，请检查网络和原 Muse 服务状态。';
};

/** A history cursor is evidence, not an idempotency key. Only an attributable,
 * explicitly completed reply can become a review result. A missing anchor,
 * duplicate marker or another user's input leaves delivery unresolved. */
export function inspectMuseHistory(events, checkpoint) {
  const rows = (Array.isArray(events) ? events : []).filter(row => row && Number.isSafeInteger(row.seq) && row.seq > checkpoint.baseline)
    .sort((a, b) => a.seq - b.seq);
  const anchors = rows.filter(row => row.role === 'user' && typeof row.text === 'string' && row.text.includes(checkpoint.marker));
  if (anchors.length !== 1) return { accepted: false, ambiguous: anchors.length > 1, messages: [], result: '' };
  const anchor = anchors[0];
  if (rows.some(row => row.role === 'user' && row !== anchor)) return { accepted: true, ambiguous: true, anchor, messages: [], result: '' };
  const messages = rows.filter(row => row.seq >= anchor.seq && ['user', 'assistant'].includes(row.role) && typeof row.text === 'string');
  const replies = messages.filter(row => row.role === 'assistant' && row.status === 'completed' && !row.replyTo && row.text.trim());
  return { accepted: true, ambiguous: false, anchor, messages, result: clip(replies.map(row => row.text).join('\n\n')) };
}

/** Community SDK for the existing muse.ai personal Bot. This is distinct from Muse Code. */
export function createMusePersonalAdapter(options) {
  const { projectRoot, dataDir, toolsDir, getSecret, setSecret } = options;
  const getConfig = options.getConfig || (() => ({}));
  const setConfig = options.setConfig || (() => {});
  const python = process.platform === 'win32'
    ? path.join(toolsDir, ID, 'venv', 'Scripts', 'python.exe')
    : path.join(toolsDir, ID, 'venv', 'bin', 'python');
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'muse_personal_worker.py');
  const home = path.join(dataDir, 'worker-home');
  const makeTransport = options.transportFactory || (settings => new StdioRpc(settings));
  const active = new Map(), cancelled = new Set(), workers = new Set();
  const pollIntervalMs = options.pollIntervalMs ?? 1500;
  const maxWaitMs = options.maxWaitMs ?? 10 * 60 * 1000;
  const identityRetryDelayMs = options.identityRetryDelayMs ?? 30000;
  let closed = false, verifiedCookieHash, verifiedAccount, identityCheck, identityIssue,
    identityCheckedAt = 0, identityCheckedKey, authGeneration = 0;
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const installed = () => !!options.transportFactory || fs.existsSync(python);
  const hasCookies = () => typeof getSecret?.('cookies') === 'string' && !!getSecret('cookies');

  function noteFailure(failure, cookies, generation = authGeneration) {
    if (!closed && generation === authGeneration && authFailure(failure) && (cookies === undefined || getSecret('cookies') === cookies)) {
      verifiedCookieHash = undefined; verifiedAccount = undefined; setConfig({ authState: 'expired' });
    }
  }
  async function connect(context, cookieOverride) {
    if (closed) throw error('runtime_closed', '原 Muse 连接已关闭。');
    if (!installed()) throw error('runtime_missing', '尚未安装原 Muse 社区连接组件。');
    const cookies = cookieOverride ?? getSecret?.('cookies');
    if (!cookies) throw error('login_required', '请先在 AntDesk 专用浏览器中登录原 Muse。');
    context.cookies = cookies; context.authGeneration = authGeneration;
    if (context.signal?.aborted) throw Object.assign(new Error('Login verification cancelled.'), { code: 'ABORT_ERR' });
    const rpc = makeTransport({ command: python, args: ['-I', '-X', 'utf8', '-u', script], cwd: projectRoot,
      env: isolatedRuntimeEnv(home, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }), requestTimeoutMs: 90000,
      maxFrameBytes: 8 * 1024 * 1024 });
    context.rpc = rpc;
    workers.add(context);
    rpc.on('disconnect', () => { context.disconnected = true; context.wake?.(); });
    await rpc.open();
    const result = await rpc.call('initialize', { cookies }, { timeoutMs: 150000, signal: context.signal });
    if (closed || context.closing || context.authGeneration !== authGeneration || context.signal?.aborted)
      throw error('verification_cancelled', 'Muse 身份核验已结束，请重新检查连接。');
    if (!result?.initialized || result.sdkVersion !== VERSION || !validId(result.account?.id)) throw error('runtime_version_mismatch', '原 Muse 连接组件版本或身份格式不匹配。');
    context.account = { id: result.account.id, name: clip(result.account.name, 160) || '我的 Muse' };
    // A candidate login must not replace metadata for the saved account until
    // the browser helper has committed that login (it may still be cancelled).
    if (cookieOverride === undefined) {
      if (getSecret('cookies') !== cookies) throw error('account_changed', 'Muse 登录身份已变化，请重新检查连接。');
      setConfig({ authState: 'ready', account: context.account, credentialFingerprint: hash(cookies), lastVerifiedAt: Date.now() });
    }
    return rpc;
  }
  async function dispose(context) {
    context.closing = true;
    context.wake?.();
    if (context.rpc && !context.rpc.closed) {
      try { await context.rpc.call('shutdown', {}, { timeoutMs: 1500 }); } catch {}
      await context.rpc.close();
    }
    if (context.run && active.get(context.run.id) === context) active.delete(context.run.id);
    workers.delete(context);
  }
  async function withWorker(fn, cookies, signal) {
    const context = { signal };
    try { const rpc = await connect(context, cookies); return await fn(rpc, context); }
    catch (failure) { if (cookies === undefined) noteFailure(failure, context.cookies, context.authGeneration); throw failure; }
    finally { await dispose(context); }
  }

  let browser, browserPromise;
  async function browserController() {
    if (closed) throw error('runtime_closed', '原 Muse 连接已关闭。');
    if (!browserPromise) browserPromise = (async () => {
      const factory = options.browserLoginFactory || (await import('./muse-browser-login.mjs')).createMuseBrowserLogin;
      browser = factory({ dataDir, toolsDir, getSecret, setSecret,
          verifyCookies: async (cookies, { signal } = {}) => {
            const generation = authGeneration;
            try {
              return await withWorker(async rpc => {
                const result = await rpc.call('account/read', {}, { signal });
                if (!validId(result?.account?.id) || closed || signal?.aborted || generation !== authGeneration) return { ok: false };
                // This may be either a new candidate or the helper's passive
                // validation of the saved login. Do not expose the cookie/hash.
                verifiedCookieHash = hash(cookies);
                verifiedAccount = { id: result.account.id, name: clip(result.account.name,160) || '我的 Muse' };
                if (getSecret('cookies') === cookies) setConfig({ authState: 'ready', account: verifiedAccount,
                  credentialFingerprint: verifiedCookieHash, lastVerifiedAt: Date.now() });
                return { ok: true };
              }, cookies, signal);
            } catch (failure) {
              // The helper can wait/retry transient verification errors.
              // Expire only the same saved login, never a different candidate
              // or a saved login replaced while verification was pending.
              if (!signal?.aborted) noteFailure(failure, cookies, generation);
              throw failure;
            }
          } });
      return browser;
    })().catch(failure => { browserPromise = undefined; throw failure; });
    return browserPromise;
  }

  async function status() {
    if (closed) return { id: ID, protocol: ID, name: 'Muse 原 Bot', official: false, installed: installed(), readiness: 'unavailable', message: 'Muse 连接已关闭。' };
    const exists = installed(), loggedIn = hasCookies() && getConfig().authState !== 'expired';
    const cookies = loggedIn ? getSecret('cookies') : undefined;
    const saved = getConfig();
    const bound = loggedIn && validId(saved.account?.id) && saved.credentialFingerprint === hash(cookies);
    const identityKey = cookies ? `${authGeneration}:${hash(cookies)}` : '';
    if (bound || identityIssue?.key !== identityKey) identityIssue = undefined;
    // Older saved logins lack stable account metadata. Verify those in the
    // background without opening a browser or blocking every provider query.
    if (exists && loggedIn && !bound && !identityCheck
      && (identityCheckedKey !== identityKey || Date.now()-identityCheckedAt >= identityRetryDelayMs)) {
      const generation = authGeneration;
      const stillCurrent = () => !closed && generation === authGeneration && getSecret('cookies') === cookies;
      identityCheck = withWorker(async (_rpc, context) => {
        if (stillCurrent()) {
          setConfig({authState:'ready',account:context.account,credentialFingerprint:hash(cookies),lastVerifiedAt:Date.now()});
          identityIssue = undefined;
        }
      }, cookies).catch(failure => {
        noteFailure(failure, cookies, generation);
        if (stillCurrent() && !authFailure(failure)) identityIssue = {key:identityKey,message:identityIssueText(failure)};
      }).finally(() => {
        identityCheck = undefined;
        // A 150-second timeout must not trigger another attempt immediately on
        // the next provider poll. Count the retry delay from completion.
        if (stillCurrent()) { identityCheckedAt = Date.now(); identityCheckedKey = identityKey; }
      });
    }
    const issue = identityIssue?.key === identityKey ? identityIssue : undefined;
    return { id: ID, protocol: ID, name: 'Muse 原 Bot', official: false, installed: exists,
      readiness: !exists ? 'needs_install' : loggedIn ? bound ? 'ready' : issue ? 'unavailable' : 'connecting' : 'needs_login', version: exists ? VERSION : undefined,
      ...(bound ? {connectionIdentity:hash(JSON.stringify(['muse',saved.account.id])),agentId:saved.account.id} : {}),
      message: !exists ? '尚未安装原 Muse 社区连接组件。' : loggedIn
        ? bound ? '已保存原 Muse 登录资料；派发时会重新验证身份，每件事项使用独立侧会话（社区协议组件）。'
        : issue ? issue.message + (identityCheck ? ' 正在后台重新核验。' : ' 稍后会重新核验，已保存的登录资料未清除。')
        : '正在核验已保存的 Muse 身份，聊天记录会绑定到这个账号。'
        : getConfig().authState === 'expired' ? '已保存的原 Muse 登录验证失败，请在 AntDesk 专用窗口重新登录。'
        : '请在 AntDesk 专用浏览器中登录 muse.ai；该窗口使用独立登录会话。' };
  }
  function remember(sessionId, patch) {
    const previous = getConfig().sessions || {};
    const sessions = { ...previous, [sessionId]: { ...previous[sessionId], ...patch, id: sessionId, sessionId, updatedAt: Date.now() } };
    setConfig({ sessions: Object.fromEntries(Object.entries(sessions).sort((a, b) => b[1].updatedAt - a[1].updatedAt).slice(0, 1000)) });
  }
  function finish(context, type, message) {
    if (context.finished || context.cancelRequested) return;
    context.finished = true;
    context.emit(type === 'complete'
      ? { type, text: clip(message), sessionId: context.checkpoint?.sessionId }
      : { type, message, deliveryStatus: context.accepted ? 'accepted' : 'unknown' });
  }
  function interrupted(context, failure) {
    noteFailure(failure, context.cookies, context.authGeneration);
    if (authFailure(failure) && !context.cancelRequested) context.emit({ type: 'attention', attention: {
      id: `muse-login-${context.run.id}`, kind: 'login', title: '原 Muse 登录已过期', description: '请重新连接原 Muse 账号，再只读恢复这一事项；不会重发原任务。' } });
    finish(context, 'interrupted', authFailure(failure)
      ? '原 Muse 登录需要更新。重新连接后可以读取原侧会话，原任务不会重发。'
      : failure instanceof BridgeError ? failure.message : '原 Muse 执行结果尚未确认。可以同步读取原侧会话，原任务不会重发。');
  }
  async function pause(context) {
    if (context.cancelRequested || context.disconnected) return;
    await new Promise(resolve => {
      const timer = setTimeout(done, pollIntervalMs);
      function done() { clearTimeout(timer); context.wake = null; resolve(); }
      context.wake = done;
    });
  }
  async function poll(context) {
    const deadline = Date.now() + maxWaitMs;
    while (!context.cancelRequested && !closed && Date.now() <= deadline) {
      if (context.disconnected) throw error('connection_lost', '原 Muse 连接中断，可以同步原侧会话，原任务不会重发。');
      const history = await context.rpc.call('history/read', { sessionId: context.checkpoint.sessionId, limit: 512 });
      if (!Array.isArray(history?.events) || !Number.isSafeInteger(history.maxSeq)) throw error('invalid_history', '原 Muse 会话记录格式无效。');
      const state = inspectMuseHistory(history.events, context.checkpoint);
      context.emit({ type: 'checkpoint', sessionId: context.checkpoint.sessionId, cursor: String(history.maxSeq),
        data: { lastReadSeq: history.maxSeq } });
      if (state.accepted && !context.accepted) {
        context.accepted = true;
        const turnId = state.anchor.messageId || `muse-user-${state.anchor.seq}`;
        context.emit({ type: 'checkpoint', turnId, data: { userSeq: state.anchor.seq, userMessageId: state.anchor.messageId || '' } });
        context.emit({ type: 'started', sessionId: context.checkpoint.sessionId, turnId });
      }
      if (state.ambiguous) {
        finish(context, 'interrupted', '原 Muse 侧会话出现了额外输入或重复消息，暂不能确认交付归属。请在原会话核对；不会重复派发。');
        return;
      }
      for (const item of state.messages) context.emit({ type: 'message', id: item.messageId || `muse-${item.seq}`,
        role: item.role, text: clip(item.text, 16384), complete: item.role === 'user' || item.status === 'completed' });
      if (state.result) {
        finish(context, 'complete', state.result);
        remember(context.checkpoint.sessionId, { status: 'review' });
        return;
      }
      context.emit({ type: 'progress', text: state.accepted ? '原 Muse 已收到事项，正在处理独立侧会话。' : '正在只读确认原 Muse 是否收到这件事项。' });
      await pause(context);
    }
    if (!context.cancelRequested) finish(context, 'interrupted', '本轮等待已结束。可继续同步读取原 Muse 侧会话，原任务不会重发。');
  }
  function contextFor(run, emit) {
    if (active.has(run.id)) return null;
    const context = { run, emit, accepted: run.deliveryStatus === 'accepted', finished: false, cancelRequested: cancelled.has(run.id) };
    active.set(run.id, context);
    return context;
  }

  async function start(run, emit) {
    if (run.sessionId) { emit({ type: 'failed', message: '原 Muse 每件事项建立独立侧会话。请清除旧会话选择后重新派发。', deliveryStatus: 'rejected' }); return; }
    if (run.runtimeData?.sendIntent) { emit({ type: 'interrupted', message: '这件事项已经尝试发送，只能恢复原会话。', deliveryStatus: 'unknown' }); return; }
    const context = contextFor(run, emit); if (!context) return;
    try {
      if (context.cancelRequested) return;
      const rpc = await connect(context);
      if (context.cancelRequested) return;
      if (![ID, context.account.id].includes(run.agentId)) throw error('account_mismatch', '当前登录的 Muse 与事项选择的原 Bot 不一致，请选择正确账号。');
      emit({ type: 'checkpoint', data: { accountId: context.account.id, phase: 'creating-session' } });
      const created = await rpc.call('session/create');
      if (!validId(created?.sessionId)) throw error('invalid_session', '原 Muse 没有返回有效侧会话编号。');
      context.checkpoint = { sessionId: created.sessionId, accountId: context.account.id, phase: 'session-created' };
      emit({ type: 'checkpoint', sessionId: created.sessionId, data: context.checkpoint });
      remember(created.sessionId, { name: clip(run.title, 200) || 'AntDesk 事项', runId: run.id, status: 'preparing', accountId: context.account.id });
      if (context.cancelRequested) return;
      try { await rpc.call('session/rename', { sessionId: created.sessionId, title: `AntDesk · ${clip(run.title, 180)}` }); } catch {}
      if (context.cancelRequested) return;
      const history = await rpc.call('history/read', { sessionId: created.sessionId, limit: 1 });
      if (!Number.isSafeInteger(history?.maxSeq) || history.maxSeq < 0) throw error('invalid_history', '无法确认原 Muse 侧会话的初始位置，未发送任务。');
      const marker = `[AntDesk 事项 ${run.id}]`;
      const nodeId = getConfig().nodeId || `antdesk-${randomUUID()}`;
      setConfig({ nodeId });
      context.checkpoint = { ...context.checkpoint, baseline: history.maxSeq, marker, sendIntent: true, phase: 'send-intent', nodeId };
      // RuntimeManager.emit commits synchronously. This intent and baseline are
      // durable before Python is ever permitted to write chat.stream bytes.
      emit({ type: 'checkpoint', data: context.checkpoint });
      if (context.cancelRequested) return;
      const input = [marker, clip(run.instruction, 40000), run.context ? `任务背景：\n${clip(run.context)}` : ''].filter(Boolean).join('\n\n');
      await rpc.call('chat/send', { runId: run.id, sessionId: created.sessionId, nodeId, text: input });
      emit({ type: 'checkpoint', data: { phase: 'send-attempted' } });
      await poll(context);
    } catch (failure) { interrupted(context, failure); }
    finally { await dispose(context); }
  }

  async function recover(run, emit) {
    const data = run.runtimeData || {};
    if (!validId(data.sessionId) || !Number.isSafeInteger(data.baseline) || !data.marker || !data.sendIntent) {
      emit({ type: 'interrupted', message: '没有足够的原 Muse 发送记录可供确认；不会重新建立会话或重发任务。', deliveryStatus: run.deliveryStatus === 'accepted' ? 'accepted' : 'unknown' });
      return;
    }
    const context = contextFor(run, emit); if (!context) return;
    context.checkpoint = { ...data };
    try {
      if (context.cancelRequested) return;
      await connect(context);
      if (data.accountId !== context.account.id) throw error('account_mismatch', '请重新连接创建这件事项时使用的原 Muse 账号，再恢复原侧会话。');
      await poll(context); // Readback only: no session/create or chat/send on recovery.
    } catch (failure) { interrupted(context, failure); }
    finally { await dispose(context); }
  }

  async function cancel(run) {
    cancelled.add(run.id);
    const context = active.get(run.id);
    if (context) { context.cancelRequested = true; context.wake?.(); await dispose(context); }
    return { remoteStopped: false, message: '已停止 AntDesk 本地等待；原 Muse 没有可验证的停止确认，请在原侧会话检查。' };
  }

  return { id: ID, protocol: ID, status, start, recover, cancel,
    async agents() {
      try { return await withWorker(async (_rpc, context) => ({ agents: [{ ...context.account, description: '你在 muse.ai 的原 Muse；事项使用独立侧会话。' }] })); }
      catch (failure) { throw error(authFailure(failure) ? 'login_required' : 'connection_failed', '无法读取原 Muse 身份，请完成专用浏览器登录后重试。'); }
    },
    async sessions() {
      try { return await withWorker(async rpc => rpc.call('sessions/list')); }
      catch (failure) { throw error(authFailure(failure) ? 'login_required' : 'connection_failed', '无法读取原 Muse 会话，请检查连接后重试。'); }
    },
    async login(action = 'status') {
      if (action === 'logout') {
        authGeneration++;
        identityIssue = undefined; identityCheckedAt = 0; identityCheckedKey = undefined;
        for (const context of [...active.values()]) await cancel(context.run);
        verifiedCookieHash = undefined; verifiedAccount = undefined;
        setConfig({ authState: 'idle', account: null, credentialFingerprint: null });
      }
      const result = await (await browserController()).login(action);
      const saved = getSecret('cookies');
      // A helper may still cache an earlier ready response after a later SDK
      // call established expiration. Only the verified, currently saved login
      // may restore readiness; a cancelled candidate cannot do so.
      if (result?.state === 'ready' && saved && verifiedCookieHash === hash(saved) && validId(verifiedAccount?.id))
        setConfig({ authState: 'ready', account: verifiedAccount, credentialFingerprint:verifiedCookieHash, lastVerifiedAt: Date.now() });
      if (result?.state === 'ready' && getConfig().authState === 'expired') return { ...result, state: 'failed',
        message: '已保存的原 Muse 登录已失效，请重新登录后再连接。' };
      return result;
    },
    async respond() { throw error('not_supported', '请在原 Muse 侧会话处理这条请求。AntDesk 不会自动授权未知操作。'); },
    async close() {
      closed = true; authGeneration++;
      await Promise.allSettled([...active.values()].map(context => cancel(context.run)));
      await Promise.allSettled([...workers].map(context => dispose(context)));
      if (browserPromise) { try { await (await browserPromise).close(); } catch {} }
    },
  };
}

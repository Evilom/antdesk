import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { BridgeError } from '../lib/util.mjs';
import { createChromeDotsFetch } from './dots-chrome.mjs';

// Interoperability contracts were checked against the installed, unmodified
// OpenAI.Codex 26.1027.3384.0 program (reference/codex-26.1027.3384).
// native-api-7e5ae8fa0cca.js: room/history GETs and idempotent message POST.
// Authentication comes ONLY from an AntDesk-owned app-server profile. That
// profile is the Chrome ChatGPT account, not the account in the desktop Codex
// home. Node fetch is challenged on /backend-api/tbo; the Chrome-impersonating
// client below is what the dots edge accepts. This module never opens an auth
// file, browser profile, or another app's IPC.
const ID = 'dots-direct';
const BASE = 'https://chatgpt.com/backend-api';
// The messaging history endpoint rejects limit > 32 (422 less_than_equal).
// The desktop client reads 20 at a time. AntDesk does not use that page to
// download the room's existing transcript. A page is only the messages after
// the one this dispatch just sent, or a single newest page when a receipt was lost.
const HISTORY_PAGE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' ? value : '';
const identityKey = auth => createHash('sha256').update(JSON.stringify([auth.accountId, auth.userId])).digest('hex');
const placeholder = id => !id || ['gptdot', 'dots', 'omdot-direct', ID].includes(id);
const AUTH_DIAGNOSTICS = Object.freeze({
  runtime_missing: ['runtime', false], runtime_unavailable: ['runtime', true], runtime_closed: ['runtime', true], runtime_close_timeout: ['runtime', true],
  profile_not_isolated: ['runtime', false], protocol_mismatch: ['runtime', false],
  authorization_incomplete: ['authorization', true], invalid_authorization_url: ['authorization', false],
  login_timeout: ['authorization', true], auth_mode_unsupported: ['authorization', false],
  account_identity_missing: ['identity', false], account_identity_mismatch: ['identity', true],
  logout_failed: ['authorization', true], connection_failed: ['runtime', true],
});

function authDiagnostic(value) {
  if (!object(value) || !Object.hasOwn(AUTH_DIAGNOSTICS, value.code)) return undefined;
  const [stage, retryable] = AUTH_DIAGNOSTICS[value.code];
  // Reconstruct the public category; never spread arbitrary upstream diagnostics.
  return { stage, code: value.code, retryable };
}

export class DotsError extends BridgeError {
  constructor(code, message, { status = 0, deliveryUnknown = false, blocked = false } = {}) {
    super(status >= 400 && status <= 599 ? status : code.startsWith('invalid_') ? 400 : 409, code, message);
    this.name = 'DotsError'; this.code = code; this.publicMessage = message;
    this.httpStatus = status; this.deliveryUnknown = deliveryUnknown; this.blocked = blocked;
  }
}

function error(code, message, options) { return new DotsError(code, message, options); }
function identifier(value) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:~-]{0,255}$/.test(value || ''))
    throw error('invalid_dot_identifier', '原 Dot 或会话编号无效，请重新选择。');
  return encodeURIComponent(value);
}
function publicError(value) {
  return value instanceof DotsError ? value : error('dots_unavailable', '原 Dots 连接暂时不可用，已保留事项和会话关联。');
}
function checkAbort(signal) { signal?.throwIfAborted(); }

async function readJson(response, maxBytes = 8 * 1024 * 1024) {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw error('dots_response_too_large', '原 Dots 返回的会话过大，请在原应用检查后重试。');
  }
  let body = '';
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder(); let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read(); if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) { await reader.cancel(); throw error('dots_response_too_large', '原 Dots 返回的会话过大。'); }
        body += decoder.decode(chunk.value, { stream: true });
      }
      body += decoder.decode();
    } finally { reader.releaseLock(); }
  } else body = await response.text();
  try { return JSON.parse(body); }
  catch { return null; }
}

function responseError(response, body, mutation) {
  // Upstream text is inspected for a known category but never persisted/returned:
  // it may contain account data, credentials or an echoed request.
  const detail = object(body?.detail) ? body.detail : object(body?.error) ? body.error : {};
  const code = [detail.code, body?.code, detail.type].filter(v => typeof v === 'string').join(' ');
  const hint = code + ' ' + text(detail.message) + ' ' + text(body?.detail);
  const status = response.status;
  // A web challenge and a native client proof are different failure layers.
  // An OAuth login can succeed while either remains unsatisfied. Completing
  // a check in another browser/app is not proof this HTTP transport can use it.
  if (response.headers.get('cf-mitigated')?.toLowerCase() === 'challenge' || /cloudflare|captcha|turnstile|browser.?verification|browser.?check/i.test(hint))
    return error('browser_verification_required', '原 Dots 的网页访问验证尚未通过。请先在官方 ChatGPT 网页确认原 Dot 可用，再重新检查；网页登录状态不会自动传给本机直连。', { status, blocked: true });
  if (/device.?check|attest|integrity|sentinel|desktop.?surface/i.test(hint))
    return error('device_verification_required', '原 Dots 服务要求当前请求的客户端或设备证明。仅完成账号登录不一定能满足；可以在官方应用中使用原 Dot，或改用官方事件连接。', { status, blocked: true });
  if (/challenge/i.test(hint))
    return error('browser_verification_required', '原 Dots 返回了额外访问验证要求。请在官方 ChatGPT 网页检查后重试；当前直连尚未通过验证。', { status, blocked: true });
  if (status === 401) return error('needs_login', 'ChatGPT 登录已失效，请重新登录后恢复原 Dot 会话。', { status });
  if (status === 403) return error('dots_access_denied', '这个账号或工作区尚未允许访问原 Dots。请确认登录了 omdot 所在的账号，并在官方应用检查访问权限。', { status, blocked: true });
  if (status === 404) return error('dot_unavailable', '当前账号下找不到这个原 Dot 或消息房间，请重新选择原助理。', { status });
  if (status === 409) return error('dots_conflict', '原 Dot 会话状态已变化，请检查原会话后恢复。', { status });
  if (status === 429) return error('dots_rate_limited', '原 Dots 服务暂时限流，请稍后恢复读取。', { status });
  if (status === 400 || status === 413 || status === 422)
    return error('dots_request_rejected', '原 Dots 没有接受这次请求，可能是客户端协议更新或消息过长。', { status });
  return error('dots_unavailable', '原 Dots 服务暂时不可用，已保留原发送编号；恢复时只读取会话。', { status, deliveryUnknown: mutation && (status >= 500 || status === 408) });
}

/** A small HTTP client with a fixed official origin and account-bound requests. */
export function createDotsClient({ getAuth, fetchImpl = fetch, requestTimeoutMs = 30000 } = {}) {
  async function auth(expectedKey, refreshToken = false) {
    const value = await getAuth?.({ refreshToken });
    if (!value || typeof value.token !== 'string' || !value.token || typeof value.accountId !== 'string' || !value.accountId)
      throw error('needs_login', '请先通过官方登录页登录 omdot 所在的 ChatGPT 账号。');
    if (typeof value.userId !== 'string' || !value.userId || /[\x00-\x20\x7f]/.test(value.userId))
      throw error('account_identity_missing', '官方登录尚未提供稳定用户标识，请重新连接原账号。');
    if (/[\r\n]/.test(value.token + value.accountId)) throw error('invalid_auth', '官方登录状态无效，请重新登录。');
    if (expectedKey && identityKey(value) !== expectedKey)
      throw error('account_changed', '登录账号已变化。请重新登录原账号后恢复，AntDesk 没有把事项发送给其他账号。');
    return value;
  }
  async function request(path, { method = 'GET', body, signal, expectedKey, onDispatch } = {}) {
    if (!path.startsWith('/') || path.startsWith('//') || path.includes('#') || path.includes('\\'))
      throw error('invalid_endpoint', '原 Dots 请求地址无效。');
    const url = new URL(BASE + path);
    if (url.origin !== 'https://chatgpt.com' || !url.pathname.startsWith('/backend-api/'))
      throw error('invalid_endpoint', '原 Dots 请求地址无效。');
    const mutation = method !== 'GET', timeout = AbortSignal.timeout(requestTimeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let current = await auth(expectedKey), key = expectedKey || identityKey(current);
    for (let attempt = 0; ; attempt++) {
      checkAbort(combined);
      const headers = { Authorization: 'Bearer ' + current.token, 'ChatGPT-Account-ID': current.accountId,
        Accept: 'application/json', 'OAI-Language': 'zh-CN', originator: 'Codex Desktop', 'OAI-Product-Sku': 'CODEX' };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let response;
      try {
        onDispatch?.();
        response = await fetchImpl(url.href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body),
          signal: combined, redirect: 'error', credentials: 'omit' });
      } catch (failure) {
        if (signal?.aborted || failure?.code === 'ABORT_ERR') throw error('cancelled', '已停止本地等待，原 Dot 可能仍在执行。', { deliveryUnknown: mutation });
        if (failure instanceof DotsError) throw failure;
        if (failure?.code === 'runtime_missing') throw error('runtime_missing', failure.message || '访问原 Dots 的浏览器组件尚未安装。');
        if (failure?.code === 'invalid_endpoint') throw error('invalid_endpoint', '原 Dots 请求地址无效。');
        throw error('dots_network', '无法确认原 Dots 的响应。恢复会查询同一会话，不会重复发送。', { deliveryUnknown: mutation });
      }
      // Refresh/retry only a read. No POST, including a timed-out POST, is replayed.
      if (response.status === 401 && !mutation && attempt === 0) {
        await response.body?.cancel(); current = await auth(key, true); continue;
      }
      let data;
      try { data = await readJson(response); }
      catch (value) {
        const failure = publicError(value); if (mutation) failure.deliveryUnknown = true; throw failure;
      }
      checkAbort(combined);
      // Switching accounts during a fetch must not leak the old account's data.
      await auth(key);
      if (!response.ok) throw responseError(response, data, mutation);
      if (!object(data)) throw error('dots_protocol_changed', '原 Dots 返回了无法识别的数据，请检查客户端协议。', { deliveryUnknown: mutation });
      return data;
    }
  }
  async function listDots({ expectedKey, signal } = {}) {
    expectedKey ||= identityKey(await auth());
    const items = [], cursors = new Set(); let cursor;
    for (let page = 0; page < 40; page++) {
      const query = new URLSearchParams({ limit: '25', include_room_preview: 'false' });
      if (cursor) query.set('cursor', cursor);
      const data = await request('/tbo?' + query, { expectedKey, signal });
      if (!Array.isArray(data.items)) throw error('dots_protocol_changed', '原 Dots 目录格式已变化。');
      for (const item of data.items) if (object(item) && typeof item.id === 'string') items.push(item);
      cursor = data.cursor;
      if (cursor == null || cursor === '') return { items, truncated: false };
      if (typeof cursor !== 'string' || cursors.has(cursor)) throw error('dots_protocol_changed', '原 Dots 目录分页异常。');
      cursors.add(cursor);
    }
    return { items, truncated: true };
  }
  async function target(agentId, { expectedKey, signal, sessionId } = {}) {
    expectedKey ||= identityKey(await auth());
    const profile = await request('/tbo/' + identifier(agentId), { expectedKey, signal });
    if (profile.id !== agentId || profile.status && profile.status !== 'active')
      throw error('dot_unavailable', '选定的原 Dot 已不存在或暂时不可用。');
    const roomId = text(profile.messaging_room_id);
    if (!roomId) throw error('needs_room', '这个原 Dot 尚无可读取的消息房间。请先在官方应用打开它的原会话，再返回连接。');
    if (sessionId && sessionId !== roomId) throw error('room_changed', '选定的房间与这个原 Dot 不一致，已停止派发。请重新选择原会话。');
    const room = await request('/messaging/rooms/' + identifier(roomId), { expectedKey, signal });
    if (room.id !== roomId || room.type !== 'DM' || room.app_source !== 'chatgpt:messaging' || !Array.isArray(room.members))
      throw error('dots_protocol_changed', '原 Dot 消息房间格式发生变化，无法确认接收者。');
    if (room.aeon_id != null && room.aeon_id !== agentId)
      throw error('room_changed', '消息房间对应了另一位助理，已停止派发。');
    const botMembers = new Set(room.members.filter(m => m?.aeon_id === agentId).map(m => text(m.account_user_id || m.id)).filter(Boolean));
    const serviceId = text(profile.service_account_account_user_id);
    if (serviceId && room.members.some(m => (m?.account_user_id || m?.id) === serviceId)) botMembers.add(serviceId);
    if (!botMembers.size) throw error('dot_identity_unverified', '尚未从原房间确认这位 Dot 的身份，已停止派发。');
    return { profile, room, roomId, botMemberIds: [...botMembers], expectedKey };
  }
  async function history(roomId, { expectedKey, signal, after, limit = HISTORY_PAGE } = {}) {
    const size = Number.isInteger(limit) && limit >= 1 && limit <= HISTORY_PAGE ? limit : HISTORY_PAGE;
    const query = new URLSearchParams({ limit: String(size) }); if (after) query.set('after', after);
    const data = await request('/messaging/rooms/' + identifier(roomId) + '/messages?' + query, { expectedKey, signal });
    if (!Array.isArray(data.items)) throw error('dots_protocol_changed', '原 Dot 的消息历史格式发生变化。');
    return data;
  }
  return { request, listDots, target, history, async identity() { return identityKey(await auth()); } };
}

function messageText(message) {
  if (Array.isArray(message.raw_messages)) return message.raw_messages.filter(m => m?.author?.role === 'assistant' &&
    m.channel !== 'analysis' && m.metadata?.is_hidden !== true && m.metadata?.hidden !== true &&
    m.metadata?.is_visually_hidden_from_conversation !== true && (!m.recipient || m.recipient === 'all'))
    .flatMap(m => Array.isArray(m.content?.parts) ? m.content.parts.filter(p => typeof p === 'string') : []).join('\n\n');
  return text(message.content?.text);
}
function completionMarker(requestId) { return '[[ANTDESK_DONE:' + requestId + ']]'; }
function finalText(message, requestId) {
  if (message.generation?.status === 'in_progress') return null;
  const value = messageText(message).trimEnd(), marker = completionMarker(requestId);
  if (!value.endsWith(marker)) return null;
  const start = value.length - marker.length;
  if (start && value[start - 1] !== '\n') return null;
  const result = value.slice(0, start).trim(); return result || null;
}
function isBotMessage(message, target) {
  const sender = text(message.account_user_id);
  if (sender) return target.botMemberIds.includes(sender);
  return Array.isArray(message.raw_messages) && target.room.aeon_id === target.profile.id;
}
function requestText(run, requestId) {
  return ['事项：' + run.title, run.instruction, run.context ? '交接资料：\n' + run.context : '',
    '这是 AntDesk 派发给你的事项。请在该事项全部处理完成后的最终答复末尾，单独写一行：\n' + completionMarker(requestId) +
    '\n执行中的进度消息请保留为普通消息。这个唯一标记用于把最终结果归回本事项。'].filter(Boolean).join('\n\n');
}

export function createDotsAdapter(options = {}) {
  const auth = options.auth;
  const getAuth = options.getAuth || (auth?.getAuth ? auth.getAuth.bind(auth) : undefined);
  const browser = options.fetchImpl ? null : createChromeDotsFetch(options);
  const client = createDotsClient({ ...options, getAuth, fetchImpl: options.fetchImpl || browser.fetch });
  const active = new Map(), botLeases = new Map(); let closed = false, blocked = null;
  const pollMs = options.pollMs ?? 3000, maxPollMs = options.maxPollMs ?? 30 * 60 * 1000;
  const now = options.now || Date.now;
  const blockedCacheTtlMs = options.blockedCacheTtlMs ?? 30000;
  const maxReadPages = options.maxReadPages ?? 20;
  const metadata = { id: ID, protocol: ID, name: '原 Dots', official: false, authenticationOfficial: true, installed: true, sourceVersion: '26.1027.3384.0' };
  function remember(value, key) {
    const failure = publicError(value);
    if (failure.blocked && key) blocked = { key, code: failure.code, message: failure.publicMessage, at: now() };
    return failure;
  }
  function cachedBlock(key) {
    if (!blocked) return null;
    if (blocked.key !== key || now() - blocked.at >= blockedCacheTtlMs) { blocked = null; return null; }
    return blocked;
  }
  async function status({ agentId, refresh = false } = {}) {
    let key;
    try {
      const authState = await (options.authStatus?.() || auth?.status?.());
      if (authState && authState.readiness !== 'ready') {
        blocked = null;
        const diagnostic = authDiagnostic(authState.diagnostic);
        return { ...metadata, installed: authState.installed !== false, version: text(authState.version),
          readiness: authState.readiness, message: text(authState.message), ...(diagnostic ? { diagnostic } : {}) };
      }
      key = await client.identity();
      if (refresh === true) blocked = null;
      const held = cachedBlock(key);
      if (held) return { ...metadata, readiness: 'blocked', reason: held.code, message: held.message, connectionIdentity: key };
      if (!placeholder(agentId)) {
        const selected = await client.target(agentId, { expectedKey: key });
        return { ...metadata, readiness: 'ready', agentId, sessionId: selected.roomId, connectionIdentity: key,
          message: '已确认原 Dot 和既有消息房间。不会读取房间里已有的对话；派发后只取这次事项的回复。' };
      }
      const directory = await client.listDots({ expectedKey: key });
      const available = directory.items.filter(dot => !dot.status || dot.status === 'active');
      return { ...metadata, readiness: available.length ? 'ready' : 'needs_agent_connection', connectionIdentity: key,
        message: available.length ? '官方登录与原 Dots 目录已验证，请选择你原有的 omdot。' : '账号登录有效，但没有读到可用的原 Dot。请确认原助理所在账号。' };
    } catch (value) {
      const failure = remember(value, key);
      let connectionIdentity;
      // A failed request can race logout/account switching. Never publish the
      // identity captured before that request unless it is still authorized.
      if (key && !['needs_login', 'account_changed', 'account_identity_missing', 'invalid_auth'].includes(failure.code)) {
        try { if (await client.identity() === key) connectionIdentity = key; } catch {}
      }
      if (!connectionIdentity) blocked = null;
      return { ...metadata, readiness: failure.code === 'needs_login' ? 'needs_login' : failure.blocked ? 'blocked' : failure.code === 'needs_room' ? 'needs_agent_connection' : 'unavailable', reason: failure.code, message: failure.publicMessage,
        ...(connectionIdentity ? { connectionIdentity } : {}) };
    }
  }
  async function login(action, body) {
    if (action === 'start' || action === 'logout') blocked = null;
    if (action === 'logout') for (const controller of active.values()) controller.abort();
    const handler = options.loginAction || (auth?.login ? auth.login.bind(auth) : undefined);
    if (!handler) {
      if (action === 'status') {
        try { await client.identity(); return { state: 'ready' }; }
        catch { return { state: 'idle' }; }
      }
      throw error('login_unavailable', '官方登录组件尚未就绪，请检查 Codex 运行时。');
    }
    return handler(action, body);
  }
  async function agents() {
    const key = await client.identity(), data = await client.listDots({ expectedKey: key });
    return { agents: data.items.filter(dot => !dot.status || dot.status === 'active').map(dot => ({ id: dot.id,
      name: text(dot.display_name) || '原 Dot', description: dot.scope === 'shared' ? '共享 Dot 的原会话' : 'ChatGPT 中的原有私人助理',
      sessionId: text(dot.messaging_room_id), threadId: text(dot.active_root_thread_id), scope: text(dot.scope) })), truncated: data.truncated };
  }
  async function sessions({ agentId } = {}) {
    if (placeholder(agentId)) return { sessions: [] };
    const selected = await client.target(agentId);
    return { sessions: [{ id: selected.roomId, title: (text(selected.profile.display_name) || '原 Dot') + ' · 原会话',
      threadId: text(selected.profile.active_root_thread_id) }] };
  }
  async function readAfter(selected, data, signal) {
    const items = [], seen = new Set();
    let after = text(data.anchorMessageId) || undefined;
    // No anchor yet: look once at the newest page for this dispatch's request id.
    // Do not follow cursors into the rest of the original room.
    const pageLimit = after ? maxReadPages : 1;
    for (let page = 0; page < pageLimit; page++) {
      const result = await client.history(selected.roomId, { expectedKey: data.accountKey, signal, after });
      const batch = result.items.filter(object);
      items.push(...batch);
      if (!after) return items;
      const cursor = result.next_cursor ?? (batch.length >= HISTORY_PAGE ? text(batch.at(-1)?.id) : '');
      if (!cursor || batch.length === 0) return items;
      if (cursor === after || seen.has(cursor)) throw error('dots_history_changed', '原会话分页发生变化，请在官方应用检查后恢复。');
      seen.add(cursor); after = cursor;
    }
    throw error('dots_history_window_large', '这次事项的新回复较多，暂时无法可靠归档。已保留发送编号，没有继续翻原会话。');
  }
  async function monitor(run, emit, selected, controller) {
    const data = run.runtimeData, signal = controller.signal, started = Date.now();
    let anchor = data.anchorMessageId || '', failures = 0, lastProgress = '';
    const baseline = new Set(data.baselineIds || []), shown = new Map();
    while (!signal.aborted && !closed && Date.now() - started < maxPollMs) {
      try {
        const items = await readAfter(selected, data, signal); failures = 0;
        const echo = items.find(m => m.request_id === data.requestId && !isBotMessage(m, selected));
        if (echo && typeof echo.id === 'string') {
          if (anchor && anchor !== echo.id) throw error('dots_correlation_changed', '原会话返回了冲突的发送编号，已停止自动归档。');
          if (!anchor) { anchor = echo.id; data.anchorMessageId = anchor; emit({ type: 'checkpoint', data: { anchorMessageId: anchor } }); }
          if (run.deliveryStatus !== 'accepted') { run.deliveryStatus = 'accepted'; emit({ type: 'started', sessionId: selected.roomId, turnId: anchor }); }
        }
        if (anchor) {
          const attributed = new Set([anchor]);
          for (const message of items) {
            if (typeof message.id !== 'string' || baseline.has(message.id) || message.deleted_at || !isBotMessage(message, selected)) continue;
            const completed = finalText(message, data.requestId);
            const related = attributed.has(message.reply_to?.message_id) || attributed.has(message.reply_root_message_id);
            if (related) attributed.add(message.id);
            if (related || completed) {
              const visible = completed ?? messageText(message);
              if (visible && shown.get(message.id) !== visible) {
                shown.set(message.id, visible); emit({ type: 'message', id: message.id, role: 'assistant', text: visible, complete: completed != null });
              }
            }
            if (completed) {
              emit({ type: 'checkpoint', data: { finalMessageId: message.id } });
              emit({ type: 'complete', text: completed, sessionId: selected.roomId, turnId: anchor }); return;
            }
          }
        }
        const progress = anchor ? '原 Dot 已接收事项，正在等待这项任务的最终答复…' : '正在按原发送编号确认消息是否送达，没有重复发送…';
        if (progress !== lastProgress) { emit({ type: 'progress', text: progress }); lastProgress = progress; }
      } catch (value) {
        if (signal.aborted || closed) return;
        const failure = remember(value, data.accountKey); failures++;
        if (failure.blocked || ['needs_login', 'account_changed', 'dot_unavailable', 'dots_correlation_changed', 'dots_protocol_changed', 'dots_history_changed', 'dots_history_window_large'].includes(failure.code) || failures >= 3) {
          emit({ type: 'interrupted', message: failure.publicMessage, deliveryStatus: run.deliveryStatus || 'unknown' }); return;
        }
      }
      try { await delay(pollMs, undefined, { signal }); } catch { return; }
    }
    if (!signal.aborted && !closed) emit({ type: 'interrupted', message: '还没有收到与本事项匹配的最终答复。已保留原会话，可以继续恢复读取。', deliveryStatus: run.deliveryStatus || 'unknown' });
  }
  async function execute(run, emit, recovering) {
    if (closed) return;
    if (active.has(run.id)) return;
    if (botLeases.has(run.agentId) && botLeases.get(run.agentId) !== run.id) {
      emit({ type: 'failed', message: '这位原 Dot 正在处理 AntDesk 中的另一事项，请等待完成后再派发。', deliveryStatus: 'rejected' }); return;
    }
    const controller = new AbortController(); active.set(run.id, controller); botLeases.set(run.agentId, run.id);
    let dispatched = recovering, key;
    try {
      key = await client.identity();
      const held = cachedBlock(key);
      if (held && !recovering) throw error(held.code, held.message, { blocked: true });
      if (recovering && (!UUID.test(run.runtimeData?.requestId || '') || !run.runtimeData?.accountKey)) {
        emit({ type: 'interrupted', message: '缺少原发送编号，无法安全恢复。请检查原 Dot 会话；AntDesk 没有重新发送任务。' }); return;
      }
      if (recovering && key !== run.runtimeData.accountKey) throw error('account_changed', '请重新登录原账号后恢复这个事项，不能把其他账号的回复归入本任务。');
      const selected = await client.target(run.agentId, { expectedKey: key, sessionId: run.sessionId, signal: controller.signal });
      run.sessionId = selected.roomId;
      if (!recovering) {
        const requestId = randomUUID(), message = requestText(run, requestId);
        const data = { accountKey: key, requestId, sentAt: Date.now() };
        run.runtimeData = data;
        emit({ type: 'checkpoint', sessionId: selected.roomId, turnId: requestId, data });
        // Only user dispatch reaches this POST. Login, discovery and probes are GET-only.
        emit({ type: 'message', id: requestId, role: 'user', text: ['事项：' + run.title, run.instruction, run.context ? '交接资料：\n' + run.context : ''].filter(Boolean).join('\n\n'), complete: true });
        try {
          const accepted = await client.request('/messaging/rooms/' + identifier(selected.roomId) + '/messages', {
            method: 'POST', expectedKey: key, signal: controller.signal, onDispatch: () => { dispatched = true; },
            body: { content: { text: message }, request_id: requestId, idempotency_token: requestId, timezone_offset_min: new Date().getTimezoneOffset() },
          });
          if (!text(accepted.id) || accepted.request_id && accepted.request_id !== requestId)
            throw error('dots_send_unconfirmed', '原 Dots 的发送回执无法关联，正在按原编号查询。', { deliveryUnknown: true });
          data.anchorMessageId = accepted.id; run.deliveryStatus = 'accepted';
          emit({ type: 'checkpoint', data: { anchorMessageId: accepted.id } });
          emit({ type: 'started', sessionId: selected.roomId, turnId: accepted.id });
        } catch (value) {
          const failure = remember(value, key);
          const rejected = !dispatched || !failure.deliveryUnknown && failure.httpStatus >= 400 && failure.httpStatus < 500 && failure.httpStatus !== 408;
          if (rejected || failure.blocked) { emit({ type: 'failed', message: failure.publicMessage, deliveryStatus: 'rejected' }); return; }
          run.deliveryStatus = 'unknown'; emit({ type: 'interrupted', message: '暂时不能确认原 Dot 是否收到事项，正在按原发送编号查询；不会重复发送。', deliveryStatus: 'unknown' });
        }
      }
      await monitor(run, emit, selected, controller);
    } catch (value) {
      if (!controller.signal.aborted && !closed) {
        const failure = remember(value, key);
        emit({ type: dispatched ? 'interrupted' : 'failed', message: failure.publicMessage, deliveryStatus: dispatched ? run.deliveryStatus || 'unknown' : 'rejected' });
      }
    } finally {
      active.delete(run.id); if (botLeases.get(run.agentId) === run.id) botLeases.delete(run.agentId);
    }
  }
  return { id: ID, protocol: ID, status, login, agents, sessions,
    start: (run, emit) => execute(run, emit, false), recover: (run, emit) => execute(run, emit, true),
    async cancel(run) { active.get(run.id)?.abort(); return { remoteStopped: false }; },
    async close() { closed = true; for (const controller of active.values()) controller.abort(); await browser?.close(); await auth?.close?.(); },
  };
}

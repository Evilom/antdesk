import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { BridgeError } from '../lib/util.mjs';
import { StdioRpc, isolatedRuntimeEnv } from './stdio-rpc.mjs';

const ID = 'muse-code';
const VERSION = '1.4.14';
export const MUSE_SCHEMA_FINGERPRINT = 'sha256:c94c3d1f2f51e6424074b9ec43eac3eedcf532d3dcd77351ec1383a87d3049c6';
const text = (value, limit = 262144) => typeof value === 'string' ? value.slice(0, limit) : '';
const issue = (code, message) => new BridgeError(409, code, message);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export function museCommandId() {
  const bytes = randomBytes(16);
  bytes.writeUIntBE(Date.now(), 0, 6);
  bytes[6] = (bytes[6] & 15) | 0x70;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Muse Code 1.4.14 MSP, with the official CLI owning its login. */
export function createMuseAdapter(options) {
  const { projectRoot, dataDir, toolsDir } = options;
  const binary = path.join(toolsDir, 'muse', process.platform === 'win32' ? 'muse.exe' : 'muse');
  const profile = path.join(dataDir, 'profile');
  // Verified against the pinned Windows CLI: XDG_CONFIG_HOME is honored and
  // auth lives under its muse/ child. MUSE_HOME/MUSE_AUTH_PATH are ignored.
  const authFile = path.join(profile, 'muse', 'auth.json');
  const spawnProcess = options.spawnProcess || spawn;
  const makeTransport = options.transportFactory || (settings => new StdioRpc(settings));
  const getConfig = options.getConfig || (() => ({}));
  const setConfig = options.setConfig || (() => {});
  const active = new Map();
  const sessionRuns = new Map();
  const pendingAttention = new Map();
  const cancelledRuns = new Set();
  let connection = null, connecting = null, hostInfo = null, closed = false, hostGeneration = 0;
  let loginProcess = null, loginState = { state: 'idle', message: '请登录 Muse Code。' };
  let loginOutput = '', loginDeadline = null, keyProcess = null, keyUpdate = null, credentialGeneration = 0;
  let credentialRejected = false;

  fs.mkdirSync(path.dirname(authFile), { recursive: true, mode: 0o700 });
  const environment = () => isolatedRuntimeEnv(profile, {
    XDG_CONFIG_HOME: profile, XDG_DATA_HOME: path.join(profile, 'data'),
  });
  const installed = () => options.transportFactory ? true : fs.existsSync(binary);

  function authMetadata() {
    if (options.offlineEcho === true) return { valid: true, offline: true };
    // Only this app-owned credential file is inspected. No token is returned or logged.
    try {
      const stat = fs.statSync(authFile);
      if (!stat.isFile() || stat.size > 256 * 1024) return { valid: false };
      const record = JSON.parse(fs.readFileSync(authFile, 'utf8'));
      const meta = record.providers?.meta;
      if (!meta) return { valid: false };
      // The real 1.4.14 CLI writes flat provider records. API keys omit the
      // discriminator; its OAuthTokens schema also has access_token,
      // refresh_token, expires_at and an optional derived api_key. A key wins,
      // and renewal remains the official runtime's responsibility.
      if (meta.mechanism !== undefined && !['oauth', 'api_key', 'apiKey'].includes(meta.mechanism)) return { valid: false };
      const present = value => typeof value === 'string' && !!value.trim();
      const hasKey = present(meta.api_key ?? meta.apiKey);
      if (!hasKey && !present(meta.access_token)) return { valid: false };
      const expiry = meta.expires_at ?? meta.expiresAt ?? meta.expires_at_ms;
      let expiresAt;
      if (expiry !== undefined && expiry !== null) {
        const number = typeof expiry === 'number' ? expiry : /^\d+(?:\.\d+)?$/.test(String(expiry)) ? Number(expiry) : Date.parse(expiry);
        expiresAt = number < 1e12 ? number * 1000 : number;
        if ((!Number.isFinite(expiresAt) || expiresAt <= Date.now() + 30000) && !hasKey && !present(meta.refresh_token)) return { valid: false, expired: true };
      }
      return { valid: !credentialRejected, expiresAt };
    } catch { return { valid: false }; }
  }

  async function status() {
    const exists = installed();
    const auth = authMetadata();
    return { id: ID, protocol: ID, name: 'Muse Code', official: true, installed: exists,
      readiness: !exists ? 'needs_install' : auth.valid ? 'ready' : 'needs_login',
      version: hostInfo?.serverInfo?.version || (exists ? VERSION : undefined),
      message: !exists ? '尚未安装官方 Muse Code 运行时。' : auth.offline ? 'Muse 官方离线回声测试模式。' : auth.valid
        ? '本应用的 Muse 登录资料已保存，开始任务时由官方运行时校验授权。'
        : auth.expired ? 'Muse 登录资料已过期，请重新登录。' : '请使用 Meta 账号登录 Muse Code，或保存官方 Meta API Key。' };
  }

  function takeLoginOutput(chunk) {
    // stdout/stderr chunks may split inside the URL or device code. Never
    // publish an unterminated URL fragment to the browser-opening UI.
    loginOutput = (loginOutput + String(chunk)).slice(-65536);
    const output = loginOutput.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
    const candidates = output.match(/https:\/\/[^\s<>"'\x1b]+(?=[\s<>"'\x1b])/g) || [];
    for (const candidate of candidates) {
      try {
        const url = new URL(candidate.replace(/[),.;]+$/, ''));
        if (url.href.length <= 4096 && url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
          && ['auth.meta.com', 'www.meta.ai', 'meta.ai'].includes(url.hostname)
          && ![...url.searchParams.keys()].some(name => /^(?:access_token|refresh_token|id_token|api_key|password|cookie|session_token)$/i.test(name))) {
          loginState.url = url.href;
          loginState.message = '请打开 Muse 官方登录页面完成授权。';
        }
      } catch {}
    }
    let code = /(?:user[_ ]code|verification code|confirm this code matches|code)\s*[:=]\s*([A-Z0-9]{4}(?:[- ][A-Z0-9]{4})?)(?=\s|[),.;])/i.exec(output)?.[1];
    if (!code && loginState.url) {
      const candidate = new URL(loginState.url).searchParams.get('code');
      if (candidate && /^[A-Z0-9]{4}(?:[- ][A-Z0-9]{4})?$/i.test(candidate)) code = candidate;
    }
    if (code) {
      loginState.userCode = code.toUpperCase().replace(/ /g, '-');
      loginState.message = `请在 Muse 官方登录页面确认验证码 ${loginState.userCode}。`;
    }
  }

  async function terminateChild(child) {
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve(); }, 1500);
      child.once('exit', finish);
      try { child.kill(); } catch { finish(); }
    });
  }
  async function stopLogin() {
    const child = loginProcess;
    loginProcess = null;
    clearTimeout(loginDeadline); loginDeadline = null; loginOutput = '';
    await terminateChild(child);
  }

  async function saveApiKey(apiKey, epoch) {
    await stopLogin();
    await closeHost();
    if (closed || epoch !== credentialGeneration) throw issue('configuration_cancelled', 'Muse 密钥保存已取消。');
    // The official executable alone writes its app-owned auth file. The key is
    // delivered through stdin, never command-line arguments, environment or a
    // second compatibility-service credential store.
    await new Promise((resolve, reject) => {
      let child, timer, settled = false;
      const finish = failure => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        const complete = () => {
          if (keyProcess === child) keyProcess = null;
          if (failure) reject(failure); else resolve();
        };
        if (failure && child) void terminateChild(child).then(complete); else complete();
      };
      try {
        child = spawnProcess(binary, ['auth', 'set', '--api-key-stdin'], {
          cwd: profile, env: environment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { finish(issue('runtime_unavailable', 'Muse 官方密钥保存进程未能启动。')); return; }
      keyProcess = child;
      child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {});
      child.once('error', () => finish(issue('runtime_unavailable', 'Muse 官方密钥保存进程未能启动。')));
      child.once('exit', code => finish(code === 0 ? null : issue('api_key_save_failed', 'Muse 官方运行时没有保存密钥，请检查密钥格式后重试。')));
      child.stdin?.on('error', () => finish(issue('api_key_save_failed', '无法向 Muse 官方运行时提交密钥，请重试。')));
      timer = setTimeout(() => {
        finish(issue('api_key_save_timeout', 'Muse 官方密钥保存超时，请重试。'));
      }, options.apiKeyTimeoutMs ?? 30000);
      if (!child.stdin) { finish(issue('api_key_save_failed', 'Muse 官方运行时没有提供密钥输入通道。')); return; }
      child.stdin.end(apiKey + '\n');
    });
    if (closed || epoch !== credentialGeneration) throw issue('configuration_cancelled', 'Muse 密钥保存已取消。');
    credentialRejected = false;
    if (!authMetadata().valid) throw issue('api_key_not_saved', 'Muse 官方运行时尚未在本应用目录保存可识别的密钥资料。');
    loginState = { state: 'ready', browserOpened: false, message: 'Muse 官方 API Key 已保存，提交任务时由官方运行时验证权限。' };
  }

  async function login(action = 'start') {
    if (action === 'status') {
      if (loginProcess) return { ...loginState };
      if (authMetadata().valid) return { state: 'ready', message: 'Muse 登录资料已保存。', browserOpened: true };
      return { ...loginState };
    }
    if (action === 'cancel') { await stopLogin(); loginState = { state: 'idle', message: '已取消 Muse 登录。' }; return { ...loginState }; }
    if (action === 'logout') {
      credentialGeneration++;
      await stopLogin();
      await terminateChild(keyProcess);
      if (keyUpdate) await keyUpdate.catch(() => {});
      await closeHost();
      try { fs.unlinkSync(authFile); } catch (error) { if (error.code !== 'ENOENT') throw issue('logout_failed', '无法清除本应用的 Muse 登录资料。'); }
      credentialRejected = false;
      loginState = { state: 'idle', message: '已退出本应用的 Muse 账号。' };
      return { ...loginState };
    }
    if (closed) throw issue('runtime_closed', 'Muse 连接已关闭。');
    if (!installed()) throw issue('runtime_missing', '请先安装 Muse 官方运行时。');
    if (keyUpdate) throw issue('configuration_busy', '正在保存 Muse 官方 API Key，请稍后再登录。');
    if (loginProcess) return { ...loginState };
    credentialRejected = false;
    loginOutput = '';
    loginState = { state: 'pending', message: '正在向 Muse 官方运行时请求登录页面。', browserOpened: false };
    const child = spawnProcess(binary, ['login'], { cwd: profile, env: environment(), shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    loginProcess = child;
    child.stdout?.setEncoding?.('utf8'); child.stderr?.setEncoding?.('utf8');
    const receiveLoginOutput = chunk => { if (loginProcess === child) takeLoginOutput(chunk); };
    child.stdout?.on('data', receiveLoginOutput);
    child.stderr?.on('data', receiveLoginOutput);
    child.once('error', () => {
      if (loginProcess !== child) return;
      loginProcess = null;
      clearTimeout(loginDeadline); loginDeadline = null; loginOutput = '';
      loginState = { state: 'failed', browserOpened: false, message: 'Muse 官方登录进程未能启动，请重试。',
        diagnostic: { stage: 'runtime', code: 'runtime_unavailable', retryable: false } };
    });
    child.once('exit', code => {
      if (loginProcess !== child) return;
      loginProcess = null;
      clearTimeout(loginDeadline); loginDeadline = null; loginOutput = '';
      loginState = code === 0 && authMetadata().valid
        ? { state: 'ready', message: 'Muse 登录资料已保存。', browserOpened: true }
        : code === 0 ? { state: 'failed', message: '官方登录流程已结束，但尚未找到可识别的本应用登录资料，请重试。',
          diagnostic: { stage: 'storage', code: 'credential_not_saved', retryable: true } }
        : { state: 'failed', message: 'Muse 登录未完成，请重新发起官方登录。',
          diagnostic: { stage: 'authorization', code: 'authorization_incomplete', retryable: true } };
      // A new host must load the credentials the CLI just saved.
      if (code === 0) void closeHost();
    });
    // Consume stdin errors without ever surfacing process diagnostics.
    child.stdin?.on('error', () => {});
    loginDeadline = setTimeout(() => {
      if (loginProcess !== child) return;
      void stopLogin();
      loginState = { state: 'failed', message: 'Muse 官方授权等待已结束，请重新发起登录。',
        diagnostic: { stage: 'authorization', code: 'login_timeout', retryable: true } };
    }, options.loginTimeoutMs ?? 10 * 60 * 1000);
    loginDeadline.unref?.();
    await delay(250);
    return { ...loginState };
  }

  function finish(context, terminal, message) {
    if (context.finished) return;
    context.finished = true;
    context.terminal = terminal;
    context.emit({ type: 'checkpoint', data: { sessionId: context.sessionId, turnId: context.turnId, cursor: context.cursor, terminal } });
    if (terminal === 'completed') context.emit({ type: 'complete', text: context.finalText || '', sessionId: context.sessionId, turnId: context.turnId });
    else if (terminal === 'failed') context.emit({ type: 'failed', message: message || 'Muse 官方运行时报告任务未完成。', deliveryStatus: context.acknowledged ? 'accepted' : 'unknown' });
    else context.emit({ type: 'interrupted', message: message || 'Muse 会话已中断，可恢复读取原会话。', deliveryStatus: context.acknowledged ? 'accepted' : 'unknown' });
    for (const [id, attention] of pendingAttention) if (attention.context === context) pendingAttention.delete(id);
    context.resolve();
  }

  function presentAttention(context, method, params) {
    if (method.startsWith('approval/')) {
      const old = [...pendingAttention.values()].find(row => row.context === context && row.params.approvalId === params.approvalId);
      const current = { ...old?.params, ...params };
      if (!Array.isArray(current.availableChoices) || !current.currentRequirementId) return;
      const suffix = createHash('sha256').update(JSON.stringify(current.currentRequirementId)).digest('hex').slice(0, 12);
      const id = `${current.approvalId}:${suffix}`;
      if (old?.id === id && method !== 'approval/updated') return;
      if (old) pendingAttention.delete(old.id);
      const attention = { id, kind: 'approval', title: `Muse 请求确认：${text(current.toolName || current.subject?.kind || '操作', 100)}`,
        description: text(current.subject?.command || current.subject?.url || current.subject?.target || current.rawArgs || current.reviewerReason, 5000),
        options: current.availableChoices.map(choice => ({ id: choice.choiceId, label: text(choice.label, 500) })) };
      pendingAttention.set(id, { id, kind: 'approval', params: current, context, attention });
      context.attentionId = id;
      context.emit({ type: 'attention', attention });
    } else {
      const id = params.userInputId;
      if (!id || pendingAttention.has(id)) return;
      const attention = { id, kind: 'input', title: 'Muse 需要补充信息',
        description: (params.questions || []).map(question => question.question).join('\n'),
        fields: (params.questions || []).map(question => ({ id: question.id, label: question.question, type: 'text', required: true,
          options: (question.options || []).map(option => ({ id: option.label, label: option.label })) })) };
      pendingAttention.set(id, { id, kind: 'input', params, context, attention });
      context.attentionId = id;
      context.emit({ type: 'attention', attention });
    }
  }

  function item(context, current, complete = false) {
    if (!current?.itemId || (current.turnId && context.turnId && current.turnId !== context.turnId)) return;
    const previous = context.items.get(current.itemId);
    if (previous && current.revision < previous.revision) return;
    context.items.set(current.itemId, { ...current });
    if (current.kind === 'agentMessage') {
      context.finalText = text(current.text);
      context.emit({ type: 'message', id: current.itemId, role: 'assistant', text: text(current.text), complete });
    } else if (current.kind === 'toolCall') {
      context.emit({ type: 'message', id: current.itemId, role: 'tool', text: text(current.visibleOutput || current.fallbackText || current.tool, 16384), complete });
    }
  }

  function receive(context, method, params) {
    if (context.finished) return;
    if (!context.acknowledged) { context.frames.push([method, params]); return; }
    // A re-issued approval/request keeps the opening cursor while its current
    // requirement changes. Its requirement guard, not that cursor, deduplicates it.
    if (params.viewCursor && !method.endsWith('/request')) {
      const key = `${method}:${params.viewCursor}`;
      if (context.seen.has(key)) return;
      context.seen.add(key);
      if (context.seen.size > 20000) context.seen.delete(context.seen.values().next().value);
      context.cursor = params.viewCursor;
    }
    if (['item/started', 'item/updated', 'item/completed'].includes(method)) item(context, params.item, method === 'item/completed');
    else if (method === 'item/delta') {
      const current = context.items.get(params.itemId);
      if (current?.kind === 'agentMessage' && (!params.field || params.field === 'text')) {
        current.text = text((current.text || '') + text(params.delta));
        context.finalText = current.text;
        context.emit({ type: 'message', id: current.itemId, role: 'assistant', text: current.text, complete: false });
      }
    } else if (['approval/request', 'approval/requested', 'approval/updated', 'userInput/request', 'userInput/requested'].includes(method)) {
      if (!params.turnId || !context.turnId || params.turnId === context.turnId) presentAttention(context, method, params);
    } else if (method === 'approval/resolved' || method === 'userInput/settled') {
      let clearedCurrent = false;
      for (const [id, attention] of pendingAttention) {
        const matches = (params.approvalId && attention.params.approvalId === params.approvalId) || (params.userInputId && attention.params.userInputId === params.userInputId);
        if (attention.context === context && matches) { pendingAttention.delete(id); if (context.attentionId === id) clearedCurrent = true; }
      }
      if (clearedCurrent) {
        const next = [...pendingAttention.values()].find(attention => attention.context === context);
        context.attentionId = next?.id;
        context.emit(next ? { type: 'attention', attention: next.attention } : { type: 'attention-cleared' });
      }
    } else if (method === 'turn/completed' && params.turnId === context.turnId) {
      if (params.error?.kind === 'authRequired') credentialRejected = true;
      finish(context, params.terminal, params.error?.kind === 'authRequired' ? 'Muse 授权已失效，请重新登录后再提交任务。' : params.terminal === 'failed' ? 'Muse 官方运行时未能完成这轮任务，请恢复原会话查看已返回内容。' : undefined);
    } else if (method === 'view/gap') {
      void refresh(context).catch(() => finish(context, 'interrupted', 'Muse 事件流中断，请恢复读取原会话。'));
    } else if (method === 'turn/modelRetryScheduled') context.emit({ type: 'progress', text: 'Muse 正在重试官方模型连接。' });
  }

  function route(method, params) {
    const context = sessionRuns.get(params.sessionId);
    if (context) receive(context, method, params);
  }

  async function host() {
    if (closed) throw issue('runtime_closed', 'Muse 连接已关闭。');
    if (connection && !connection.closed) return connection;
    if (connecting) return connecting;
    connecting = (async () => {
      const generation = hostGeneration;
      const args = ['serve', '--contributor-mode', 'off', '--disable-shell', '--disable-write', '--sandbox-network', 'proxy-only'];
      if (options.offlineEcho === true) args.push('--provider', 'echo');
      const rpc = makeTransport({ command: binary, args, cwd: profile, env: environment(), spawnProcess });
      rpc.on('notification', route);
      rpc.on('disconnect', () => { if (connection === rpc) connection = null; for (const context of active.values()) finish(context, 'interrupted', 'Muse 官方运行时连接已断开，可恢复读取原会话。'); });
      rpc.requestHandler = async (method, params) => {
        if (!['approval/request', 'userInput/request'].includes(method)) throw Object.assign(new Error('Unsupported request'), { code: -32601 });
        route(method, params);
        return {}; // MSP presentation receipt; decisions use approval/decide.
      };
      try {
        await rpc.open();
        hostInfo = await rpc.call('initialize', { clientInfo: { name: 'antdesk', title: 'AntDesk', version: '1.0.0' }, capabilities: { userInputDialogs: true } });
        if (hostInfo?.schema?.fingerprint !== MUSE_SCHEMA_FINGERPRINT) throw issue('protocol_mismatch', 'Muse MSP 版本与已验证的适配器不一致，请更新运行时适配器。');
        const relativeHome = typeof hostInfo.museHome === 'string' ? path.relative(profile, hostInfo.museHome) : '..';
        if (relativeHome === '..' || relativeHome.startsWith('..' + path.sep) || path.isAbsolute(relativeHome)) throw issue('profile_not_isolated', 'Muse 未使用本应用专属资料目录，已停止连接。');
        await rpc.notify('initialized');
        if (closed || generation !== hostGeneration) throw issue('runtime_closed', 'Muse 连接已关闭。');
        connection = rpc;
        return rpc;
      } catch (error) { await rpc.close(); throw error; }
    })().finally(() => { connecting = null; });
    return connecting;
  }

  function contextFor(run, emit, sessionId) {
    if (sessionRuns.has(sessionId)) throw issue('session_busy', '这个 Muse 会话已有任务正在执行，请等待结束。');
    const context = { run, emit, sessionId, turnId: run.turnId || run.runtimeData?.turnId || '', items: new Map(), seen: new Set(), frames: [], acknowledged: false, finished: false, finalText: '', cursor: '' };
    context.done = new Promise(resolve => { context.resolve = resolve; });
    active.set(run.id, context); sessionRuns.set(sessionId, context);
    return context;
  }
  function acknowledge(context, turnId) {
    context.turnId = turnId;
    context.acknowledged = true;
    context.emit({ type: 'started', sessionId: context.sessionId, turnId, cursor: context.cursor });
    context.emit({ type: 'checkpoint', data: { sessionId: context.sessionId, turnId, cursor: context.cursor } });
    const queued = context.frames.splice(0);
    for (const [method, params] of queued) receive(context, method, params);
  }
  function release(context) { active.delete(context.run.id); if (sessionRuns.get(context.sessionId) === context) sessionRuns.delete(context.sessionId); }
  async function refresh(context) {
    const rpc = await host();
    const snapshot = await rpc.call('session/read', { sessionId: context.sessionId, excludeItems: false });
    const items = snapshot.history?.items || snapshot.history?.snapshot?.state?.items || [];
    if (!context.turnId) {
      const submitted = items.find(current => current.kind === 'userMessage' && current.commandId === context.run.runtimeData?.turnCommandId);
      if (submitted?.turnId) context.turnId = submitted.turnId;
    }
    for (const current of items) if (context.turnId && current.turnId === context.turnId) item(context, current, current.status !== 'inProgress');
    context.cursor = snapshot.viewCursor;
    if (snapshot.lastTurn?.turnId === context.turnId) finish(context, snapshot.lastTurn.terminal);
    return snapshot;
  }

  async function start(run, emit) {
    if (cancelledRuns.has(run.id)) { emit({ type: 'interrupted', message: 'Muse 任务已在发送前取消。', deliveryStatus: 'not_sent' }); return; }
    if ((await status()).readiness !== 'ready') throw issue('login_required', '请先登录 Muse Code。');
    const rpc = await host();
    const sessionId = run.sessionId || museCommandId();
    const context = contextFor(run, emit, sessionId);
    const sessionCommandId = museCommandId(), turnCommandId = museCommandId();
    emit({ type: 'checkpoint', data: { sessionId, sessionCommandId, turnCommandId } });
    try {
      if (cancelledRuns.has(run.id)) { finish(context, 'cancelled', 'Muse 任务已在发送前取消。'); return; }
      const config = getConfig();
      if (run.sessionId) await rpc.call('session/resume', { commandId: sessionCommandId, sessionId, excludeItems: true });
      else {
        const workingDirectory = run.workingDirectory || path.join(projectRoot, '.antdesk', 'assistant-workspaces', run.id);
        fs.mkdirSync(workingDirectory, { recursive: true });
        const started = await rpc.call('session/start', { commandId: sessionCommandId, sessionId, workspaceRoot: workingDirectory, approvalMode: 'promptUnmatched', ...(config.model ? { modelId: config.model } : {}) });
        context.cursor = started.viewCursor;
      }
      const instruction = [text(run.instruction, 40000), run.context ? `\n任务背景：\n${text(run.context)}` : ''].join('\n');
      if (cancelledRuns.has(run.id)) { finish(context, 'cancelled', 'Muse 任务已在发送前取消。'); return; }
      const accepted = await rpc.call('turn/start', { commandId: turnCommandId, sessionId, input: [{ type: 'text', text: instruction }] });
      if (accepted.status !== 'accepted' || !accepted.turnId) throw issue('invalid_receipt', 'Muse 未确认任务已接收，可恢复读取原会话。');
      acknowledge(context, accepted.turnId);
      if (cancelledRuns.has(run.id) && !context.finished) await cancel(run);
      await context.done;
    } catch (error) {
      finish(context, 'interrupted', error instanceof BridgeError ? error.message : '未收到 Muse 的完整确认，可恢复原会话；任务不会自动重发。');
    } finally { release(context); }
  }

  async function recover(run, emit) {
    if (active.has(run.id)) return active.get(run.id).done;
    const sessionId = run.sessionId || run.runtimeData?.sessionId;
    if (!sessionId) { emit({ type: 'interrupted', message: '尚无 Muse 会话编号，无法确认此前任务是否送达；不会自动重发。', deliveryStatus: 'unknown' }); return; }
    const context = contextFor(run, emit, sessionId);
    try {
      const snapshot = await refresh(context);
      if (context.finished) return;
      if (!context.turnId || snapshot.session?.activeTurnId !== context.turnId) {
        finish(context, 'interrupted', '已读取 Muse 原会话，尚未找到这轮任务的完成确认；不会自动重发。'); return;
      }
      const rpc = await host();
      const resumed = await rpc.call('session/resume', { commandId: museCommandId(), sessionId, excludeItems: true });
      acknowledge(context, context.turnId);
      if (resumed.lastTurn?.turnId === context.turnId) finish(context, resumed.lastTurn.terminal);
      else await context.done;
    } catch { finish(context, 'interrupted', '暂时无法恢复 Muse 原会话，可能仍由另一个官方进程持有。'); }
    finally { release(context); }
  }

  async function cancel(run) {
    cancelledRuns.add(run.id);
    const context = active.get(run.id);
    const sessionId = context?.sessionId || run.sessionId || run.runtimeData?.sessionId;
    const turnId = context?.turnId || run.turnId || run.runtimeData?.turnId;
    if (!sessionId || !turnId) return { remoteStopped: !context && run.deliveryStatus === 'pending' && !run.runtimeData?.sessionId, message: '待发送任务已取消；已发送任务会在收到官方接收编号后立即请求停止。' };
    try {
      const rpc = await host();
      await rpc.call('turn/interrupt', { commandId: museCommandId(), sessionId, turnId });
      if (context) await Promise.race([context.done, delay(1800)]);
      if (context?.terminal === 'cancelled') return { remoteStopped: true };
      const snapshot = await rpc.call('session/read', { sessionId, excludeItems: true });
      return { remoteStopped: snapshot.lastTurn?.turnId === turnId && snapshot.lastTurn?.terminal === 'cancelled', message: '已向 Muse 请求停止；以官方终止事件为准。' };
    } catch { return { remoteStopped: false, message: '停止请求未获得官方确认。' }; }
  }

  async function respond(run, body) {
    const pending = pendingAttention.get(body.attentionId);
    if (!pending || pending.context.run.id !== run.id) throw issue('attention_stale', 'Muse 的这条确认已变化，请恢复原会话后再答复。');
    const rpc = await host();
    const common = { commandId: museCommandId(), sessionId: pending.params.sessionId };
    if (pending.kind === 'approval') {
      const choice = pending.params.availableChoices.find(row => row.choiceId === body.decision);
      if (!choice) throw issue('invalid_decision', '请从 Muse 提供的确认选项中选择。');
      await rpc.call('approval/decide', { ...common, approvalId: pending.params.approvalId, requirementId: pending.params.currentRequirementId, choiceId: choice.choiceId,
        ...(choice.acceptsFeedback && body.text ? { feedback: text(body.text, 500) } : {}) });
    } else if (body.decision === 'cancel') await rpc.call('userInput/cancel', { ...common, userInputId: pending.params.userInputId });
    else {
      const provided = Array.isArray(body.answers) ? body.answers : pending.params.questions.map(question => ({ questionId: question.id, freeText: text(body.answers?.[question.id] ?? (pending.params.questions.length === 1 ? body.text : ''), 500) }));
      const answers = provided.map(answer => ({ questionId: String(answer.questionId || answer.id || ''),
        ...(typeof answer.freeText === 'string' ? { freeText: text(answer.freeText, 500) } : {}),
        ...(typeof answer.selectedLabel === 'string' ? { selectedLabel: answer.selectedLabel } : {}),
        ...(Array.isArray(answer.selectedLabels) ? { selectedLabels: answer.selectedLabels } : {}) }));
      if (answers.length !== pending.params.questions.length || answers.some(answer => !pending.params.questions.some(question => question.id === answer.questionId))) throw issue('invalid_answer', '请回答 Muse 提出的每个问题。');
      await rpc.call('userInput/answer', { ...common, userInputId: pending.params.userInputId, answers });
    }
    pendingAttention.delete(body.attentionId);
    return { ok: true, message: '已向 Muse 提交答复。' };
  }

  async function closeHost() { hostGeneration++; const current = connection; connection = null; if (current) await current.close(); }
  return { id: ID, protocol: ID, status, login, start, recover, cancel, respond,
    async configure(body = {}) {
      if (body.apiKey !== undefined) {
        if (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 4096 || /[\r\n\0]/.test(body.apiKey)) throw issue('invalid_api_key', 'Muse 官方 API Key 格式无效。');
        if (closed) throw issue('runtime_closed', 'Muse 连接已关闭。');
        if (!installed()) throw issue('runtime_missing', '请先安装 Muse 官方运行时。');
        if (keyUpdate) throw issue('configuration_busy', '正在保存 Muse 官方 API Key，请稍后再试。');
        const updating = saveApiKey(body.apiKey.trim(), ++credentialGeneration);
        keyUpdate = updating;
        try { await updating; } finally { if (keyUpdate === updating) keyUpdate = null; }
      }
      if (body.model !== undefined) {
        if (typeof body.model !== 'string' || body.model.length > 150 || /[\r\n\0]/.test(body.model)) throw issue('invalid_model', 'Muse 模型名称无效。');
        setConfig({ model: body.model.trim() });
      }
      return status();
    },
    async agents() { return { agents: [{ id: ID, name: 'Muse Code', description: '官方 Muse 本地助理；默认关闭 Shell 与写入工具。' }] }; },
    async sessions() {
      if (!installed()) return { sessions: [] };
      const result = await (await host()).call('session/list', { limit: 100 });
      return { sessions: (result.sessions || []).map(session => ({ id: session.sessionId, sessionId: session.sessionId, name: session.name || session.title || 'Muse 会话', status: session.status, updatedAt: session.updatedAt })) };
    },
    async close() { closed = true; credentialGeneration++; await stopLogin(); await terminateChild(keyProcess); if (keyUpdate) await keyUpdate.catch(() => {}); for (const context of active.values()) finish(context, 'interrupted', 'AntDesk 正在关闭 Muse 连接，可稍后恢复原会话。'); await closeHost(); },
  };
}

import fs from 'node:fs';
import path from 'node:path';
import { BridgeError } from '../lib/util.mjs';
import { StdioRpc } from './stdio-rpc.mjs';

export const CODEX_AUTH_VERSION = '0.166.0-alpha.5.1';
const issue = (code, message) => new BridgeError(409, code, message);
const validId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value);
const validPrincipal = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:@|/-]{0,511}$/.test(value);
export function codexHomesMatch(left, right, platform = process.platform) {
  if (platform !== 'win32') return path.resolve(left) === path.resolve(right);
  // Rust may return an extended Windows path while Node supplied a normal
  // drive/UNC path. These prefixes identify the same directory, not a second
  // profile. Never weaken this check to a prefix or parent-directory match.
  const normalize = value => path.win32.resolve(value.replace(/\//g, '\\')
    .replace(/^\\\\\?\\UNC\\/i, '\\\\').replace(/^\\\\\?\\/, '')).toLowerCase();
  return normalize(left) === normalize(right);
}

function processExited(child) { return child.exitCode !== null || (child.signalCode !== null && child.signalCode !== undefined); }
function waitForProcessExit(child, timeoutMs) {
  if (processExited(child)) return Promise.resolve(true);
  return new Promise(resolve => {
    const finish = exited => { clearTimeout(timer); child.removeListener('exit', onExit); resolve(exited); };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(processExited(child)), timeoutMs);
    child.once('exit', onExit);
    if (processExited(child)) finish(true);
  });
}
async function stopTransport(rpc) {
  await rpc.close();
  const child = rpc.child;
  if (!child?.pid || processExited(child)) return;
  // StdioRpc.close may return immediately after sending kill. Wait for the
  // actual process exit before releasing a Windows profile for cleanup/reuse.
  if (await waitForProcessExit(child, 1500)) return;
  try { child.kill('SIGKILL'); } catch {}
  if (!await waitForProcessExit(child, 1000)) throw issue('runtime_close_timeout', '官方登录进程尚未完全退出，请稍后重试。');
}

/** This is a child-process environment, never a mutation of the user's env. */
export function codexAuthEnvironment(profile, inherited = process.env) {
  const permitted = /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMSPEC|SYSTEMDRIVE|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_[A-Z_]+|TZ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i;
  const env = Object.fromEntries(Object.entries(inherited).filter(([name]) => permitted.test(name)));
  return { ...env, CODEX_HOME: profile, HOME: profile, USERPROFILE: profile,
    APPDATA: path.join(profile, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(profile, 'AppData', 'Local'),
    XDG_CONFIG_HOME: profile, XDG_DATA_HOME: path.join(profile, 'data'), XDG_CACHE_HOME: path.join(profile, 'cache') };
}

function authorizationUrl(value) {
  if (typeof value !== 'string' || value.length > 16384) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && (!url.port || url.port === '443')
      && ['auth.openai.com', 'chatgpt.com', 'www.chatgpt.com'].includes(url.hostname) ? url.href : null;
  } catch { return null; }
}

function tokenIdentity(token, accountResponse) {
  // The token comes only from our verified, app-owned official host. Decoding
  // its claims extracts routing identifiers; it is not an independent JWT
  // verification procedure and no token/claim is persisted or logged here.
  let authClaims = {}, subject;
  try {
    const parts = token.split('.');
    if (parts.length === 3 && /^[A-Za-z0-9_-]+$/.test(parts[1])) {
      const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      authClaims = payload?.['https://api.openai.com/auth'] || {};
      subject = payload?.sub;
    }
  } catch { /* A token without a stable principal cannot bind a Dot task safely. */ }
  const reportedAccountId = accountResponse?.workspaceRouting?.chatgptAccountId;
  const claimedAccountId = authClaims.chatgpt_account_id;
  if (validId(reportedAccountId) && validId(claimedAccountId) && reportedAccountId !== claimedAccountId) {
    throw issue('account_identity_mismatch', '官方登录账号正在切换，请等待完成后重试。');
  }
  const accountId = validId(reportedAccountId) ? reportedAccountId : validId(claimedAccountId) ? claimedAccountId : null;
  if (!accountId) throw issue('account_identity_missing', '官方登录尚未提供可用于 Dots 的账号标识，请重新连接。');
  const userId = [authClaims.chatgpt_user_id, authClaims.user_id, authClaims.account_user_id, subject].find(validPrincipal);
  // A workspace id can be shared by several people. Use the real token
  // principal (including its raw sub fallback), never a token hash or a made-up
  // user id, so refresh preserves identity and account switches cannot reuse a
  // previous person's task binding.
  if (!userId) throw issue('account_identity_missing', '官方登录尚未提供稳定用户标识，无法安全关联原 Dots，请重新连接。');
  return { accountId, userId };
}

const diagnostics = {
  runtime_missing: ['runtime', false], runtime_unavailable: ['runtime', true], runtime_closed: ['runtime', true], runtime_close_timeout: ['runtime', true],
  profile_not_isolated: ['runtime', false], protocol_mismatch: ['runtime', false],
  authorization_incomplete: ['authorization', true], invalid_authorization_url: ['authorization', false],
  login_timeout: ['authorization', true], auth_mode_unsupported: ['authorization', false],
  account_identity_missing: ['identity', false], account_identity_mismatch: ['identity', true],
  logout_failed: ['authorization', true], connection_failed: ['runtime', true],
};
function diagnostic(failure, fallback = 'connection_failed') {
  const code = Object.hasOwn(diagnostics, failure?.code) ? failure.code : fallback;
  const [stage, retryable] = diagnostics[code];
  return { stage, code, retryable };
}

/** Only a new AntDesk-owned Codex host supplies this login. This module never
 * reads auth.json, browser cookies, the desktop app's session, or the keyring.
 * getAuth is backend-only; its token must never be forwarded to the frontend. */
export function createDotsAuth(options) {
  const { dataDir, toolsDir } = options;
  if (!dataDir || !toolsDir) throw new TypeError('Dots authentication configuration is incomplete.');
  const profile = path.join(path.resolve(dataDir), 'codex-profile');
  const binary = options.binary || path.join(toolsDir, 'codex', process.platform === 'win32' ? 'codex.exe' : 'codex');
  const makeTransport = options.transportFactory || (settings => new StdioRpc(settings));
  const installed = () => !!options.transportFactory || fs.existsSync(binary);
  let connection = null, connecting = null, startingTransport = null, hostGeneration = 0, authGeneration = 0, closed = false;
  let flow = null, authQueue = Promise.resolve(), lastDiagnostic = null, cancellation = null, logoutOperation = null;
  let loginState = { state: 'idle', browserOpened: false, message: '请为 AntDesk 单独登录 ChatGPT，然后连接你的原 Dots。' };
  const snapshot = () => ({ ...loginState });
  const currentFlow = item => !closed && flow === item && item.generation === authGeneration;

  function prepareProfile() {
    fs.mkdirSync(path.dirname(profile), { recursive: true, mode: 0o700 });
    try {
      const entry = fs.lstatSync(profile);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw issue('profile_not_isolated', 'AntDesk 专用登录目录无效，已停止连接。');
    } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
    fs.mkdirSync(profile, { recursive: true, mode: 0o700 });
  }

  async function closeHost() {
    hostGeneration++;
    const current = connection, starting = startingTransport, pending = connecting;
    connection = null; startingTransport = null;
    const stopped = await Promise.allSettled([...new Set([current, starting].filter(Boolean))].map(stopTransport));
    if (pending) { try { await pending; } catch {} }
    const failure = stopped.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
  }
  function setFailure(failure, message) {
    lastDiagnostic = diagnostic(failure);
    loginState = { state: 'failed', browserOpened: false, message, diagnostic: lastDiagnostic };
  }
  async function completeLogin(item, success) {
    if (!currentFlow(item)) return;
    clearTimeout(item.timer);
    if (!success) {
      flow = null;
      setFailure({ code: 'authorization_incomplete' }, 'ChatGPT 官方登录未完成，请重新发起登录。');
      return;
    }
    try {
      const auth = await getAuth();
      if (!currentFlow(item)) return;
      flow = null;
      if (!auth) { setFailure({ code: 'auth_mode_unsupported' }, '官方服务尚未提供可用于 Dots 的 ChatGPT 登录，请重新连接。'); return; }
      lastDiagnostic = null;
      loginState = { state: 'ready', browserOpened: false, message: 'AntDesk 的 ChatGPT 登录已完成，正在核对原 Dots 的访问权限。' };
    } catch (failure) {
      if (currentFlow(item)) { flow = null; setFailure(failure, '官方登录已返回，但还不能确认 Dots 所需身份，请重试连接。'); }
    }
  }
  function notification(method, params = {}) {
    if (method !== 'account/login/completed' || !flow || !validId(params.loginId)) return;
    if (!flow.id) {
      // A fast browser callback can arrive before the login/start response.
      if (flow.early.size < 4) flow.early.set(params.loginId, params.success === true);
      return;
    }
    if (params.loginId === flow.id) void completeLogin(flow, params.success === true);
  }
  async function host() {
    if (closed) throw issue('runtime_closed', 'AntDesk 的 ChatGPT 登录服务已关闭。');
    if (!installed()) throw issue('runtime_missing', '尚未安装官方 Codex 登录组件。');
    if (connection && !connection.closed) return connection;
    if (connecting) return connecting;
    const generation = hostGeneration;
    connecting = (async () => {
      prepareProfile();
      const rpc = makeTransport({ command: binary,
        args: ['app-server', '--listen', 'stdio://', '-c', 'cli_auth_credentials_store="file"'],
        cwd: profile, env: codexAuthEnvironment(profile), spawnProcess: options.spawnProcess,
        requestTimeoutMs: options.requestTimeoutMs ?? 30000, maxFrameBytes: 2 * 1024 * 1024 });
      startingTransport = rpc;
      rpc.on('notification', (method, params) => { if (!closed && generation === hostGeneration) notification(method, params); });
      rpc.on('disconnect', () => {
        if (connection !== rpc) return;
        connection = null;
        if (flow) { clearTimeout(flow.timer); flow = null; authGeneration++; setFailure({ code: 'connection_failed' }, 'ChatGPT 官方登录连接已中断，请重新发起登录。'); }
      });
      rpc.requestHandler = async () => { throw Object.assign(new Error('Unsupported authentication-host request.'), { code: -32601 }); };
      try {
        await rpc.open();
        const info = await rpc.call('initialize', {
          clientInfo: { name: 'antdesk', title: 'AntDesk', version: options.appVersion || '2.19.5' },
          capabilities: { experimentalApi: true },
        });
        // Check before requesting any account or token information. A runtime
        // which ignored CODEX_HOME is never an acceptable credential source.
        if (typeof info?.codexHome !== 'string' || !path.isAbsolute(info.codexHome) || !codexHomesMatch(info.codexHome, profile)) {
          throw issue('profile_not_isolated', '官方登录服务未使用 AntDesk 专用目录，已停止读取账号。');
        }
        await rpc.notify('initialized');
        if (closed || generation !== hostGeneration) throw issue('runtime_closed', '官方登录服务已关闭。');
        connection = rpc;
        if (startingTransport === rpc) startingTransport = null;
        return rpc;
      } catch (failure) { if (startingTransport === rpc) startingTransport = null; try { await stopTransport(rpc); } catch {} throw failure instanceof BridgeError ? failure : issue('runtime_unavailable', '官方 Codex 登录组件未能启动，请重试。'); }
    })().finally(() => { connecting = null; });
    return connecting;
  }

  async function readAuth(refreshToken) {
    const generation = authGeneration;
    const rpc = await host();
    const account = await rpc.call('account/read', { refreshToken });
    if (closed || generation !== authGeneration) return null;
    if (account?.account?.type !== 'chatgpt') { lastDiagnostic = null; return null; }
    // account/read performs the optional refresh once. Never request external
    // host tokens, import an auth file or attach to an existing app-server.
    const result = await rpc.call('getAuthStatus', { includeToken: true, refreshToken: false });
    if (closed || generation !== authGeneration) return null;
    if (result?.authMethod !== 'chatgpt') { lastDiagnostic = diagnostic({ code: 'auth_mode_unsupported' }); return null; }
    const token = result.authToken;
    if (typeof token !== 'string' || !token || token.length > 65536 || /[\x00-\x20\x7f]/.test(token)) return null;
    const identity = tokenIdentity(token, account);
    lastDiagnostic = null;
    return { token, ...identity };
  }
  function getAuth({ refreshToken = false } = {}) {
    // Serialize token refreshes so the official rotating refresh token cannot
    // be used concurrently by two Dot reads. Tokens live only in this result.
    const operation = authQueue.catch(() => {}).then(() => readAuth(refreshToken === true));
    authQueue = operation.then(() => undefined, () => undefined);
    return operation.catch(failure => {
      if (failure instanceof BridgeError) throw failure;
      throw issue(failure?.code === -32601 ? 'protocol_mismatch' : 'connection_failed', '无法从官方登录服务确认 ChatGPT 身份，请重试连接。');
    });
  }

  async function status() {
    const exists = installed();
    if (!exists) return { installed: false, readiness: 'needs_install', message: '尚未安装官方 Codex 登录组件。' };
    try {
      const auth = await getAuth();
      return { installed: true, version: CODEX_AUTH_VERSION, readiness: auth ? 'ready' : 'needs_login',
        message: auth ? '已连接 AntDesk 专用 ChatGPT 登录，原 Dots 的可用性将由账号权限检查确认。'
          : '请为 AntDesk 单独登录 ChatGPT，再连接你的原 Dots。', ...(lastDiagnostic ? { diagnostic: lastDiagnostic } : {}) };
    } catch (failure) {
      return { installed: true, version: CODEX_AUTH_VERSION, readiness: 'needs_login',
        message: 'ChatGPT 官方登录服务暂时不可用，请重试连接。', diagnostic: diagnostic(failure) };
    }
  }
  async function performCancel() {
    const previous = flow; flow = null; authGeneration++;
    if (previous) clearTimeout(previous.timer);
    loginState = { state: 'idle', browserOpened: false, message: '已取消这次 AntDesk 的 ChatGPT 登录。' };
    if (previous?.id && connection && !connection.closed) {
      try { await connection.call('account/login/cancel', { loginId: previous.id }, { timeoutMs: 5000 }); } catch {}
    }
    if (previous) await closeHost();
    return snapshot();
  }
  function cancel() {
    if (cancellation) return cancellation;
    const operation = performCancel();
    cancellation = operation;
    return operation.finally(() => { if (cancellation === operation) cancellation = null; });
  }
  async function logout() {
    await cancel();
    authGeneration++;
    try {
      await (await host()).call('account/logout');
      lastDiagnostic = null;
      loginState = { state: 'idle', browserOpened: false, message: '已退出 AntDesk 专用 ChatGPT 登录。' };
    } catch { setFailure({ code: 'logout_failed' }, '未能确认退出 AntDesk 的 ChatGPT 登录，请重试。'); }
    await closeHost();
    return snapshot();
  }
  async function login(action = 'status') {
    if (action === 'cancel') return cancel();
    if (action === 'logout') {
      if (logoutOperation) return logoutOperation;
      const operation = logout(); logoutOperation = operation;
      try { return await operation; } finally { if (logoutOperation === operation) logoutOperation = null; }
    }
    if (action === 'status') {
      if (flow || loginState.state === 'failed') return snapshot();
      try {
        if (await getAuth()) return { state: 'ready', browserOpened: false, message: 'AntDesk 专用 ChatGPT 登录已连接。' };
      } catch (failure) { return { state: 'failed', browserOpened: false, message: '暂时无法确认 ChatGPT 登录状态，请重试。', diagnostic: diagnostic(failure) }; }
      return snapshot();
    }
    if (action !== 'start') throw issue('invalid_login_action', '不支持的 ChatGPT 登录操作。');
    if (cancellation) await cancellation;
    if (logoutOperation) await logoutOperation;
    if (closed) throw issue('runtime_closed', 'AntDesk 的 ChatGPT 登录服务已关闭。');
    if (flow) return snapshot();
    const item = { generation: ++authGeneration, id: null, early: new Map(), timer: null };
    flow = item; lastDiagnostic = null;
    loginState = { state: 'pending', browserOpened: false, message: '正在向官方服务发起 AntDesk 的 ChatGPT 登录…' };
    try {
      const rpc = await host();
      const result = await rpc.call('account/login/start', { type: 'chatgpt' });
      if (!currentFlow(item)) {
        if (validId(result?.loginId) && !rpc.closed) { try { await rpc.call('account/login/cancel', { loginId: result.loginId }); } catch {} }
        return snapshot();
      }
      const url = authorizationUrl(result?.authUrl);
      if (result?.type !== 'chatgpt' || !validId(result.loginId) || !url) {
        if (validId(result?.loginId)) { try { await rpc.call('account/login/cancel', { loginId: result.loginId }); } catch {} }
        throw issue('invalid_authorization_url', '官方登录返回了无法验证的授权地址，请重试。');
      }
      item.id = result.loginId;
      loginState = { state: 'pending', browserOpened: false, loginId: item.id, url,
        message: '请在官方页面完成 ChatGPT 登录。该登录只用于 AntDesk。' };
      item.timer = setTimeout(() => {
        if (!currentFlow(item)) return;
        void cancel().then(() => {
          if (!closed && !flow && authGeneration === item.generation + 1) setFailure({ code: 'login_timeout' }, 'ChatGPT 官方登录等待已结束，请重新登录。');
        });
      }, options.loginTimeoutMs ?? 10 * 60 * 1000);
      item.timer.unref?.();
      if (item.early.has(item.id)) await completeLogin(item, item.early.get(item.id));
      return snapshot();
    } catch (failure) {
      if (currentFlow(item)) { clearTimeout(item.timer); flow = null; setFailure(failure, '无法开始 ChatGPT 官方登录，请重试。'); await closeHost(); }
      return snapshot();
    }
  }
  return { status, login, getAuth,
    async close() {
      if (closed) return;
      closed = true; await cancel(); authGeneration++;
      await closeHost();
      if (connecting) { try { await connecting; } catch {} }
    },
  };
}

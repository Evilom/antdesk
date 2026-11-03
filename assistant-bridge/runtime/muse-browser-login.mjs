import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const MUSE_URL = 'https://muse.ai/';
const require = createRequire(import.meta.url);
const cancelled = Symbol('cancelled');
const timedOut = Symbol('timed-out');
const diagnosticStages = new Set(['runtime', 'browser', 'session', 'authorization', 'gateway_token', 'wake', 'gateway', 'identity', 'verification', 'storage']);
const diagnosticCodes = Object.freeze({ auth_required: false, access_denied: false, vm_unavailable: true,
  rate_limited: true, service_unavailable: true, network_timeout: true, network_error: true,
  gateway_unavailable: true, gateway_error: false, invalid_response: true, runtime_unavailable: false,
  verification_failed: false, verification_timeout: true, login_timeout: true, browser_unavailable: false,
  browser_navigation_failed: true, storage_failed: false });

/** A public diagnosis contains only stable enum values and an HTTP status. */
export function museLoginDiagnostic(failure, fallbackStage = 'verification') {
  const source = failure?.diagnostic || failure?.data || failure || {};
  let code = Object.hasOwn(diagnosticCodes, source.code) ? source.code : undefined;
  if (!code && failure?.code === 'RPC_TIMEOUT') code = 'network_timeout';
  if (!code && source.kind === 'AuthError') code = 'auth_required';
  if (!code && ['TimeoutError', 'Timeout'].includes(source.kind)) code = 'network_timeout';
  if (!code && ['ConnectionError', 'NetworkError'].includes(source.kind)) code = 'network_error';
  code ||= 'verification_failed';
  const result = { stage: diagnosticStages.has(source.stage) ? source.stage : diagnosticStages.has(fallbackStage) ? fallbackStage : 'verification',
    code, retryable: diagnosticCodes[code] };
  if (Number.isInteger(source.httpStatus) && source.httpStatus >= 100 && source.httpStatus <= 599) result.httpStatus = source.httpStatus;
  return result;
}

function verificationMessage(diagnostic, retrying = false) {
  const messages = {
    auth_required: '原 Muse 暂未确认登录，请在专用窗口完成登录或重新授权。',
    access_denied: 'Muse 拒绝了当前账号的访问，请在专用窗口检查账号是否可以使用原 Muse。',
    vm_unavailable: '原 Muse 已登录，个人实例正在从休眠恢复，请保留专用窗口。',
    rate_limited: 'Muse 暂时限制了验证频率，登录资料会保留。',
    service_unavailable: 'Muse 服务暂时不可用，登录资料会保留。',
    network_timeout: '连接 Muse 的请求超时，登录资料会保留。',
    network_error: '连接 Muse 的网络暂时不可用，登录资料会保留。',
    gateway_unavailable: 'Muse 的个人云端连接暂时中断，登录资料会保留。',
    invalid_response: 'Muse 暂未返回可验证的登录结果，登录资料会保留。',
    runtime_unavailable: '原 Muse 连接组件不可用，请检查安装。',
    verification_timeout: 'Muse 身份验证等待超时，登录资料会保留。',
    login_timeout: '本轮登录等待已结束，专用登录资料已保留，可以继续连接。',
    browser_unavailable: '专用登录窗口未能打开。请确认本机 Edge 或 Chrome 可用后重试。',
    browser_navigation_failed: '专用窗口已经打开，Muse 页面加载暂时失败，请在窗口中刷新或继续登录。',
    storage_failed: '无法保存原 Muse 的登录资料，请重试连接。',
  };
  return (messages[diagnostic.code] || '原 Muse 验证未完成，专用登录资料已保留，请重试连接。')
    + (retrying ? ' AntDesk 将自动重试验证。' : '');
}
const cookieName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const allowedDomain = domain => {
  if (typeof domain !== 'string') return false;
  const host = domain.toLowerCase().replace(/^\./, '');
  return host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*muse\.ai$/.test(host);
};

/** Validate the domain again even though Playwright was asked for one origin. */
function cookieHeader(cookies, now) {
  if (!Array.isArray(cookies)) return '';
  const rows = cookies.filter(cookie => cookie && allowedDomain(cookie.domain)
    && typeof cookie.name === 'string' && cookieName.test(cookie.name)
    && typeof cookie.value === 'string' && cookie.value.length > 0
    && !/[\x00-\x20\x7f;,\\]/.test(cookie.value)
    && !(Number.isFinite(cookie.expires) && cookie.expires > 0 && cookie.expires * 1000 <= now));
  const sessions = [...new Set(rows.filter(cookie => cookie.name === 'hatch_sess').map(cookie => cookie.value))];
  if (sessions.length !== 1) return '';
  const header = [...new Set(rows.map(cookie => `${cookie.name}=${cookie.value}`))].join('; ');
  return header.length <= 32768 ? header : '';
}

function browserEnvironment() {
  const permitted = /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMSPEC|SYSTEMDRIVE|HOMEDRIVE|HOMEPATH|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE|LANG|LC_ALL|TZ|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i;
  return Object.fromEntries(Object.entries(process.env).filter(([name]) => permitted.test(name)));
}

/** Creates a fresh browser process. Never attaches to, reads or imports another profile. */
async function launchSystemBrowser(toolsDir, profileDir, settings) {
  const playwright = require(path.join(toolsDir, 'browser', 'node_modules', 'playwright-core'));
  for (const channel of ['msedge', 'chrome']) {
    try { return await playwright.chromium.launchPersistentContext(profileDir, { ...settings, channel }); }
    catch { /* Try the other installed system browser, without exposing launch diagnostics. */ }
  }
  throw new Error('No supported system browser could be started.');
}

/** User-initiated login for the original Muse account. `tick` and `launch` are
 * deterministic test seams; neither constructor nor status can launch a browser. */
export function createMuseBrowserLogin(options) {
  const { dataDir, toolsDir, getSecret, setSecret, verifyCookies } = options;
  if (!dataDir || !toolsDir || typeof getSecret !== 'function' || typeof setSecret !== 'function' || typeof verifyCookies !== 'function') {
    throw new TypeError('Muse browser login configuration is incomplete.');
  }
  const profileDir = path.join(path.resolve(dataDir), 'browser-profile');
  const scheduler = options.scheduler || { setTimeout, clearTimeout };
  const clock = options.now || Date.now;
  const interval = Math.max(500, options.pollIntervalMs ?? 2000);
  const maxWait = Math.max(1000, options.maxWaitMs ?? 10 * 60 * 1000);
  // The SDK performs three HTTPS steps, a WebSocket/Noise handshake and an
  // identity request. A 30 second combined deadline cut valid logins short.
  const verifyTimeout = Math.max(1000, options.verifyTimeoutMs ?? 180000);
  const maxVerifyAttempts = Math.max(1, Math.min(20, options.maxVerifyAttempts ?? 8));
  const retryBase = Math.max(500, options.retryBaseMs ?? 5000);
  const launch = options.launch || ((profile, settings) => launchSystemBrowser(toolsDir, profile, settings));
  const contexts = new Set();
  let closed = false, generation = 0, flow = null;
  let resetting = Promise.resolve(), secretWrites = Promise.resolve();
  let state = { state: 'idle', browserOpened: false, message: '点击登录，在 AntDesk 专用窗口中连接原 Muse。' };
  const snapshot = () => ({ ...state });
  const active = item => !closed && flow === item && item.generation === generation && !item.controller.signal.aborted;
  const later = (fn, ms) => { const timer = scheduler.setTimeout(fn, ms); timer?.unref?.(); return timer; };
  const clearTimers = item => { if (!item) return; scheduler.clearTimeout(item.timer); scheduler.clearTimeout(item.deadlineTimer); item.timer = null; item.deadlineTimer = null; };

  async function closeContext(context) {
    if (!context || !contexts.has(context)) return;
    contexts.delete(context);
    try { await context.close(); } catch { /* Only the context created here is ever closed. */ }
  }
  async function detach(item) {
    if (!item) return;
    clearTimers(item); item.controller.abort();
    const context = item.context; item.context = null;
    await closeContext(context);
  }
  async function finish(item, next) {
    if (!active(item)) return;
    state = { browserOpened: item.kind === 'browser', ...next };
    flow = null;
    await detach(item);
  }
  async function prepareProfile() {
    await fs.mkdir(path.dirname(profileDir), { recursive: true, mode: 0o700 });
    try {
      const entry = await fs.lstat(profileDir);
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Dedicated profile path is unavailable.');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await fs.mkdir(profileDir, { recursive: true, mode: 0o700 });
  }
  function verify(header, item) {
    const signal = item.controller.signal;
    if (signal.aborted) return Promise.reject(cancelled);
    const attempt = new AbortController();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finishVerify = (result, failure) => {
        if (settled) return;
        settled = true; scheduler.clearTimeout(timer); signal.removeEventListener('abort', onAbort);
        if (failure) { attempt.abort(); reject(result); }
        else if (result === true || result?.ok === true) resolve(true);
        else reject(result);
      };
      const onAbort = () => finishVerify(cancelled, true);
      const timer = later(() => finishVerify(timedOut, true), verifyTimeout);
      signal.addEventListener('abort', onAbort, { once: true });
      Promise.resolve().then(() => verifyCookies(header, { signal: attempt.signal })).then(value => finishVerify(value, false), failure => finishVerify(failure, true));
    });
  }
  function persist(header, item) {
    const write = secretWrites.catch(() => {}).then(async () => {
      if (!active(item)) return false;
      const previous = await getSecret('cookies');
      if (!active(item)) return false;
      await setSecret('cookies', header);
      if (!active(item)) { await setSecret('cookies', previous || ''); return false; }
      return true;
    });
    secretWrites = write.catch(() => {});
    return write;
  }
  function schedule(item) {
    if (!active(item) || item.timer != null) return;
    const wait = item.kind === 'browser' ? interval : Math.max(interval, (item.nextCheckAt || 0) - clock());
    item.timer = later(() => { item.timer = null; void poll(item); }, wait);
  }
  async function failVerification(item, failure) {
    if (!active(item)) return;
    const diagnostic = failure === timedOut
      ? museLoginDiagnostic({ code: 'verification_timeout' }) : museLoginDiagnostic(failure);
    // A cookie can appear before onboarding and authorization have finished.
    // Keep this window open and wait for a changed cookie, rather than erasing
    // the dedicated profile and forcing a second login.
    if (diagnostic.code === 'auth_required' && item.kind === 'browser') {
      item.rejectedHeader = item.lastHeader;
      state = { state: 'pending', browserOpened: true, diagnostic, message: verificationMessage(diagnostic) };
      return;
    }
    if (diagnostic.retryable && item.attempts < maxVerifyAttempts && clock() < item.deadline) {
      item.nextCheckAt = clock() + Math.min(30000, retryBase * 2 ** Math.max(0, item.attempts - 1));
      state = { state: 'pending', browserOpened: item.kind === 'browser', diagnostic,
        message: verificationMessage(diagnostic, true) };
      return;
    }
    await finish(item, { state: 'failed', diagnostic, message: verificationMessage(diagnostic) });
  }
  async function poll(item) {
    if (!active(item)) return snapshot();
    if (clock() >= item.deadline) { await expire(item); return snapshot(); }
    if (item.kind === 'browser' && !item.context) return snapshot();
    if (item.checking) return item.checking;
    const operation = (async () => {
      try {
        const header = item.kind === 'browser' ? cookieHeader(await item.context.cookies(MUSE_URL), clock()) : item.storedHeader;
        if (!active(item) || !header) return;
        if (item.lastHeader !== header) { item.lastHeader = header; item.attempts = 0; item.nextCheckAt = 0; item.rejectedHeader = null; }
        if (item.rejectedHeader === header || clock() < item.nextCheckAt) return;
        item.attempts++;
        state = { state: 'pending', browserOpened: item.kind === 'browser', message: '正在验证原 Muse 身份和个人云端服务…' };
        await verify(header, item);
        if (!active(item)) return;
        if (item.kind === 'stored') await finish(item, { state: 'ready', message: '已验证并连接你的原 Muse。' });
        else {
          try { if (await persist(header, item)) await finish(item, { state: 'ready', message: '已验证并连接你的原 Muse，可以分配事项。' }); }
          catch { await failVerification(item, { code: 'storage_failed', stage: 'storage' }); }
        }
      } catch (failure) {
        await failVerification(item, failure);
      }
    })();
    item.checking = operation;
    try { await operation; } finally { item.checking = null; schedule(item); }
    return snapshot();
  }
  async function expire(item) {
    const diagnostic = museLoginDiagnostic({ code: 'login_timeout' });
    await finish(item, { state: 'failed', diagnostic, message: verificationMessage(diagnostic) });
  }
  function createFlow(kind) {
    const item = { kind, generation: ++generation, controller: new AbortController(), context: null, timer: null, deadlineTimer: null,
      checking: null, startup: null, deadline: clock() + maxWait, attempts: 0, nextCheckAt: 0 };
    flow = item;
    item.deadlineTimer = later(() => { void expire(item); }, maxWait);
    return item;
  }
  async function start() {
    if (closed) return { state: 'failed', browserOpened: false, message: '登录服务已关闭，请重新打开 AntDesk。' };
    if (flow?.kind === 'browser' && active(flow)) return snapshot();
    const previous = flow; flow = null; generation++;
    const stopping = detach(previous);
    const item = createFlow('browser');
    state = { state: 'pending', browserOpened: true, message: '正在打开 AntDesk 专用登录窗口…' };
    item.startup = (async () => {
      try {
        await stopping; await resetting;
        if (!active(item)) return;
        await prepareProfile();
        if (!active(item)) return;
        const context = await launch(profileDir, {
          headless: false, timeout: 12000, viewport: null, acceptDownloads: false,
          args: ['--no-first-run', '--no-default-browser-check', '--disable-sync'], env: browserEnvironment(),
        });
        contexts.add(context);
        if (!active(item)) { await closeContext(context); return; }
        item.context = context;
        context.once?.('close', () => {
          contexts.delete(context);
          if (active(item)) { state = { state: 'idle', browserOpened: false, message: '专用登录窗口已关闭，可以重新发起登录。' }; flow = null; clearTimers(item); item.controller.abort(); }
        });
        const pages = context.pages();
        const page = pages[0] || await context.newPage();
        if (!active(item)) return;
        try { await page.goto(MUSE_URL, { waitUntil: 'domcontentloaded', timeout: 20000 }); }
        catch {
          if (active(item)) {
            const diagnostic = museLoginDiagnostic({ stage: 'browser', code: 'browser_navigation_failed' });
            state = { state: 'pending', browserOpened: true, diagnostic, message: verificationMessage(diagnostic) };
            schedule(item);
          }
          return;
        }
        if (!active(item)) return;
        state = { state: 'pending', browserOpened: true, message: '已打开专用窗口，请在那里完成原 Muse 登录。' };
        schedule(item);
      } catch {
        const diagnostic = museLoginDiagnostic({ stage: 'browser', code: 'browser_unavailable' });
        if (active(item)) await finish(item, { state: 'failed', browserOpened: false, diagnostic, message: verificationMessage(diagnostic) });
      }
    })();
    return snapshot();
  }
  async function status() {
    if (closed || flow || state.state !== 'idle') return snapshot();
    const observedGeneration = generation;
    let stored;
    try { stored = await getSecret('cookies'); }
    catch { state = { state: 'failed', browserOpened: false, message: '无法读取已保存的登录资料，请重新登录。' }; return snapshot(); }
    if (!stored || typeof stored !== 'string') return snapshot();
    if (closed || flow || generation !== observedGeneration || state.state !== 'idle') return snapshot();
    const item = createFlow('stored');
    state = { state: 'pending', browserOpened: false, message: '正在验证已保存的原 Muse 登录资料…' };
    item.storedHeader = stored;
    item.startup = poll(item);
    return snapshot();
  }
  async function cancel() {
    const previous = flow; flow = null; generation++;
    state = { state: 'idle', browserOpened: false, message: '已取消这次登录。' };
    await detach(previous);
    return snapshot();
  }
  async function logout() {
    const previous = flow; flow = null;
    const epoch = ++generation;
    state = { state: 'idle', browserOpened: false, message: '正在清除 AntDesk 的原 Muse 登录资料…' };
    const closing = detach(previous);
    const clearSecret = secretWrites.catch(() => {}).then(() => setSecret('cookies', ''));
    secretWrites = clearSecret.catch(() => {});
    const cleanup = (async () => {
      let failed = false;
      try { await clearSecret; } catch { failed = true; }
      try { await closing; await previous?.startup; await fs.rm(profileDir, { recursive: true, force: true }); } catch { failed = true; }
      if (generation === epoch) state = { state: failed ? 'failed' : 'idle', browserOpened: false, message: failed ? '部分登录资料未能清除，请重试退出登录。' : '已退出原 Muse，并清除 AntDesk 专用登录会话。' };
    })();
    resetting = cleanup;
    await cleanup;
    return snapshot();
  }
  return {
    async login(action = 'status') {
      if (action === 'start') return start();
      if (action === 'status') return status();
      if (action === 'cancel') return cancel();
      if (action === 'logout') return logout();
      return { state: 'failed', browserOpened: false, message: '不支持的登录操作。' };
    },
    async tick() { const item = flow; if (!item) return snapshot(); if (clock() >= item.deadline) return poll(item); await item.startup; return poll(item); },
    async close() { if (closed) return; closed = true; const previous = flow; flow = null; generation++; state = { state: 'idle', browserOpened: false, message: '登录服务已关闭。' }; await detach(previous); await Promise.allSettled([...contexts].map(closeContext)); },
  };
}

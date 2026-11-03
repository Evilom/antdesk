import fs from 'node:fs';
import path from 'node:path';
import { createDeepSeekWebHost, DEEPSEEK_CLIENT_VERSION, openDeepSeekAuthorization } from './deepseek-host.mjs';
import { safeDeepSeekModels } from './deepseek-auth.mjs';

const ACTIVE_PHASES = new Set(['initializing', 'waiting-browser', 'exchanging', 'committing']);
const PHASES = new Set([...ACTIVE_PHASES, 'succeeded', 'cancelled', 'expired', 'failed']);
const SIGN_IN_ERRORS = Object.freeze({
  'no-response': 'DeepSeek 官方登录服务没有响应，请检查网络后重试。',
  network: 'DeepSeek 官方登录暂时不可用，请检查网络后重试。',
  protocol: 'DeepSeek 官方登录返回的数据未通过校验，请稍后重试。',
  expired: '这次 DeepSeek 授权已过期，请重新点击登录。',
  storage: 'DeepSeek 官方运行时未能保存登录，请检查 AntDesk 数据目录后重试。',
});
const clean = (value, max = 150) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, max) : '';

function accountView(value) {
  if (!value || !['signed-out', 'credential-stored'].includes(value.status)) throw new Error('Invalid official account projection.');
  const attempt = value.attempt;
  if (attempt != null && (typeof attempt.id !== 'string' || attempt.id.length > 150 || !PHASES.has(attempt.phase))) throw new Error('Invalid official account attempt.');
  return value;
}

function authorizationUrl(value) {
  const url = new URL(value);
  if (url.origin !== 'https://platform.deepseek.com' || url.pathname !== '/dsh/authorize' || url.username || url.password || url.hash) throw new Error('Invalid official browser destination.');
  return url.href;
}

/** Official Host owns PKCE, callback routing and credential storage. AntDesk
 * handles only safe AccountView/Profile projections and a browser handoff.
 * Source: dsh-v0.2.1-rc.2 packages/api/account-controller/src/index.ts. */
export function createDeepSeekAccount(options) {
  const home = options.home || path.join(options.dataDir, 'account-home');
  const webPatchPath = path.join(options.dataDir, 'account-web.patch.json');
  fs.mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(webPatchPath, JSON.stringify([
    { id: 'session-log-deepseek', config: { enabled: false } },
    { id: 'plugin-package-inventory-deepseek', disabled: true },
    { id: 'session-telemetry-otel', disabled: true },
    { id: 'session-title-llm', disabled: true },
  ], null, 2), { mode: 0o600 });
  const hostFactory = options.hostFactory || (settings => createDeepSeekWebHost(settings));
  const openBrowser = options.openBrowser || openDeepSeekAuthorization;
  const listModels = options.listModels || (async liveHost => {
    // SessionController.modelCatalog is a read-only, session-free Remote in
    // the pinned official source; LlmRuntime.listModels itself is Host-only.
    const catalog = await liveHost.call('session/modelCatalog');
    if (!Array.isArray(catalog?.groups)) throw new Error('Invalid official model catalog.');
    return catalog.groups.find(group => group.id === 'deepseek-account')?.models || [];
  });
  const scheduler = options.scheduler || { setTimeout, clearTimeout };
  const now = options.now || Date.now;
  const pollMs = Math.max(250, options.pollIntervalMs ?? 1500);
  let host, opening, reading, flow, closing, epoch = 0, closed = false, verifiedAt = 0, lastReadAt = 0;
  let state = { state: 'idle', browserOpened: false, accountStored: false, models: [], message: '点击登录，使用 DeepSeek 官方账号连接助理。' };
  const snapshot = () => structuredClone(state);
  const client = () => ({ version: DEEPSEEK_CLIENT_VERSION, locale: 'zh', timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60 });
  const current = item => !closed && !closing && flow === item && epoch === item.epoch;
  const clearTimer = item => { if (item?.timer) scheduler.clearTimeout(item.timer); if (item) item.timer = null; };

  async function getHost() {
    if (closed || closing) throw new Error('Account host closed.');
    if (!host) host = hostFactory({ python: options.python, home, patchPath: webPatchPath });
    if (!opening) opening = host.open();
    const activeHost = host, activeOpening = opening;
    await activeOpening;
    return activeHost;
  }

  async function hostFailure(error, requestEpoch) {
    if (closed || epoch !== requestEpoch) return;
    const oldHost = host; host = null; opening = null; verifiedAt = 0;
    clearTimer(flow); flow = null;
    state = { state: 'failed', browserOpened: false, accountStored: state.accountStored === true, models: [], code: 'account_host_unavailable',
      ...(typeof error?.code === 'string' && /^host_[a-z_]+$/.test(error.code) ? { hostCode: error.code } : {}),
      message: error?.code === 'host_version_mismatch' ? 'DeepSeek 官方运行时版本不匹配，请更新组件后重试。'
        : 'DeepSeek 官方账号服务未能连接，请重试登录或检查运行时。' };
    try { await oldHost?.close(); } catch {}
  }

  function schedule(item) {
    if (!current(item)) return;
    clearTimer(item);
    item.timer = scheduler.setTimeout(() => { item.timer = null; void refresh().finally(() => { if (current(item)) schedule(item); }); }, pollMs);
    item.timer?.unref?.();
  }

  async function applyView(value, requestEpoch) {
    const view = accountView(value);
    if (closed || epoch !== requestEpoch) return;
    const item = flow;
    if (view.status === 'credential-stored') {
      if (state.state === 'ready' && now() - verifiedAt < 30000) return;
      const liveHost = await getHost();
      const profile = await liveHost.call('account/getProfile', { client: client() });
      if (closed || epoch !== requestEpoch) return;
      if (profile?.status !== 'ready') {
        const latest = accountView(await liveHost.call('account/getState'));
        if (closed || epoch !== requestEpoch) return;
        if (latest.status === 'signed-out') {
          state = { state: 'idle', browserOpened: false, accountStored: false, models: [], code: 'ACCOUNT_TOKEN_INVALID', message: 'DeepSeek 官方账号登录已失效，请重新登录。' };
        } else {
          state = { state: 'failed', browserOpened: false, accountStored: true, models: [], code: 'account_unverified', message: 'DeepSeek 登录资料已保存，暂时无法向官方验证，请稍后检查连接。' };
        }
        clearTimer(item); flow = null; return;
      }
      const models = safeDeepSeekModels(await listModels(liveHost));
      if (closed || epoch !== requestEpoch) return;
      verifiedAt = now(); clearTimer(item); flow = null;
      state = { state: models.length ? 'ready' : 'failed', browserOpened: false, accountStored: true, models, verifiedAt,
        account: { name: clean(profile.value?.name), contact: clean(profile.value?.contact) },
        ...(models.length ? {} : { code: 'account_models_unavailable' }),
        message: models.length ? '已通过 DeepSeek 官方账号登录，凭据由官方运行时管理。'
          : 'DeepSeek 官方账号已登录，但当前运行时没有可用账号模型，请检查账号资格或升级运行时。' };
      return;
    }
    verifiedAt = 0;
    const attempt = view.attempt;
    if (!attempt) {
      if (item) return;
      state = { state: 'idle', browserOpened: false, accountStored: false, models: [], message: '点击登录，使用 DeepSeek 官方账号连接助理。' }; return;
    }
    if (item && !item.attemptId && ACTIVE_PHASES.has(attempt.phase)) item.attemptId = attempt.id;
    if (item && attempt.id !== item.attemptId) return;
    if (ACTIVE_PHASES.has(attempt.phase)) {
      state = { state: 'pending', browserOpened: item?.browserOpened === true, accountStored: false, models: [],
        message: attempt.phase === 'waiting-browser' ? '请在系统浏览器中完成 DeepSeek 官方授权。'
          : ['exchanging', 'committing'].includes(attempt.phase) ? '正在由 DeepSeek 官方运行时确认并保存授权…' : '正在准备 DeepSeek 官方登录…' };
      if (item && attempt.phase === 'waiting-browser' && !item.browserOpened && !item.browserOpening) {
        item.browserOpening = true;
        try {
          const url = authorizationUrl(attempt.authorizeUrl);
          if (!current(item)) return;
          await openBrowser(url);
          if (current(item)) { item.browserOpened = true; state.browserOpened = true; }
        } catch {
          if (!current(item)) return;
          await (await getHost()).call('account/cancelSignIn', { attemptId: item.attemptId });
          clearTimer(item); flow = null;
          state = { state: 'failed', browserOpened: false, accountStored: false, models: [], code: 'browser_open_failed', message: '系统浏览器未能打开，请确认默认浏览器可用后重新登录。' };
        } finally { item.browserOpening = false; }
      }
      return;
    }
    clearTimer(item); flow = null;
    if (attempt.phase === 'failed' || attempt.phase === 'expired') {
      state = { state: 'failed', browserOpened: false, accountStored: false, models: [], code: attempt.errorCode || 'expired',
        message: SIGN_IN_ERRORS[attempt.errorCode] || SIGN_IN_ERRORS.expired };
    } else {
      state = { state: 'idle', browserOpened: false, accountStored: false, models: [], message: '这次登录已取消，可以重新登录。' };
    }
  }

  async function refresh() {
    if (closed || closing) return snapshot();
    if (reading) return reading;
    const requestEpoch = epoch;
    reading = (async () => {
      try {
        const liveHost = await getHost();
        const view = await liveHost.call('account/getState');
        await applyView(view, requestEpoch);
      } catch (error) { await hostFailure(error, requestEpoch); }
      finally { lastReadAt = now(); }
      return snapshot();
    })();
    try { return await reading; } finally { reading = null; }
  }

  async function start() {
    if (closed || closing) return snapshot();
    if (flow) return snapshot();
    if (state.state === 'ready') return snapshot();
    const item = { epoch: ++epoch, attemptId: null, browserOpened: false, browserOpening: false, timer: null, startup: null };
    flow = item; verifiedAt = 0;
    state = { state: 'pending', browserOpened: false, accountStored: false, models: [], message: '正在启动 DeepSeek 官方登录…' };
    item.startup = (async () => {
      try {
        const liveHost = await getHost();
        if (!current(item)) return;
        const existing = accountView(await liveHost.call('account/getState'));
        if (!current(item)) return;
        if (existing.status === 'credential-stored') {
          await applyView(existing, item.epoch);
          if (closed || epoch !== item.epoch || state.state === 'ready' || state.accountStored) return;
          // An expired grant was cleared by the official profile query; the
          // same explicit login click may now start a fresh official flow.
          flow = item;
          state = { state: 'pending', browserOpened: false, accountStored: false, models: [], message: '正在重新发起 DeepSeek 官方登录…' };
        }
        const view = accountView(await liveHost.call('account/startSignIn', { client: client(), callbackOrigin: liveHost.origin, loginSource: 'web' }));
        item.attemptId = view.attempt?.id;
        if (!current(item)) {
          if (item.attemptId) await liveHost.call('account/cancelSignIn', { attemptId: item.attemptId });
          return;
        }
        await applyView(view, item.epoch);
        if (current(item)) schedule(item);
      } catch (error) { await hostFailure(error, item.epoch); }
    })();
    return snapshot();
  }

  async function cancel() {
    const item = flow;
    if (!item) return snapshot();
    flow = null; const requestEpoch = ++epoch; verifiedAt = 0; clearTimer(item);
    try {
      // A browser cannot have opened before the attempt receipt. Closing this
      // still-starting owned Host aborts the pending RPC and avoids a long
      // startup wait when the user immediately cancels.
      if (!item.attemptId && host) {
        const startingHost = host; host = null; opening = null;
        await startingHost.close();
      }
      await item.startup;
      if (item.attemptId && host) {
        const view = await host.call('account/cancelSignIn', { attemptId: item.attemptId });
        if (closed || epoch !== requestEpoch) return snapshot();
        if (view?.status === 'credential-stored') { await applyView(view, requestEpoch); return snapshot(); }
      }
    } catch {
      if (closed || epoch !== requestEpoch) return snapshot();
      try { await host?.close(); } catch {}
      host = null; opening = null;
      state = { state: 'failed', browserOpened: false, accountStored: false, models: [], code: 'cancel_unconfirmed', message: '登录窗口已停止等待，官方取消结果尚未确认，请检查连接状态。' };
      return snapshot();
    }
    if (closed || epoch !== requestEpoch) return snapshot();
    state = { state: 'idle', browserOpened: false, accountStored: state.accountStored === true, models: [], message: '已取消这次 DeepSeek 登录。' };
    return snapshot();
  }

  return {
    home, webPatchPath, refresh,
    async status() {
      if (!closed && !closing && !flow && !reading && (!lastReadAt || now() - lastReadAt >= 2000)) {
        if (state.state === 'idle' && !lastReadAt) state = { ...state, state: 'pending', message: '正在检查 DeepSeek 官方账号连接…' };
        void refresh();
      }
      return snapshot();
    },
    async login(action = 'status') {
      if (action === 'start') return start();
      if (action === 'status') return this.status();
      if (action === 'cancel') return cancel();
      if (action === 'logout') {
        await cancel();
        const requestEpoch = ++epoch;
        try {
          const liveHost = await getHost();
          const view = accountView(await liveHost.call('account/signOut', { client: client() }));
          if (closed || epoch !== requestEpoch) return snapshot();
          if (view.status !== 'signed-out') throw new Error('Account was not signed out.');
          state = { state: 'idle', browserOpened: false, accountStored: false, models: [], message: '已退出本应用的 DeepSeek 官方账号。' };
          verifiedAt = 0;
        } catch (error) { await hostFailure(error, requestEpoch); }
        return snapshot();
      }
      return { state: 'failed', browserOpened: false, message: '不支持的 DeepSeek 登录操作。' };
    },
    invalidate() { verifiedAt = 0; lastReadAt = 0; },
    async close() {
      if (closing) return closing;
      if (closed) return;
      closing = (async () => {
        await cancel(); closed = true; ++epoch;
        try { await host?.close(); } catch {}
        host = null; opening = null;
      })();
      return closing;
    },
  };
}

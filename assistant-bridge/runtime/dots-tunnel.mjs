import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CONTROL_PLANE = 'https://api.openai.com';
const TUNNEL_ID = /^tunnel_(?:[a-z0-9]{4}_)?[a-z0-9]{32}$/;
const SECRET_NAME = 'tunnelApiKey';
const UPSTREAM_AUTH_ENV = 'ANTDESK_DOT_MCP_AUTH';
const MESSAGES = Object.freeze({
  tunnel_not_installed: '尚未安装官方 OpenAI Tunnel 客户端。',
  tunnel_version_unavailable: '无法验证官方 Tunnel 客户端的版本，请检查安装。',
  tunnel_not_configured: '请配置已有 Tunnel ID 和具有 Tunnels Read + Use 权限的运行密钥。',
  tunnel_config_unavailable: '无法读取 Tunnel 配置，请重新保存连接设置。',
  tunnel_upstream_unavailable: 'AntDesk 的 Dots 专属 MCP 连接尚未准备好。',
  tunnel_start_failed: '官方 Tunnel 客户端未能启动，请检查安装和系统权限。',
  tunnel_exited: '官方 Tunnel 客户端已停止，请重新连接。',
  tunnel_health_invalid: '无法确认官方 Tunnel 客户端的本机健康检查地址。',
  tunnel_not_ready: '官方 Tunnel 尚未通过连通性检查，请检查 Tunnel 权限、密钥和网络。',
  tunnel_health_unavailable: '暂时无法验证官方 Tunnel 的连接状态，正在重新检查。',
  tunnel_stop_failed: '官方 Tunnel 客户端尚未停止，请关闭 AntDesk 后重新连接。',
  tunnel_closed: 'Tunnel 连接管理器已关闭。',
});

function publicError(code, fallback = 'tunnel_start_failed') {
  return Object.assign(new Error(MESSAGES[code] || MESSAGES[fallback]), { code: MESSAGES[code] ? code : fallback });
}

function validSecret(value) {
  return typeof value === 'string' && value.length >= 16 && value.length <= 8192 && /^[!-~]+$/.test(value);
}

function upstream(value) {
  try {
    const url = new URL(value?.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      || !url.port || url.pathname !== '/mcp' || url.username || url.password || url.search || url.hash
      || !validSecret(value?.token)) throw new Error();
    return { url: url.href, token: value.token };
  } catch { throw publicError('tunnel_upstream_unavailable'); }
}

function healthBase(value) {
  try {
    if (typeof value !== 'string' || value.length > 1024) throw new Error();
    const url = new URL(value.trim());
    // The managed process is explicitly bound to this numeric loopback address.
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') throw new Error();
    return url.origin;
  } catch { throw publicError('tunnel_health_invalid'); }
}

function runtimeEnv(extra = {}) {
  // A small OS/network allowlist prevents inherited profiles, credentials, debug
  // logging, extra channels, and arbitrary control-plane URLs from taking effect.
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LANGUAGE|LC_[A-Z_]+|TZ|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|SSL_CERT_FILE|SSL_CERT_DIR)$/i.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

async function boundedText(response, limit) {
  if (!response.body?.getReader) {
    const value = await response.text();
    if (Buffer.byteLength(value) > limit) throw new Error('response_limit');
    return value;
  }
  const reader = response.body.getReader();
  let size = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, size).toString('utf8');
      size += value.byteLength;
      if (size > limit) throw new Error('response_limit');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); }
}

/** Supervise the official OpenAI tunnel-client. This never creates a tunnel,
 * logs in, registers a plugin, subscribes a Dot, or sends an assistant message.
 * Configuration/health contract: openai/tunnel-client docs/configuration.md and
 * docs/health.md, verified against the full Windows v0.0.19 CLI.
 */
export function createDotsTunnel(options) {
  const { toolsDir, dataDir, getConfig, setConfig, getSecret, setSecret, getUpstream } = options;
  const spawnImpl = options.spawnImpl || spawn;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const pollMs = options.pollMs ?? 1500;
  const readyTimeoutMs = options.readyTimeoutMs ?? 60000;
  const probeTimeoutMs = options.probeTimeoutMs ?? 2500;
  const stopTimeoutMs = options.stopTimeoutMs ?? 2000;
  const versionTimeoutMs = options.versionTimeoutMs ?? 4000;
  const binary = path.join(toolsDir, 'dots-tunnel', 'tunnel-client.exe');
  let state = 'idle', errorCode = null, current = null, closed = false;
  let version = null, binarySignature = null, versionPromise = null;
  let serial = Promise.resolve();
  const serialize = fn => {
    const work = serial.then(fn, fn);
    serial = work.catch(() => {});
    return work;
  };

  async function readSettings() {
    try {
      const config = await getConfig();
      const key = await getSecret(SECRET_NAME);
      const tunnelId = typeof config?.tunnelId === 'string' && TUNNEL_ID.test(config.tunnelId) ? config.tunnelId : '';
      return { tunnelId, key, configured: Boolean(tunnelId && validSecret(key)) };
    } catch { throw publicError('tunnel_config_unavailable'); }
  }

  function fingerprint(settings, target) {
    return createHash('sha256').update(JSON.stringify([settings.tunnelId, settings.key, target.url, target.token])).digest('hex');
  }

  async function installation() {
    let stat;
    try { stat = await fs.stat(binary); if (!stat.isFile()) throw new Error(); }
    catch { version = null; binarySignature = null; return false; }
    const signature = `${stat.size}:${stat.mtimeMs}`;
    if (binarySignature === signature && version) return true;
    if (!versionPromise) {
      versionPromise = new Promise(resolve => {
        let child, stdout = '', settled = false;
        const finish = value => {
          if (settled) return;
          settled = true; clearTimeout(timer); version = value;
          binarySignature = value ? signature : null;
          resolve();
        };
        const timer = setTimeout(() => { try { child?.kill(); } catch {} finish(null); }, versionTimeoutMs);
        try {
          child = spawnImpl(binary, ['--version'], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: runtimeEnv() });
          child.stdout?.on('data', chunk => {
            if (Buffer.byteLength(stdout) + Buffer.byteLength(chunk) > 4096) { try { child.kill(); } catch {} finish(null); return; }
            stdout += chunk.toString();
          });
          child.stderr?.on('data', () => {});
          child.once('error', () => finish(null));
          child.once('close', code => {
            const found = stdout.trim().match(/^(?:tunnel-client\s+(?:version\s+)?)?v?(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]{1,96})?)(?:\s+\([^\r\n]*\))?$/);
            finish(code === 0 && found ? found[1] : null);
          });
        } catch { finish(null); }
      }).finally(() => { versionPromise = null; });
    }
    await versionPromise;
    return true;
  }

  async function snapshot({ probe = false } = {}) {
    let settings = { tunnelId: '', configured: false };
    try { settings = await readSettings(); }
    catch { errorCode = 'tunnel_config_unavailable'; state = 'failed'; }
    const installed = await installation();
    if (probe && current && !current.stopping) await probeRun(current);
    return { state, installed, version, tunnelId: settings.tunnelId, error: errorCode ? MESSAGES[errorCode] : null, configured: settings.configured, startedAt:current?.startedAt||null };
  }

  function schedule(run) {
    if (run !== current || run.stopping || run.exited || run.invalidHealth || closed) return;
    clearTimeout(run.timer);
    run.timer = setTimeout(() => { probeRun(run).catch(() => {}).finally(() => schedule(run)); }, pollMs);
    run.timer.unref?.();
  }

  async function probeRun(run) {
    if (run !== current || run.stopping || run.exited) return;
    if (run.probe) return run.probe;
    run.probe = (async () => {
      try {
        if (!run.healthUrl) {
          const stat = await fs.lstat(run.healthFile);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw publicError('tunnel_health_invalid');
          run.healthUrl = healthBase(await fs.readFile(run.healthFile, 'utf8'));
        }
        const signal = AbortSignal.any([run.abort.signal, AbortSignal.timeout(probeTimeoutMs)]);
        const init = { method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store', signal };
        const response = await fetchImpl(run.healthUrl + '/readyz', init);
        const readiness = await boundedText(response, 2048);
        if (response.status !== 200 || readiness.trim() !== 'ready') throw publicError('tunnel_not_ready');
        const health = await fetchImpl(run.healthUrl + '/health?details=true', init);
        if (health.status !== 200) throw publicError('tunnel_not_ready');
        const details = JSON.parse(await boundedText(health, 65536));
        // Startup readiness alone does not prove that the runtime key can poll.
        const control = details.components?.['control-plane'];
        if (details.schema_version !== 1 || details.live !== true || details.ready !== true || control?.status !== 'ok') throw publicError('tunnel_not_ready');
        if (current !== run || run.stopping || run.exited) return;
        run.wasReady = true; state = 'ready'; errorCode = null;
      } catch (error) {
        if (current !== run || run.stopping || run.exited) return;
        if (error?.code === 'tunnel_health_invalid') {
          state = 'failed'; errorCode = 'tunnel_health_invalid';
          run.invalidHealth = true;
          try { run.child.kill(); } catch {}
        } else if (run.wasReady || Date.now() - run.startedAt >= readyTimeoutMs) {
          state = 'failed'; errorCode = run.wasReady ? 'tunnel_health_unavailable' : 'tunnel_not_ready';
        } else { state = 'starting'; errorCode = null; }
      }
    })().finally(() => { run.probe = null; });
    return run.probe;
  }

  async function stopRun(run) {
    if (!run) return true;
    run.stopping = true; clearTimeout(run.timer); run.abort.abort();
    if (!run.exited && run.child.exitCode === null) {
      const stopped = await new Promise(resolve => {
        let done = false, timer;
        const finish = value => { if (done) return; done = true; clearTimeout(timer); run.child.removeListener('exit', onExit); resolve(value); };
        const onExit = () => finish(true);
        timer = setTimeout(() => {
          try { run.child.kill('SIGKILL'); } catch { finish(false); return; }
          // kill() only requests termination. Wait for the actual exit before
          // removing its private directory or starting a replacement process.
          if (!done) timer = setTimeout(() => finish(false), Math.min(stopTimeoutMs, 500));
        }, stopTimeoutMs);
        run.child.once('exit', onExit);
        try { run.child.kill(); } catch { finish(false); }
        if (run.exited || run.child.exitCode !== null) finish(true);
      });
      if (!stopped && !run.exited && run.child.exitCode === null) {
        state = 'failed'; errorCode = 'tunnel_stop_failed'; return false;
      }
    }
    if (current === run) current = null;
    await fs.rm(run.runDir, { recursive: true, force: true }).catch(() => {});
    return true;
  }

  async function configure(value = {}) {
    const tunnelId = typeof value.tunnelId === 'string' ? value.tunnelId.trim() : '';
    if (!TUNNEL_ID.test(tunnelId)) throw Object.assign(new Error('请输入 OpenAI 提供的完整 Tunnel ID。'), { code: 'invalid_tunnel_id' });
    const suppliedKey = typeof value.tunnelApiKey === 'string' ? value.tunnelApiKey.trim() : undefined;
    if (suppliedKey && !validSecret(suppliedKey)) throw Object.assign(new Error('请输入有效的 Tunnel 运行密钥。'), { code: 'invalid_tunnel_key' });
    return serialize(async () => {
      if (closed) throw publicError('tunnel_closed');
      const old = await readSettings();
      const key = suppliedKey || (old.tunnelId === tunnelId ? old.key : null);
      if (!validSecret(key)) throw Object.assign(new Error('请为这个 Tunnel 提供运行密钥。'), { code: 'invalid_tunnel_key' });
      if (!await stopRun(current)) return snapshot();
      try {
        // The caller owns encryption. This module never persists a plaintext key.
        await setSecret(SECRET_NAME, key);
        await setConfig({ tunnelId });
      } catch { state = 'failed'; errorCode = 'tunnel_config_unavailable'; return snapshot(); }
      state = 'idle'; errorCode = null;
      return snapshot();
    });
  }

  async function start() {
    return serialize(async () => {
      if (closed) throw publicError('tunnel_closed');
      let runDir;
      try {
        const settings = await readSettings();
        if (!settings.configured) throw publicError('tunnel_not_configured');
        if (!await installation()) throw publicError('tunnel_not_installed');
        if (!version) throw publicError('tunnel_version_unavailable');
        const target = upstream(await getUpstream());
        const key = fingerprint(settings, target);
        if (current && !current.stopping && !current.exited && current.key === key) return snapshot({ probe: true });
        if (!await stopRun(current)) return snapshot();
        await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
        runDir = await fs.mkdtemp(path.join(dataDir, 'tunnel-run-'));
        const profileDir = path.join(runDir, 'profiles');
        await fs.mkdir(profileDir, { mode: 0o700 });
        const healthFile = path.join(runDir, 'health-url');
        const args = ['run', '--profile-dir', profileDir,
          '--control-plane.base-url', CONTROL_PLANE,
          '--control-plane.api-key', 'env:CONTROL_PLANE_API_KEY',
          '--control-plane.tunnel-id', settings.tunnelId,
          '--mcp.server-url', target.url,
          '--mcp.extra-headers', `Authorization: env:${UPSTREAM_AUTH_ENV}`,
          '--mcp.discovery-extra-headers', `Authorization: env:${UPSTREAM_AUTH_ENV}`,
          '--mcp.discovery-extra-headers', 'X-AntDesk-Discovery: 1',
          '--health.listen-addr', '127.0.0.1:0', '--health.url-file', healthFile,
          '--log.format', 'json', '--log.level', 'warn', '--log.file', path.join(runDir, 'tunnel.log')];
        const env = runtimeEnv({ CONTROL_PLANE_API_KEY: settings.key, [UPSTREAM_AUTH_ENV]: `Bearer ${target.token}` });
        const child = spawnImpl(binary, args, { cwd: runDir, env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const run = { child, key, runDir, healthFile, abort: new AbortController(), startedAt: Date.now(), exited: false, stopping: false, wasReady: false };
        current = run; state = 'starting'; errorCode = null;
        child.stdout?.on('data', () => {});
        child.stderr?.on('data', () => {});
        child.once('error', () => {
          run.exited = true;
          if (current === run && !run.stopping) { state = 'failed'; errorCode = 'tunnel_start_failed'; }
          clearTimeout(run.timer); run.abort.abort();
        });
        child.once('exit', () => {
          run.exited = true;
          if (current === run && !run.stopping) { state = 'failed'; errorCode = run.invalidHealth ? 'tunnel_health_invalid' : 'tunnel_exited'; }
          clearTimeout(run.timer); run.abort.abort();
        });
        schedule(run);
        return snapshot({ probe: true });
      } catch (error) {
        if (runDir && current?.runDir !== runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
        state = 'failed'; errorCode = Object.hasOwn(MESSAGES, error?.code) ? error.code : 'tunnel_start_failed';
        return snapshot();
      }
    });
  }

  async function stop() {
    if (current) { current.stopping = true; current.abort.abort(); clearTimeout(current.timer); }
    return serialize(async () => {
      if (await stopRun(current)) { state = 'idle'; errorCode = null; }
      return snapshot();
    });
  }

  return {
    configure, start, stop,
    status: () => snapshot({ probe: true }),
    async close() { closed = true; await stop(); },
  };
}

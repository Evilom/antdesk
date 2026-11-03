import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { isolatedRuntimeEnv } from './stdio-rpc.mjs';
import { boundedDeepSeekJson } from './deepseek-auth.mjs';

const execFileAsync = promisify(execFile);
export const DEEPSEEK_SDK_VERSION = '0.2.1rc2';
export const DEEPSEEK_CLIENT_VERSION = '0.2.1-rc.2';
const ALLOWED_CALLS = new Set(['account/getState', 'account/getProfile', 'account/startSignIn', 'account/cancelSignIn', 'account/signOut', 'session/modelCatalog']);
const hostError = code => Object.assign(new Error('Official DeepSeek account host is unavailable.'), { code });

/** The pinned official Python package supplies its native launch command.
 * No other installation, account store, or browser profile is inspected. */
async function officialCommand(python, home, signal) {
  const script = [
    'import importlib.metadata,json',
    'from deepseek_harness_runtime import resolve_bundled_launch_args',
    'print(json.dumps({"sdk":importlib.metadata.version("deepseek-harness-sdk"),"runtime":importlib.metadata.version("deepseek-harness-runtime-bin"),"args":list(resolve_bundled_launch_args())}))',
  ].join('\n');
  let stdout;
  try {
    ({ stdout } = await execFileAsync(python, ['-I', '-X', 'utf8', '-c', script], {
      cwd: home, env: isolatedRuntimeEnv(home, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }),
      windowsHide: true, timeout: 15000, maxBuffer: 65536, signal,
    }));
  } catch { throw hostError('host_runtime_missing'); }
  let result;
  try { result = JSON.parse(stdout); } catch { throw hostError('host_version_mismatch'); }
  if (result.sdk !== DEEPSEEK_SDK_VERSION || result.runtime !== DEEPSEEK_SDK_VERSION
      || !Array.isArray(result.args) || !result.args.length || result.args.some(value => typeof value !== 'string' || value.length > 4096)
      || !path.isAbsolute(result.args[0])) throw hostError('host_version_mismatch');
  return result.args;
}

function ownedHostUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw hostError('host_protocol_mismatch'); }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || Number(url.port) < 1
      || url.username || url.password || url.pathname !== '/' || url.hash
      || url.searchParams.getAll('token').length !== 1 || [...url.searchParams.keys()].some(key => key !== 'token')
      || !/^[A-Za-z0-9_-]{20,512}$/.test(url.searchParams.get('token') || '')) throw hostError('host_protocol_mismatch');
  return url;
}

function localCookie(response) {
  const values = response.headers.getSetCookie?.() || [response.headers.get('set-cookie') || ''];
  const matching = values.map(value => value.split(';', 1)[0]).filter(value => /^dsh-auth-[A-Za-z0-9_-]+=[A-Za-z0-9_.-]+$/.test(value));
  if (matching.length !== 1) throw hostError('host_authentication_failed');
  return matching[0];
}

/** An app-owned, loopback-only official Web Host. Wire contract is from
 * dsh-v0.2.1-rc.2, commit 687f282e8625c6b8d11ff58211a90524be2e4317:
 * packages/client/connection/src/{client/rpc,rpc-schema,browser-auth}.ts.
 * The launch token is exchanged through the official root route. The resulting
 * local Host cookie stays in memory; no DeepSeek account grant crosses here. */
export function createDeepSeekWebHost(options) {
  const { python, home, patchPath } = options;
  const fetchImpl = options.fetchImpl || fetch;
  const spawnProcess = options.spawnProcess || spawn;
  const lifetime = new AbortController();
  const resolveCommand = options.resolveCommand || (() => officialCommand(python, home, lifetime.signal));
  let child, opening, closing, origin, cookie, closed = false;
  const exitListeners = new Set();
  const exited = () => !child || child.exitCode !== null || child.signalCode != null;

  async function open() {
    if (closed) throw hostError('host_closed');
    if (opening) return opening;
    opening = (async () => {
      fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const command = await resolveCommand();
      if (closed) throw hostError('host_closed');
      const launchUrl = await new Promise((resolve, reject) => {
        let buffer = '', finished = false;
        const timer = setTimeout(() => settle(hostError('host_start_timeout')), options.startupTimeoutMs ?? 45000);
        timer.unref?.();
        const abort = () => settle(hostError('host_closed'));
        function settle(error, value) {
          if (finished) return;
          finished = true; clearTimeout(timer); lifetime.signal.removeEventListener('abort', abort);
          if (error) reject(error); else resolve(value);
        }
        lifetime.signal.addEventListener('abort', abort, { once: true });
        try {
          child = spawnProcess(command[0], [...command.slice(1), '--profile', 'web', '--patch', patchPath,
            '--host', '127.0.0.1', '--port', '0', '--no-open'], {
            cwd: home, env: isolatedRuntimeEnv(home, { DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }),
            shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          });
        } catch { settle(hostError('host_start_failed')); return; }
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          if (finished) return;
          buffer += chunk;
          if (buffer.length > 65536) { settle(hostError('host_protocol_mismatch')); return; }
          for (;;) {
            const end = buffer.indexOf('\n');
            if (end < 0) break;
            const line = buffer.slice(0, end).replace(/\x1b\[[0-9;]*m/g, '').trim();
            buffer = buffer.slice(end + 1);
            if (!line.startsWith('dsh web: http://')) continue;
            try { settle(null, ownedHostUrl(line.slice('dsh web: '.length))); }
            catch { settle(hostError('host_protocol_mismatch')); }
          }
        });
        child.stderr?.on('data', () => {});
        child.once('error', () => settle(hostError('host_start_failed')));
        child.once('exit', () => {
          cookie = undefined;
          settle(hostError('host_exited'));
          for (const listener of exitListeners) listener();
        });
      });
      if (closed) throw hostError('host_closed');
      origin = launchUrl.origin;
      const response = await fetchImpl(launchUrl.href, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15000)]),
        headers: { Accept: 'text/html' },
      });
      if (response.status !== 303 || response.headers.get('location') !== './') throw hostError('host_authentication_failed');
      cookie = localCookie(response);
      try { await response.body?.cancel?.(); } catch {}
      if (closed) throw hostError('host_closed');
      return { origin };
    })();
    try { return await opening; }
    catch (failure) {
      await closeHost();
      throw hostError(typeof failure?.code === 'string' && failure.code.startsWith('host_') ? failure.code : 'host_connection_failed');
    }
  }

  async function call(endpoint, args = {}) {
    if (!ALLOWED_CALLS.has(endpoint)) throw hostError('host_method_not_allowed');
    await open();
    if (closed || exited() || !cookie) throw hostError('host_exited');
    const rpcId = randomUUID();
    let response;
    try {
      response = await fetchImpl(`${origin}/api/${endpoint}`, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(options.requestTimeoutMs ?? 35000)]),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', Origin: origin, Cookie: cookie },
        body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
      });
    } catch { throw hostError('host_connection_failed'); }
    if (response.status !== 200) {
      try { await response.body?.cancel?.(); } catch {}
      throw hostError(response.status === 401 ? 'host_authentication_failed' : 'host_request_failed');
    }
    let envelope;
    try { envelope = await boundedDeepSeekJson(response); } catch { throw hostError('host_protocol_mismatch'); }
    if (envelope?.type !== 'server-response' || envelope.rpcId !== rpcId || typeof envelope.result?.ok !== 'boolean') throw hostError('host_protocol_mismatch');
    if (!envelope.result.ok) throw hostError('host_remote_failed');
    return envelope.result.value;
  }

  async function waitForExit(ms) {
    if (exited()) return true;
    return new Promise(resolve => {
      const done = () => { clearTimeout(timer); exitListeners.delete(done); resolve(true); };
      const timer = setTimeout(() => { exitListeners.delete(done); resolve(exited()); }, ms);
      timer.unref?.(); exitListeners.add(done);
    });
  }

  async function closeHost() {
    if (closing) return closing;
    closed = true; lifetime.abort(); cookie = undefined;
    closing = (async () => {
      if (!exited()) {
        try { child.kill('SIGTERM'); } catch {}
        if (!await waitForExit(1500)) { try { child.kill('SIGKILL'); } catch {} await waitForExit(1000); }
      }
    })();
    return closing;
  }

  return {
    open, call,
    get origin() { return origin; },
    close: closeHost,
  };
}

/** OS handoff of an official authorization URL, without a shell or credential environment. */
export async function openDeepSeekAuthorization(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw hostError('authorization_url_invalid'); }
  if (parsed.origin !== 'https://platform.deepseek.com' || parsed.pathname !== '/dsh/authorize'
      || parsed.username || parsed.password || parsed.hash) throw hostError('authorization_url_invalid');
  const allowedEnvironment = /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|PROGRAMFILES(?:\(X86\))?|PROGRAMW6432|COMSPEC|SYSTEMDRIVE|HOMEDRIVE|HOMEPATH|LANG|LC_ALL|TZ|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnvironment.test(key)));
  const [command, args] = process.platform === 'win32' ? ['rundll32.exe', ['url.dll,FileProtocolHandler', parsed.href]]
    : process.platform === 'darwin' ? ['open', [parsed.href]] : ['xdg-open', [parsed.href]];
  try { await execFileAsync(command, args, { env, windowsHide: true, timeout: 10000, maxBuffer: 16384 }); }
  catch { throw hostError('browser_open_failed'); }
}

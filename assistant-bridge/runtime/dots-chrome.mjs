import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioRpc, isolatedRuntimeEnv } from './stdio-rpc.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'python', 'dots_chrome_fetch.py');

function pythonPath(toolsDir) {
  return path.join(toolsDir || '', 'muse-personal', 'venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
}

function dotsUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return url.protocol === 'https:' && url.hostname === 'chatgpt.com' && (!url.port || url.port === '443')
    && !url.username && !url.password && !url.hash && url.pathname.startsWith('/backend-api/') && !url.pathname.includes('\\');
}

/** Persistent Chrome-impersonating client for https://chatgpt.com/backend-api only. */
export function createChromeDotsFetch(options = {}) {
  const command = options.browserCommand || pythonPath(options.toolsDir);
  const args = options.browserArgs || ['-I', '-X', 'utf8', '-u', SCRIPT];
  const spawnProcess = options.spawnProcess;
  const home = options.dataDir ? path.join(options.dataDir, 'browser-home') : undefined;
  let rpc = null, opening = null, closed = false;

  function missing(message = '访问原 Dots 的浏览器组件尚未安装。') {
    return Object.assign(new Error(message), { code: 'runtime_missing' });
  }

  async function host() {
    if (closed) throw missing('原 Dots 的浏览器组件已关闭。');
    if (rpc && !rpc.closed) return rpc;
    if (opening) return opening;
    opening = (async () => {
      if (!options.browserCommand && !fs.existsSync(command)) throw missing();
      if (home) fs.mkdirSync(home, { recursive: true, mode: 0o700 });
      const transport = new StdioRpc({
        command, args, cwd: options.projectRoot, spawnProcess,
        env: isolatedRuntimeEnv(home || process.cwd(), { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', PYTHONDONTWRITEBYTECODE: '1' }),
        requestTimeoutMs: options.requestTimeoutMs ?? 30000,
        maxFrameBytes: 10 * 1024 * 1024,
      });
      transport.on('disconnect', () => { if (rpc === transport) rpc = null; });
      await transport.open();
      if (closed) { await transport.close(); throw missing('原 Dots 的浏览器组件已关闭。'); }
      rpc = transport;
      return transport;
    })().finally(() => { opening = null; });
    return opening;
  }

  async function fetch(url, init = {}) {
    if (!dotsUrl(url)) throw Object.assign(new Error('原 Dots 请求地址无效。'), { code: 'invalid_endpoint' });
    const headers = {};
    for (const [name, value] of Object.entries(init.headers || {})) {
      if (typeof value !== 'string') continue;
      const key = name.toLowerCase();
      if (['authorization', 'chatgpt-account-id', 'accept', 'oai-language', 'originator', 'oai-product-sku', 'content-type'].includes(key)) headers[name] = value;
    }
    const timeoutMs = options.requestTimeoutMs ?? 30000;
    let result;
    try {
      result = await (await host()).call('fetch', {
        url, method: init.method || 'GET', headers,
        body: typeof init.body === 'string' ? init.body : null,
        timeoutSeconds: Math.min(60, Math.max(1, Math.ceil(timeoutMs / 1000))),
      }, { timeoutMs: timeoutMs + 5000, signal: init.signal });
    } catch (failure) {
      if (failure?.code === 'runtime_missing' || failure?.code === 'invalid_endpoint' || failure?.code === 'ABORT_ERR' || init.signal?.aborted) throw failure;
      throw Object.assign(new Error('原 Dots 的浏览器请求没有完成。'), { code: failure?.data?.code || 'dots_network' });
    }
    const status = Number(result?.status);
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw Object.assign(new Error('原 Dots 的浏览器请求没有完成。'), { code: 'dots_network' });
    }
    if (status >= 300 && status < 400) throw Object.assign(new Error('原 Dots 拒绝了跳转。'), { code: 'dots_redirect' });
    const responseHeaders = new Headers();
    if (result.headers && typeof result.headers === 'object') {
      for (const name of ['content-type', 'cf-mitigated', 'retry-after']) {
        const value = result.headers[name];
        if (typeof value === 'string' && value.length <= 200) responseHeaders.set(name, value);
      }
    }
    return new Response(typeof result.body === 'string' ? result.body : '', { status, headers: responseHeaders });
  }

  return { fetch, async close() { closed = true; const current = rpc; rpc = null; if (current) await current.close(); } };
}

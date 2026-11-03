import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';

/** Bounded newline-delimited JSON-RPC transport for official local runtimes. */
export class StdioRpc extends EventEmitter {
  constructor({ command, args = [], cwd, env, spawnProcess = spawn, requestTimeoutMs = 30000, maxFrameBytes = 16 * 1024 * 1024 }) {
    super();
    this.options = { command, args, cwd, env, spawnProcess, requestTimeoutMs, maxFrameBytes };
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.closed = false;
    this.child = null;
    this.requestHandler = null;
  }

  async open() {
    if (this.child && !this.closed) return this;
    if (this.closed) throw new Error('Official runtime transport is closed.');
    const { command, args, cwd, env, spawnProcess } = this.options;
    const child = spawnProcess(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.#read(chunk));
    // stderr can contain account data. Consume it without exposing or persisting it.
    child.stderr?.on('data', () => {});
    child.once('error', error => this.#fail(new Error(`Official runtime failed to start (${error.code || 'spawn_error'}).`)));
    child.once('exit', (code, signal) => this.#fail(new Error(`Official runtime exited (${signal || (code ?? 'unknown')}).`)));
    await new Promise((resolve, reject) => {
      if (child.pid) return resolve();
      child.once('spawn', resolve);
      child.once('error', () => reject(new Error('Official runtime could not be started.')));
    });
    return this;
  }

  #read(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > this.options.maxFrameBytes) {
      this.#fail(new Error('Official runtime exceeded the protocol frame limit.'));
      this.child?.kill();
      return;
    }
    for (;;) {
      const end = this.buffer.indexOf('\n');
      if (end === -1) break;
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch {
        this.#fail(new Error('Official runtime returned invalid JSON-RPC.'));
        this.child?.kill();
        return;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        Promise.resolve().then(() => {
          if (!this.requestHandler) throw Object.assign(new Error('Unsupported client request.'), { code: -32601 });
          return this.requestHandler(message.method, message.params ?? {}, message.id);
        }).then(
          result => this.#write({ jsonrpc: '2.0', id: message.id, result: result ?? {} }),
          error => this.#write({ jsonrpc: '2.0', id: message.id, error: { code: Number.isInteger(error.code) ? error.code : -32603, message: 'Client request was not completed.' } })
        ).catch(() => {});
      } else this.emit('notification', message.method, message.params ?? {});
      return;
    }
    if (message.id === undefined) return;
    const key = `${typeof message.id}:${message.id}`;
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    if (message.error) {
      const error = new Error(typeof message.error.message === 'string' ? message.error.message : 'Official runtime request failed.');
      error.code = message.error.code;
      error.data = message.error.data;
      pending.reject(error);
    } else pending.resolve(message.result);
  }

  #write(message) {
    if (this.closed || !this.child?.stdin?.writable) return Promise.reject(new Error('Official runtime transport is not connected.'));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(new Error('Official runtime request could not be written.')) : resolve());
    });
  }

  call(method, params = {}, { timeoutMs = this.options.requestTimeoutMs, signal } = {}) {
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Request cancelled.'), { code: 'ABORT_ERR' }));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const key = `${typeof id}:${id}`;
      const fail = error => {
        const pending = this.pending.get(key);
        if (!pending) return;
        this.pending.delete(key);
        clearTimeout(pending.timer);
        pending.cleanup?.();
        reject(error);
      };
      const timer = timeoutMs > 0 ? setTimeout(() => fail(Object.assign(new Error(`Official runtime request timed out: ${method}.`), { code: 'RPC_TIMEOUT' })), timeoutMs) : null;
      timer?.unref?.();
      const onAbort = () => fail(Object.assign(new Error('Request cancelled.'), { code: 'ABORT_ERR' }));
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(key, { resolve, reject, timer, cleanup: () => signal?.removeEventListener('abort', onAbort) });
      this.#write({ jsonrpc: '2.0', id, method, params }).catch(fail);
    });
  }

  notify(method, params = {}) { return this.#write({ jsonrpc: '2.0', method, params }); }

  #fail(error) {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('disconnect', error);
  }

  async close() {
    if (this.closed) return;
    this.#fail(new Error('Official runtime connection closed.'));
    this.child?.stdin?.end();
    if (!this.child || this.child.exitCode !== null) return;
    const child = this.child;
    await new Promise(resolve => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 800);
      timer.unref?.();
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
  }
}

/** A fresh profile must not inherit another application's model credentials. */
export function isolatedRuntimeEnv(homeDirectory, extra = {}) {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(?:MUSE|DSH|DEEPSEEK)_/i.test(name) || /^(?:OPENAI|ANTHROPIC|GROK|XAI|META)_(?:API_?KEY|ACCESS_TOKEN|AUTH_TOKEN|TOKEN|BASE_URL|API_BASE|HOME|CONFIG.*|SESSION.*)$/i.test(name)) delete env[name];
  }
  return { ...env, HOME: homeDirectory, USERPROFILE: homeDirectory, XDG_CONFIG_HOME: homeDirectory,
    XDG_DATA_HOME: path.join(homeDirectory, 'data'), XDG_CACHE_HOME: path.join(homeDirectory, 'cache'),
    APPDATA: path.join(homeDirectory, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(homeDirectory, 'AppData', 'Local'), ...extra };
}

/** Real installed official Host check. Does not start login or submit a prompt.
 * Run from the AntDesk root: node assistant-bridge/tests/deepseek-account-smoke.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createDeepSeekAccount } from '../runtime/deepseek-account.mjs';
import { createDeepSeekAdapter } from '../runtime/deepseek.mjs';
import { isolatedRuntimeEnv, StdioRpc } from '../runtime/stdio-rpc.mjs';

const projectRoot = path.resolve(process.argv[2] || process.cwd());
const toolsDir = path.join(projectRoot, '.antdesk', 'runtime-tools');
const python = path.join(toolsDir, 'deepseek', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
const qaRoot = path.join(projectRoot, '.antdesk', 'qa');
fs.mkdirSync(qaRoot, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(qaRoot, 'deepseek-smoke-'));
let browserOpened = false;
const account = createDeepSeekAccount({ dataDir, python, openBrowser: async () => { browserOpened = true; throw new Error('Smoke must never open a browser.'); } });
let result, failed = false, stage = 'account-getState', rpc, adapter;
try {
  result = await account.refresh();
  assert.equal(result.state, 'idle', `${result.message} (${result.hostCode || result.code || ''})`);
  assert.equal(result.accountStored, false);
  assert.equal(browserOpened, false);
  stage = 'account-sdk-profile';
  adapter = createDeepSeekAdapter({ projectRoot, toolsDir, dataDir, accountController: account,
    getConfig: () => ({ authMode: 'account' }), setConfig: () => {}, getSecret: () => undefined, setSecret: () => {} });
  const cwd = path.join(dataDir, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  rpc = new StdioRpc({ command: python,
    args: ['-I', '-X', 'utf8', '-u', path.join(projectRoot, 'assistant-bridge', 'runtime', 'python', 'deepseek_worker.py')],
    cwd, env: isolatedRuntimeEnv(account.home, { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }), requestTimeoutMs: 45000 });
  await rpc.open();
  const initialized = await rpc.call('initialize', { home: account.home, cwd, authMode: 'account', model: 'deepseek-flash', patchPath: path.join(dataDir, 'account-sdk.patch.json') });
  assert.equal(initialized.initialized, true);
  assert.equal(initialized.sdkVersion, '0.2.1rc2');
  await rpc.call('shutdown', {}, { timeoutMs: 6000 });
  console.log(JSON.stringify({ ok: true, officialHost: '0.2.1-rc.2', accountRpc: 'signed-out', accountSdkProfile: 'initialized', browserOpened: false, promptSubmitted: false }));
} catch (error) {
  failed = true;
  console.log(JSON.stringify({ ok: false, stage, state: result?.state, code: result?.code,
    hostCode: result?.hostCode, message: result?.message,
    ...(typeof error?.data?.kind === 'string' && /^[A-Za-z]{1,80}$/.test(error.data.kind) ? { workerError: error.data.kind } : {}),
    ...(typeof error?.data?.runtimeCode === 'string' && /^[A-Z_]{1,80}$/.test(error.data.runtimeCode) ? { runtimeCode: error.data.runtimeCode } : {}),
    browserOpened, promptSubmitted: false }));
} finally {
  if (rpc) { try { await rpc.call('shutdown', {}, { timeoutMs: 6000 }); } catch {} await rpc.close(); }
  await adapter?.close();
  await account.close();
  try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
  catch { console.log(JSON.stringify({ cleanup: 'pending-file-lock', generatedDirectory: dataDir })); }
}
if (failed) process.exitCode = 1;

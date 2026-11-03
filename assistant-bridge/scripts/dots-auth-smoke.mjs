/** Exercise the installed official login host without an account or model call.
 * Optional --start-login requests a fresh OAuth URL, then cancels it without
 * opening a browser. Only booleans, status enums and the URL host are printed. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createDotsAuth } from '../runtime/dots-auth.mjs';

const args = process.argv.slice(2);
const projectRoot = path.resolve(args.find(arg => !arg.startsWith('--')) || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..'));
const qaRoot = path.join(projectRoot, '.antdesk', 'qa');
fs.mkdirSync(qaRoot, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(qaRoot, 'dots-owned-auth-'));
const auth = createDotsAuth({ dataDir, toolsDir: path.join(projectRoot, '.antdesk', 'runtime-tools'), requestTimeoutMs: 20000 });
const output = {};
try {
  const initial = await auth.status();
  output.initial = { installed: initial.installed, readiness: initial.readiness, ...(initial.diagnostic ? { diagnostic: initial.diagnostic } : {}) };
  assert.equal(initial.installed, true, 'The pinned official login binary is missing.');
  assert.equal(initial.readiness, 'needs_login', 'A fresh owned host must not inherit a signed-in account.');
  assert.equal(initial.diagnostic, undefined, 'The official owned host did not initialize cleanly.');
  assert.equal(await auth.getAuth(), null, 'A fresh profile must not supply any existing token.');
  output.freshProfileHasToken = false;
  if (args.includes('--start-login')) {
    const started = await auth.login('start');
    output.freshLogin = { state: started.state, loginIdPresent: typeof started.loginId === 'string',
      officialHost: started.url ? new URL(started.url).hostname : null,
      ...(started.diagnostic ? { diagnostic: started.diagnostic } : {}) };
    assert.equal(started.state, 'pending', 'The official host did not create a fresh authorization flow.');
    assert.ok(started.loginId && started.url, 'The authorization response was incomplete.');
    const cancelled = await auth.login('cancel');
    output.cancelled = cancelled.state;
    assert.equal(cancelled.state, 'idle');
    assert.equal(await auth.getAuth(), null, 'A cancelled, unopened login must not have a token.');
  }
  const loggedOut = await auth.login('logout');
  output.loggedOut = loggedOut.state;
  assert.equal(loggedOut.state, 'idle');
  output.passed = true;
} catch (failure) {
  output.passed = false;
  // Upstream error objects, authorization URLs and credentials are never logged.
  output.failureCode = ['ERR_ASSERTION', 'runtime_missing', 'runtime_closed', 'connection_failed', 'protocol_mismatch'].includes(failure?.code)
    ? failure.code : 'smoke_failed';
  process.exitCode = 1;
} finally {
  // Print the protocol result first. A Windows process/file-lock cleanup
  // problem must never replace the useful initialization/login diagnosis.
  console.log(JSON.stringify({ stage: 'protocol', ...output }));
  const cleanup = { stage: 'cleanup', processClosed: false, profileRemoved: false };
  try { await auth.close(); cleanup.processClosed = true; }
  catch { cleanup.failureCode = 'runtime_close_incomplete'; process.exitCode = 1; }
  if (cleanup.processClosed) {
    try { fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 250 }); cleanup.profileRemoved = true; }
    catch (failure) { cleanup.failureCode = ['EPERM', 'EBUSY', 'EACCES'].includes(failure?.code) ? failure.code : 'cleanup_failed'; process.exitCode = 1; }
  }
  console.log(JSON.stringify(cleanup));
}

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antdesk-bridge-cli-'));
  const config = path.join(dir, 'config.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args, '--config', config], { encoding: 'utf8', timeout: 10000 });
  const initial = run('init');
  assert.equal(initial.status, 0, initial.stderr);
  return { run, config, initial };
}
test('initialization creates distinct identities without printing secrets and never rotates an existing config', t => {
  const { run, config, initial } = workspace(t);
  const before = fs.readFileSync(config, 'utf8');
  const data = JSON.parse(before);
  const keys = [data.adminToken, ...data.botTokens.map(item => item.token)];
  assert.equal(new Set(keys).size, 3);
  for (const value of keys) { assert.ok(value.length >= 32); assert.ok(!initial.stdout.includes(value)); }
  assert.equal(data.publicUrl, '');
  assert.equal(run('init').status, 0);
  assert.equal(fs.readFileSync(config, 'utf8'), before);
});
test('key access requires an explicit disclosure action', t => {
  const { run, config } = workspace(t);
  const data = JSON.parse(fs.readFileSync(config, 'utf8'));
  const result = run('key', 'desktop');
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes(data.adminToken));
  assert.ok(!result.stderr.includes(data.adminToken));
  const explicit = run('key', 'desktop', '--show');
  assert.equal(explicit.status, 0);
  assert.equal(explicit.stdout.trim(), data.adminToken);
});
test('public URL configuration requires a clean HTTPS origin and preserves credentials', t => {
  const { run, config } = workspace(t);
  const before = JSON.parse(fs.readFileSync(config, 'utf8'));
  for (const value of ['http://example.test', 'https://secret:token@example.test', 'https://example.test:8443', 'https://example.test/mcp', 'https://example.test/?key=secret']) {
    assert.notEqual(run('set-public-url', value).status, 0);
    assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), before);
  }
  const configured = run('set-public-url', 'https://assistant.example.test/');
  assert.equal(configured.status, 0, configured.stderr);
  const after = JSON.parse(fs.readFileSync(config, 'utf8'));
  assert.equal(after.publicUrl, 'https://assistant.example.test');
  assert.equal(after.adminToken, before.adminToken);
  assert.deepEqual(after.botTokens, before.botTokens);
});

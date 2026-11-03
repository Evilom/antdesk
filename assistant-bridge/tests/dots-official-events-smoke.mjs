import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../server.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const official = path.join(root, '.antdesk/runtime-tools/dots-tunnel/tunnel-client.exe');

// Synthetic credentials and an isolated store; never a real OpenAI account.
test('official Tunnel process starts with a scoped local MCP and honest cloud readiness', { timeout: 15000 }, async t => {
  if (!fs.existsSync(official)) { t.skip('Pinned official Tunnel client is not installed.'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'antdesk-official-events-'));
  const toolsDir = path.join(dir, 'tools');
  fs.mkdirSync(path.join(toolsDir, 'dots-tunnel'), { recursive: true });
  fs.copyFileSync(official, path.join(toolsDir, 'dots-tunnel/tunnel-client.exe'));
  const adminToken = randomBytes(32).toString('base64url');
  const runtimeKey = randomBytes(24).toString('base64url');
  const tunnelId = 'tunnel_0123456789abcdef0123456789abcdef';
  const bridge = await createBridge({ storePath: path.join(dir, 'state.json'), adminToken, projectRoot: root, toolsDir });
  try {
    const base = await bridge.listen();
    const provider = await (await fetch(base + '/api/runtime/providers/dots-direct/configure', { method: 'POST',
      headers: { Authorization: 'Bearer ' + adminToken, 'Content-Type': 'application/json' },
      body: JSON.stringify({ transport: 'events', tunnelId, tunnelApiKey: runtimeKey, action: 'start' }) })).json();
    assert.equal(provider.transport, 'events');
    assert.notEqual(provider.readiness, 'ready');
    const token = bridge.state.unseal(bridge.state.data.runtime.providers['dots-direct'].secrets.mcpToken);
    const response = await fetch(base + '/mcp', { method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', 'X-AntDesk-Discovery': '1' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    const result = await response.json();
    assert.ok(result.result.tools.some(tool => tool.name === 'get_task'));
    assert.equal(bridge.state.data.agents['omdot-events'], undefined);
    assert.equal((await fetch(base + '/api/runtime/providers', { headers: { Authorization: 'Bearer ' + token } })).status, 401);
  } finally {
    await bridge.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

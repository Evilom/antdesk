#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const command = args.shift() || 'help';
const positional = [];
const options = {};
for (let i = 0; i < args.length; i++) {
  const value = args[i];
  if (!value.startsWith('--')) { positional.push(value); continue; }
  const name = value.slice(2);
  if (['copy', 'show'].includes(name)) options[name] = true;
  else if (['config', 'public-url', 'port'].includes(name) && args[i + 1] && !args[i + 1].startsWith('--')) options[name] = args[++i];
  else throw new Error('未知参数或缺少值：' + value);
}
const configPath = path.resolve(options.config || path.join(project, '.antdesk', 'native-bridge', 'config.json'));

function publicUrl(value) {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('公网地址必须是 HTTPS 地址。'); }
  if (url.protocol !== 'https:' || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('公网地址必须使用 HTTPS 默认端口，不带路径、凭据或查询参数，例如 https://assistant.example.com。');
  }
  return url.origin;
}
function portNumber(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1 到 65535 之间。');
  return port;
}
function saveConfig(config, exclusive = false) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 });
  if (exclusive) {
    const fd = fs.openSync(configPath, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
  } else {
    const temp = configPath + '.tmp-' + process.pid;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(config, null, 2) + '\n'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, configPath);
  }
}
function loadConfig() {
  if (!fs.existsSync(configPath)) throw new Error('尚未初始化连接服务，请先运行 npm run bridge:init。');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (config.version !== 1 || typeof config.adminToken !== 'string' || config.adminToken.length < 32 || !Array.isArray(config.botTokens)) {
    throw new Error('连接服务配置无效；不会覆盖已有配置。');
  }
  config.publicUrl = publicUrl(config.publicUrl);
  config.port = portNumber(config.port);
  if (config.host !== '127.0.0.1') throw new Error('本机连接服务仅监听 127.0.0.1；请通过 HTTPS 反向代理提供云端入口。');
  return config;
}
function copySecret(value) {
  if (process.platform !== 'win32') throw new Error('当前复制命令仅支持 Windows；可在私密终端使用 --show。');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$inputValue = [Console]::In.ReadToEnd(); Set-Clipboard -Value $inputValue'], {
    input: value, encoding: 'utf8', windowsHide: true, timeout: 10000,
  });
  if (result.error || result.status !== 0) throw new Error('未能复制到系统剪贴板。');
  console.log('密钥已复制到剪贴板，未输出到终端。粘贴后请清理剪贴板。');
}
async function main() {
  if (command === 'init') {
    if (fs.existsSync(configPath)) {
      loadConfig();
      console.log('配置已存在，保持现有身份和密钥：' + configPath);
      return;
    }
    const secret = () => randomBytes(32).toString('base64url');
    const config = { version: 1, host: '127.0.0.1', port: portNumber(options.port || 47631), publicUrl: publicUrl(options['public-url'] || ''), adminToken: secret(), botTokens: ['grokbot', 'gptdot'].map(agentId => ({ agentId, token: secret() })) };
    saveConfig(config, true);
    console.log('已创建本机连接配置：' + configPath);
    console.log('服务地址：http://127.0.0.1:' + config.port);
    console.log(config.publicUrl ? '云端 MCP 地址：' + config.publicUrl + '/mcp' : '尚未配置公网 HTTPS 地址；云端助理会显示“等待接入”。');
    console.log('启动：npm run bridge:start；复制桌面连接密钥：npm run bridge:key -- desktop --copy');
    return;
  }
  if (command === 'set-public-url') {
    const value = positional[0] || options['public-url'];
    if (!value) throw new Error('请提供你实际控制的公网 HTTPS 源地址。');
    const config = loadConfig();
    config.publicUrl = publicUrl(value);
    saveConfig(config);
    console.log('已保存云端 MCP 地址：' + config.publicUrl + '/mcp');
    console.log('请重启连接服务，并重新授权或订阅；地址变更不会自动迁移已有会话。');
    return;
  }
  if (command === 'key') {
    const config = loadConfig();
    const role = positional[0];
    const value = role === 'desktop' ? config.adminToken : config.botTokens.find(item => item.agentId === role)?.token;
    if (!value) throw new Error('请选择 desktop、grokbot 或 gptdot。');
    if (options.copy) copySecret(value);
    else if (options.show) process.stdout.write(value + '\n');
    else throw new Error('密钥不会默认打印；请显式指定 --copy，或在私密终端使用 --show。');
    return;
  }
  if (command === 'status') {
    const config = loadConfig();
    for (const [agentId, protocol] of [['grokbot', 'grok-webhook'], ['gptdot', 'dots-mcp']]) {
      const url = new URL('http://127.0.0.1:' + config.port + '/api/status');
      url.searchParams.set('agentId', agentId); url.searchParams.set('protocol', protocol);
      let response;
      try { response = await fetch(url, { headers: { authorization: 'Bearer ' + config.adminToken }, signal: AbortSignal.timeout(5000), redirect: 'error' }); }
      catch { throw new Error('连接服务未运行或暂时不可达，请运行 npm run bridge:start。'); }
      if (!response.ok) throw new Error('连接服务检查失败（HTTP ' + response.status + '）。');
      const body = await response.json();
      console.log(JSON.stringify({ agentId, protocol, ready: body.ready, readiness: body.readiness, message: body.message, mcpUrl: body.mcpUrl || undefined }));
    }
    return;
  }
  if (command === 'start') {
    const config = loadConfig();
    const { createBridge } = await import('./server.mjs');
    const bridge = await createBridge({ ...config, projectRoot:project, storePath: path.join(path.dirname(configPath), 'state.json') });
    try { await bridge.listen(config.port, config.host); }
    catch (error) { await bridge.close(); throw error; }
    console.log('AntDesk 连接服务已启动：' + bridge.baseUrl);
    console.log(config.publicUrl ? '云端 MCP：' + config.publicUrl + '/mcp' : '本机助理连接已就绪；云端 MCP 另需公网 HTTPS 地址。');
    let closing = false;
    const shutdown = async () => { if (closing) return; closing = true; try { await bridge.close(); } catch { process.exitCode = 1; } };
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
    return;
  }
  if (command !== 'help') throw new Error('未知命令：' + command);
  console.log(`AntDesk 官方助理连接服务\n\n  init [--public-url https://your-domain.example] [--port 47631]\n  start\n  status\n  set-public-url https://your-domain.example\n  key desktop|grokbot|gptdot --copy\n\n所有命令支持 --config <本机配置文件路径>。\ninit 不覆盖已有配置。状态检查不派发 Bot 任务。`);
}
main().catch(error => {
  console.error('AntDesk bridge: ' + (error.code === 'EADDRINUSE' ? '端口已占用，请检查是否已有连接服务正在运行。' : error.message));
  process.exitCode = 1;
});

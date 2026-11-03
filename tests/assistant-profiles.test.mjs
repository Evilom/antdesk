import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultProfiles, normalizeProfiles, validateProfile, isProfileConfigured, connectionKey, isActiveRun, runStatusLabel, isRuntimeProfile, personalAssistantProfiles, PERSONAL_ASSISTANT_PROTOCOLS, PROTOCOLS } from '../src/lib/assistant-profiles.mjs';

const legacyMcp = () => ({ id: 'gptdot', name: 'omdot', endpoint: 'http://127.0.0.1:47631', model: '', protocol: 'dots-mcp', agentRef: 'gptdot', webhookUrl: '', description: '已有 MCP 配置' });
const legacyDeepSeek = () => ({ id: 'deepseek', name: 'DeepSeek Harness', endpoint: 'http://127.0.0.1:47631', model: '', protocol: 'deepseek-harness', agentRef: 'deepseek', webhookUrl: '' });

test('unconfigured builtins migrate to direct routes while retaining custom names', () => {
  const result = normalizeProfiles([
    { id: 'grokbot', name: 'Grokbot', protocol: 'openai', endpoint: '', model: '' },
    { id: 'gptdot', name: '我的长期助理', protocol: 'openai', endpoint: '', model: '', description: '整理工作' },
    { id: 'museai', name: 'MuseAI', protocol: 'openai', endpoint: '', model: '' },
  ]);
  assert.equal(result[0].protocol, 'grok-direct');
  assert.equal(result[1].protocol, 'dots-mcp');
  assert.equal(result[1].name, '我的长期助理');
  assert.equal(result[1].description, '整理工作');
  assert.equal(result[2].protocol, 'muse-personal');
  assert.equal(isRuntimeProfile(result[2]), true);
});

test('configured OpenAI services stay on their original route and never inherit credential data', () => {
  const [profile] = normalizeProfiles([{ id: 'grokbot', name: 'Grokbot', endpoint: 'https://models.example/v1', model: 'custom', protocol: 'openai', apiKey: 'secret', bridgeCredential: 'private', ready: true }]);
  assert.equal(profile.protocol, 'openai');
  assert.equal(profile.endpoint, 'https://models.example/v1');
  assert.equal(profile.model, 'custom');
  assert.equal('apiKey' in profile, false);
  assert.equal('bridgeCredential' in profile, false);
  assert.equal('ready' in profile, false);
});

test('empty or invalid saved arrays still expose the native setup paths', () => {
  for (const value of [null, [], [{ id: 'a' }], 'bad']) {
    assert.deepEqual(normalizeProfiles(value).map(p => p.protocol), ['muse-personal', 'grok-direct', 'dots-direct', 'notion-web']);
  }
  assert.equal(defaultProfiles().find(p => p.protocol === 'dots-direct').name, 'GPT · omdot');
});

test('unknown protocols are never silently routed to a model', () => {
  const [profile] = normalizeProfiles([{ id: 'future', name: '未来助理', endpoint: 'https://example.org', model: 'x', protocol: 'future-protocol' }]);
  assert.equal(isProfileConfigured(profile), false);
});

test('native identities survive save and reload without requiring a model', () => {
  const original = { ...legacyMcp(), agentRef: 'omdot-work', model: '' };
  const normalized = validateProfile(original);
  assert.equal(normalized.agentRef, 'omdot-work');
  assert.equal(normalized.model, '');
  assert.equal(normalizeProfiles([normalized])[0].protocol, 'dots-mcp');
  assert.equal(isProfileConfigured(normalized), true);
});

test('Grok needs its official webhook, and secret-shaped URLs are rejected', () => {
  const grok = { ...defaultProfiles().find(p => p.protocol === 'grok-direct'), protocol: 'grok-webhook', agentRef: 'grokbot' };
  assert.equal(isProfileConfigured(grok), false);
  assert.throws(() => validateProfile({ ...grok, webhookUrl: 'http://127.0.0.1/hook' }), /HTTPS/);
  assert.throws(() => validateProfile({ ...grok, webhookUrl: 'https://example.com/hook?key=secret' }), /查询参数/);
  assert.throws(() => validateProfile({ ...grok, endpoint: 'http://remote.example', webhookUrl: 'https://example.com/hook' }), /HTTPS/);
  assert.equal(validateProfile({ ...grok, webhookUrl: 'https://hooks.example/grok' }).webhookUrl, 'https://hooks.example/grok');
});

test('routing changes invalidate readiness even when profile id is reused', () => {
  const original = legacyMcp();
  assert.notEqual(connectionKey(original), connectionKey({ ...original, agentRef: 'another-dot' }));
  assert.notEqual(connectionKey(original), connectionKey({ ...original, endpoint: 'https://another.example' }));
});

test('native interrupted runs retain task ownership and do not invite duplicate dispatch', () => {
  const native = { status: 'interrupted', protocol: 'dots-mcp', externalRunId: 'r-1' };
  assert.equal(isActiveRun(native), true);
  assert.equal(isActiveRun({ ...native, protocol: 'openai' }), false);
  assert.equal(isActiveRun({ ...native, externalRunId: undefined }), false);
  assert.equal(isActiveRun({ ...native, status: 'cancelled' }), false);
});

test('an accepted webhook stays waiting; progress and results have distinct labels', () => {
  const native = { status: 'running', protocol: 'grok-webhook', deliveryStatus: 'accepted', progress: '' };
  assert.equal(runStatusLabel(native), '已送达 · 等待回报');
  assert.equal(runStatusLabel({ ...native, deliveryStatus: 'unknown' }), '派发待核实');
  assert.equal(runStatusLabel({ ...native, progress: '已开始查资料' }), '处理中');
  assert.equal(runStatusLabel({ ...native, status: 'review' }), '待复核');
  assert.equal(runStatusLabel({ ...native, status: 'cancelled' }), '已停止等待');
});

test('existing OpenAI HTTP LAN services remain configurable', () => {
  const [profile] = normalizeProfiles([{ id: 'grokbot', name: '已有模型', endpoint: 'http://192.168.1.23:8080/v1', model: 'local', protocol: 'openai' }]);
  assert.equal(profile.protocol, 'openai');
  assert.equal(isProfileConfigured(profile), true);
  assert.equal(validateProfile(profile).endpoint, 'http://192.168.1.23:8080/v1');
  const legacy = normalizeProfiles(null, { aiEndpoint: 'http://192.168.1.23:8080/v1', aiModel: 'local' });
  assert.equal(legacy.find(item => item.id === 'existing-text').protocol, 'openai');
  assert.throws(() => validateProfile({ ...legacyMcp(), endpoint: 'http://192.168.1.23:47631' }), /HTTPS/);
});

test('configured webhook remains intact and direct runtimes get distinct profiles', () => {
  const existing = { id: 'grokbot', name: '我的原 Bot', protocol: 'grok-webhook', endpoint: 'https://bridge.example', agentRef: 'my-agent', webhookUrl: 'https://hooks.example/original', model: '' };
  const profiles = normalizeProfiles([existing, { id: 'museai', name: 'Muse', protocol: 'muse-manual', endpoint: '', model: '', agentRef: 'my-original-session' }]);
  assert.equal(profiles[0].protocol, 'grok-webhook');
  assert.equal(profiles[0].webhookUrl, existing.webhookUrl);
  assert.equal(profiles[0].agentRef, 'my-agent');
  assert.equal(profiles.find(p => p.protocol === 'grok-direct').id, 'grok-direct');
  assert.equal(new Set(profiles.map(p => p.id)).size, profiles.length);
  assert.equal(profiles.filter(isRuntimeProfile).length, 4);
  assert.equal(normalizeProfiles(profiles).length, profiles.length);
  assert.equal(profiles.find(p => p.id === 'museai').protocol, 'muse-manual');
});

test('Grok direct saves incomplete setup but dispatch requires a selected original Bot', () => {
  const grok = defaultProfiles().find(p => p.protocol === 'grok-direct');
  assert.equal(validateProfile(grok).agentRef, '');
  assert.equal(isProfileConfigured(grok), false);
  const configured = validateProfile({ ...grok, agentRef: 'bot-original', sessionId: 'session-original' });
  assert.equal(isProfileConfigured(configured), true);
  assert.equal(normalizeProfiles([configured])[0].sessionId, 'session-original');
  assert.notEqual(connectionKey(configured), connectionKey({ ...configured, sessionId: 'new-session' }));
  assert.equal(PROTOCOLS['grok-direct'].official, false);
});

test('runtime normalization retains session routing but strips credentials and transient status', () => {
  const source = { ...legacyDeepSeek(), sessionId: 's'.repeat(300), apiKey: 'must-not-persist', accessToken: 'must-not-persist', readiness: 'ready', login: { state: 'ready' } };
  const clean = normalizeProfiles([source])[0];
  assert.equal(clean.sessionId.length, 256);
  for (const key of ['apiKey', 'accessToken', 'readiness', 'login']) assert.equal(key in clean, false);
  assert.equal(validateProfile(source).sessionId.length, 256);
});

test('runtime attention and cancellation labels reflect actual state', () => {
  const run = { status: 'running', protocol: 'muse-code', sessionId: 'original', attention: { kind: 'approval' } };
  assert.equal(runStatusLabel(run), '等待审批');
  assert.equal(runStatusLabel({ ...run, attention: { kind: 'input' } }), '需要你补充');
  assert.equal(runStatusLabel({ ...run, status: 'interrupted' }), '等待审批');
  assert.equal(isActiveRun({ ...run, status: 'interrupted' }), true);
  assert.equal(runStatusLabel({ ...run, status: 'cancelled', remoteStopped: false }), '已停止等待');
  assert.equal(runStatusLabel({ ...run, status: 'cancelled', remoteStopped: true }), '已取消运行');
});

test('empty original Muse placeholder migrates without becoming Muse Code', () => {
  const [profile] = normalizeProfiles([{ id: 'museai', name: 'Muse', protocol: 'muse-manual', endpoint: '', model: '', agentRef: 'museai', description: '旧待接入说明' }]);
  assert.equal(profile.protocol, 'muse-personal');
  assert.equal(profile.name, 'Muse AI');
  assert.equal(PROTOCOLS[profile.protocol].official, false);
  assert.equal(isRuntimeProfile(profile), true);
  assert.equal(normalizeProfiles([profile]).filter(item => item.protocol === 'muse-personal').length, 1);
  assert.equal(defaultProfiles().filter(item => item.protocol === 'muse-code').length, 0);
});

test('original Muse always uses a separate task session instead of a saved main conversation', () => {
  const profile = { ...defaultProfiles().find(item => item.protocol === 'muse-personal'), sessionId: 'existing-main-conversation' };
  assert.equal(validateProfile(profile).sessionId, '');
  assert.equal(validateProfile({ ...profile, id: 'local-alias', agentRef: 'museai' }).agentRef, 'muse-personal');
  assert.equal(normalizeProfiles([profile])[0].sessionId, '');
  assert.equal(normalizeProfiles([{ ...profile, agentRef: 'museai' }])[0].agentRef, 'muse-personal');
  assert.equal(profile.sessionId, 'existing-main-conversation');
});


test('Dots direct preserves existing MCP settings and requires an original Dot selection', () => {
  const mcp = { ...legacyMcp(), endpoint: 'https://existing.example', agentRef: 'long-term-dot' };
  const profiles = normalizeProfiles([mcp]);
  assert.deepEqual(profiles[0], { ...mcp, sessionId: '' });
  const direct = profiles.find(p => p.protocol === 'dots-direct');
  assert.equal(validateProfile(direct).agentRef, '');
  assert.equal(isProfileConfigured(direct), false);
  assert.equal(isProfileConfigured({ ...direct, agentRef: 'original-dot-id' }), true);
  assert.equal(PROTOCOLS['dots-direct'].official, false);
  assert.equal(normalizeProfiles(profiles).length, profiles.length);
});


test('the three original assistants and Notion are shown while saved legacy routes remain intact', () => {
  const hidden = [legacyMcp(), legacyDeepSeek(), { ...legacyDeepSeek(), id: 'musecode', name: 'My Code', protocol: 'muse-code', sessionId: 'old-code-session' }];
  const grok = { ...defaultProfiles().find(p => p.protocol === 'grok-direct'), agentRef: 'my-original-bot', sessionId: 'original-session', name: '我的 Grok' };
  const saved = [...hidden, grok];
  const before = JSON.stringify(saved);
  const all = normalizeProfiles(saved);
  const visible = personalAssistantProfiles(all);
  assert.deepEqual(visible.map(p => p.protocol), PERSONAL_ASSISTANT_PROTOCOLS);
  assert.equal(visible.length, 4);
  assert.equal(visible.find(p => p.protocol === 'grok-direct').agentRef, grok.agentRef);
  assert.equal(visible.find(p => p.protocol === 'grok-direct').sessionId, grok.sessionId);
  assert.equal(visible.find(p => p.protocol === 'grok-direct').name, grok.name);
  for (const original of hidden) assert.deepEqual(all.find(p => p.id === original.id), { ...original, description: original.description || '', sessionId: original.sessionId || '' });
  assert.equal(JSON.stringify(saved), before);
  assert.equal(normalizeProfiles(all).length, all.length);
});

test('one visible entry per service prefers an existing configured identity over an empty default', () => {
  const defaults = defaultProfiles();
  const dot = { ...defaults.find(p => p.protocol === 'dots-direct'), id: 'my-existing-dot', agentRef: 'original-dot', sessionId: 'original-room', name: '长期助理' };
  const all = normalizeProfiles([...defaults, dot, legacyMcp()]);
  const visible = personalAssistantProfiles(all);
  assert.equal(visible.length, 4);
  assert.equal(visible.find(p => p.protocol === 'dots-direct').id, dot.id);
  assert.equal(all.find(p => p.id === 'gptdot').protocol, 'dots-mcp');
  assert.equal(isActiveRun({ status: 'interrupted', protocol: 'muse-code', externalRunId: 'old-run' }), true);
  assert.equal(isActiveRun({ status: 'interrupted', protocol: 'deepseek-harness', externalRunId: 'old-run' }), true);
});

test('a full legacy roster and colliding IDs keep their settings when the four personal routes are added', () => {
  const hidden = Array.from({length: 20}, (_, index) => ({ ...legacyMcp(), id: index === 0 ? 'grokbot' : index === 1 ? 'grok-direct' : 'old-' + index }));
  const all = normalizeProfiles(hidden);
  const visible = personalAssistantProfiles(all);
  assert.equal(all.length, 24);
  assert.equal(visible.length, 4);
  assert.equal(visible.find(p => p.protocol === 'grok-direct').id, 'grok-direct-2');
  assert.equal(new Set(all.map(p => p.id)).size, all.length);
  assert.deepEqual(normalizeProfiles(all), all);
  for (const profile of hidden) assert.equal(all.find(p => p.id === profile.id).protocol, 'dots-mcp');
});

test('Notion adds one web-membership profile without replacing the three saved assistants', () => {
  const original = defaultProfiles().filter(profile => profile.protocol !== 'notion-web').map(profile => ({
    ...profile, name: '我的 ' + profile.name,
    ...(profile.protocol === 'grok-direct' ? { agentRef: 'my-grok', sessionId: 'grok-room', model: 'saved-grok-model' } : {}),
    ...(profile.protocol === 'dots-direct' ? { agentRef: 'my-dot', sessionId: 'dot-room' } : {}),
  }));
  const before = structuredClone(original);
  const result = normalizeProfiles(original);
  assert.deepEqual(original, before, 'Migration must not mutate the stored input');
  assert.deepEqual(result.slice(0, original.length), original);
  assert.equal(result.length, 4);
  const notion = result.find(profile => profile.protocol === 'notion-web');
  assert.equal(notion.name, 'Notion AI');
  assert.equal(notion.agentRef, 'notion-web');
  assert.equal(notion.model, '', 'First use leaves model selection to Notion');
  assert.equal(notion.sessionId, '', 'A saved remote conversation must not be reused');
  assert.equal(PROTOCOLS['notion-web'].official, false);
  assert.equal(isRuntimeProfile(notion), true);
  assert.deepEqual(normalizeProfiles(result), result, 'Reloading must not append another Notion profile');
});

test('Notion saves Auto or an account-selected model without inserting a fixed catalog model', () => {
  const preset = defaultProfiles().find(profile => profile.protocol === 'notion-web');
  assert.equal(preset.model, '');
  for (const model of ['', 'auto', 'account-selected/model-v2']) {
    const saved = validateProfile({ ...preset, model });
    assert.equal(saved.model, model);
    assert.equal(isProfileConfigured(saved), true, 'Web login routing does not require an API model');
    assert.equal(normalizeProfiles([saved]).find(profile => profile.id === saved.id).model, model);
  }
  assert.notEqual(connectionKey(preset), connectionKey({ ...preset, model: 'account-selected/model-v2' }));
});

test('Notion normalizes its route and never stores account cookies or a shared remote thread in the profile', () => {
  const original = {
    ...defaultProfiles().find(profile => profile.protocol === 'notion-web'),
    id: 'my-notion', name: '我的制作人', agentRef: 'foreign-agent', sessionId: 'existing-private-thread',
    model: 'account-selected-model', cookies: 'private-cookie', token_v2: 'private-token', apiKey: 'private-key',
    account: { id: 'private-account' }, workspaceId: 'private-workspace', readiness: 'ready', aiVerified: true,
  };
  for (const normalized of [validateProfile(original), normalizeProfiles([original])[0]]) {
    assert.equal(normalized.id, original.id);
    assert.equal(normalized.name, original.name);
    assert.equal(normalized.agentRef, 'notion-web');
    assert.equal(normalized.sessionId, '');
    assert.equal(normalized.model, original.model);
    for (const key of ['cookies', 'token_v2', 'apiKey', 'account', 'workspaceId', 'readiness', 'aiVerified']) {
      assert.equal(key in normalized, false, key + ' belongs outside the saved assistant profile');
    }
  }
  assert.equal(original.sessionId, 'existing-private-thread');
  assert.equal(original.agentRef, 'foreign-agent');
});

test('Notion ID collisions preserve legacy routes and remain stable after reload', () => {
  const original = [
    { ...legacyMcp(), id: 'notion-ai', agentRef: 'old-dot-one' },
    { ...legacyDeepSeek(), id: 'notion-web', model: 'old-model' },
  ];
  const result = normalizeProfiles(original);
  assert.equal(result.find(profile => profile.protocol === 'notion-web').id, 'notion-web-2');
  assert.equal(result.find(profile => profile.id === 'notion-ai').agentRef, 'old-dot-one');
  assert.equal(result.find(profile => profile.id === 'notion-web').protocol, 'deepseek-harness');
  assert.equal(result.find(profile => profile.id === 'notion-web').model, 'old-model');
  assert.equal(new Set(result.map(profile => profile.id)).size, result.length);
  assert.deepEqual(normalizeProfiles(result), result);
});

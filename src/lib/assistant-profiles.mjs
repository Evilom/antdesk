export const BRIDGE_ENDPOINT = 'http://127.0.0.1:47631';

export const PROTOCOLS = {
  'notion-web': { label: 'Notion AI', detail: 'Notion 网页会员', badge: '网页登录', official: false },
  'dots-direct': { label: 'GPT · omdot', detail: 'ChatGPT / Dots 账号连接', badge: '客户端协议', official: false },
  'grok-direct': { label: 'Grok Bot', detail: 'Grok 账号与会话', badge: '社区协议', official: false },
  'muse-personal': { label: 'Muse AI', detail: 'muse.ai 个人助理', badge: '社区协议', official: false },
  'muse-code': { label: 'Muse Code', detail: '官方本地助理', badge: '官方', official: true },
  'deepseek-harness': { label: 'DeepSeek Harness', detail: '官方账号 / API Key', badge: '官方', official: true },
  'grok-webhook': { label: 'Grok Bot', detail: '官方 Webhook + MCP', badge: '官方', official: true },
  'dots-mcp': { label: 'ChatGPT DOTS', detail: '官方 MCP Events', badge: '官方', official: true },
  'openai': { label: '模型服务', detail: 'OpenAI 兼容接口', badge: '可选', official: false },
  'muse-manual': { label: 'Muse 会话', detail: '历史会话 · 待接入', badge: '待接入', official: false },
};

export const RUNTIME_PROTOCOLS = ['grok-direct', 'muse-personal', 'muse-code', 'deepseek-harness', 'dots-direct', 'notion-web'];
// Keep the user's existing assistants and the explicitly selected Notion connection.
// Keep the broader runtime recognition above for historical run recovery.
export const PERSONAL_ASSISTANT_PROTOCOLS = ['muse-personal', 'grok-direct', 'dots-direct', 'notion-web'];
export function isPersonalAssistant(profile) { return PERSONAL_ASSISTANT_PROTOCOLS.includes(profile?.protocol); }
export function isRuntimeProfile(profile) { return RUNTIME_PROTOCOLS.includes(profile?.protocol); }
export function isNativeProfile(profile) {
  return isRuntimeProfile(profile) || profile?.protocol === 'grok-webhook' || profile?.protocol === 'dots-mcp';
}

export function defaultProfiles() {
  return [
    { id: 'museai', name: 'Muse AI', endpoint: BRIDGE_ENDPOINT, model: '', protocol: 'muse-personal', agentRef: 'muse-personal', webhookUrl: '', sessionId: '', description: '按事项独立建立工作会话。' },
    { id: 'grokbot', name: 'Grok Bot', endpoint: BRIDGE_ENDPOINT, model: '', protocol: 'grok-direct', agentRef: '', webhookUrl: '', sessionId: '', description: '登录后选择 Bot 并关联工作会话。' },
    { id: 'omdot-direct', name: 'GPT · omdot', endpoint: BRIDGE_ENDPOINT, model: '', protocol: 'dots-direct', agentRef: '', webhookUrl: '', sessionId: '', description: '通过官方插件或账号连接 omdot。' },
    { id: 'notion-ai', name: 'Notion AI', endpoint: BRIDGE_ENDPOINT, model: '', protocol: 'notion-web', agentRef: 'notion-web', webhookUrl: '', sessionId: '', description: '使用已登录的 Notion 网页会员评审任务和整理工作。' },
  ];
}

/** One visible assistant per service. Prefer a configured identity, while the
 * caller retains the full saved array for updates and historical routing. */
export function personalAssistantProfiles(profiles) {
  return defaultProfiles().map(preset => {
    const candidates = profiles.filter(profile => profile.protocol === preset.protocol);
    return candidates.find(profile => profile.id === preset.id && isProfileConfigured(profile))
      || candidates.find(isProfileConfigured)
      || candidates.find(profile => profile.id === preset.id)
      || candidates[0]
      || preset;
  });
}

const clean = value => typeof value === 'string' ? value.trim() : '';
const builtins = () => new Map([
  ...defaultProfiles().map(profile => [profile.id, profile]),
  // Read old placeholders without silently replacing their saved MCP route.
  ['gptdot', { id: 'gptdot', name: 'omdot', endpoint: BRIDGE_ENDPOINT, model: '', protocol: 'dots-mcp', agentRef: 'gptdot', webhookUrl: '', description: '订阅事项分配事件，在已有助理中继续工作。' }],
]);

/** Read only known routing fields. Credentials and transient readiness never enter storage. */
export function normalizeProfiles(saved, legacy = {}) {
  const defaults = builtins();
  const seen = new Set();
  const profiles = Array.isArray(saved) ? saved.flatMap(value => {
    if (!value || typeof value !== 'object') return [];
    const id = clean(value.id);
    const name = clean(value.name);
    if (!id || !name || id.length > 128 || seen.has(id)) return [];
    seen.add(id);
    const emptyLegacy = (!value.protocol || value.protocol === 'openai') && !clean(value.endpoint) && !clean(value.model);
    const emptyMuse = id === 'museai' && value.protocol === 'muse-manual' && !clean(value.endpoint) && !clean(value.model) && !clean(value.webhookUrl) && !clean(value.sessionId) && (!clean(value.agentRef) || clean(value.agentRef) === id);
    const preset = defaults.get(id);
    if ((emptyLegacy || emptyMuse) && preset) {
      const legacyName = ['Grokbot', 'GPTdot', 'MuseAI'].includes(name) || emptyMuse && ['Muse', '原 Muse 会话'].includes(name);
      const obsoleteMuseDescription = emptyMuse && ['官方主动派发入口尚未核实，保留第三方直连备选。', '保留原 Muse 会话入口；当前尚未接入事项派发。'].includes(clean(value.description));
      return [{ ...preset, name: legacyName ? preset.name : name, description: obsoleteMuseDescription ? preset.description : clean(value.description) || preset.description }];
    }
    const protocol = value.protocol === undefined ? 'openai' : Object.hasOwn(PROTOCOLS, value.protocol) ? value.protocol : 'muse-manual';
    const oldDefaultName = preset?.protocol === protocol && (
      id === 'museai' && ['原 Muse', 'MuseAI'].includes(name)
      || id === 'omdot-direct' && name === 'Dots / omdot'
    );
    return [{
      id, name: oldDefaultName ? preset.name : name.slice(0, 128), protocol,
      endpoint: clean(value.endpoint), model: clean(value.model),
      agentRef: ['muse-personal', 'notion-web'].includes(protocol) ? protocol : clean(value.agentRef) || (['grok-direct', 'dots-direct'].includes(protocol) ? '' : id),
      sessionId: ['muse-personal', 'notion-web'].includes(protocol) ? '' : clean(value.sessionId).slice(0, 256),
      webhookUrl: clean(value.webhookUrl),
      description: clean(value.description).slice(0, 300),
    }];
  }) : [];
  if (profiles.length) {
    // Add new direct routes without replacing any existing Webhook/model configuration.
    for (const preset of defaultProfiles().filter(isRuntimeProfile)) {
      if (profiles.some(profile => profile.protocol === preset.protocol)) continue;
      let id = preset.id;
      if (profiles.some(profile => profile.id === id)) id = preset.protocol;
      for (let suffix = 2; profiles.some(profile => profile.id === id); suffix++) id = preset.protocol + '-' + suffix;
      profiles.push({ ...preset, id });
    }
    return profiles;
  }
  const fallback = defaultProfiles();
  if (clean(legacy.aiEndpoint) && clean(legacy.aiModel)) {
    try {
      const endpoint = validUrl(legacy.aiEndpoint, '服务地址', { allowRemoteHttp: true });
      fallback.push({ id: 'existing-text', name: '当前文字助理', endpoint, model: clean(legacy.aiModel), protocol: 'openai', agentRef: '', webhookUrl: '' });
    } catch { /* Keep the original legacy settings available in the existing chat UI. */ }
  }
  return fallback;
}

function validUrl(value, label, { https = false, allowRemoteHttp = false } = {}) {
  const text = clean(value);
  if (!text) throw new Error('填写' + label + '。');
  let url;
  try { url = new URL(text); } catch { throw new Error(label + '格式不正确。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['http:', 'https:'].includes(url.protocol) || (url.protocol === 'http:' && (https || !loopback && !allowRemoteHttp))) {
    throw new Error(label + (https ? '必须使用 HTTPS。' : '使用 HTTPS；本机服务可使用 HTTP。'));
  }
  if (url.username || url.password || url.search || url.hash) throw new Error(label + '不能包含账号、查询参数或密钥。');
  if (text.length > 2048) throw new Error(label + '过长。');
  return text.replace(/\/+$/, '');
}

export function validateProfile(profile) {
  const name = clean(profile.name);
  if (!name) throw new Error('填写助理名称。');
  if (!Object.hasOwn(PROTOCOLS, profile.protocol)) throw new Error('选择支持的接入方式。');
  const value = {
    id: clean(profile.id), name: name.slice(0, 128), protocol: profile.protocol,
    description: clean(profile.description).slice(0, 300),
    endpoint: '', model: '', agentRef: ['muse-personal', 'notion-web'].includes(profile.protocol) ? profile.protocol : clean(profile.agentRef) || (['grok-direct', 'dots-direct'].includes(profile.protocol) ? '' : clean(profile.id)), webhookUrl: '',
    sessionId: ['muse-personal', 'notion-web'].includes(profile.protocol) ? '' : clean(profile.sessionId).slice(0, 256),
  };
  if (profile.protocol === 'muse-manual') return value;
  if (isRuntimeProfile(profile)) {
    value.endpoint = BRIDGE_ENDPOINT;
    value.model = clean(profile.model).slice(0, 256);
    value.agentRef = value.agentRef.slice(0, 512);
    return value;
  }
  value.endpoint = validUrl(profile.endpoint, isNativeProfile(profile) ? 'AntDesk 连接服务地址' : '模型服务地址', { allowRemoteHttp: profile.protocol === 'openai' });
  if (profile.protocol === 'openai') {
    value.model = clean(profile.model);
    if (!value.model || value.model.length > 256) throw new Error('填写服务支持的模型名称。');
    return value;
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.agentRef)) throw new Error('助理标识使用字母、数字、短横线、下划线或点，最多 128 位。');
  if (profile.protocol === 'grok-webhook') value.webhookUrl = validUrl(profile.webhookUrl, 'Grok 官方 Webhook 地址', { https: true });
  return value;
}

export function isProfileConfigured(profile) {
  if (profile.protocol === 'muse-manual') return false;
  if (['grok-direct', 'dots-direct'].includes(profile.protocol) && !clean(profile.agentRef)) return false;
  try { validateProfile(profile); return true; } catch { return false; }
}

export function credentialScopeKey(profile) {
  return JSON.stringify([profile.protocol, profile.endpoint, profile.agentRef || profile.id, profile.webhookUrl || '']);
}

export function connectionKey(profile) {
  return JSON.stringify([profile.protocol, profile.endpoint, profile.model, profile.agentRef || profile.id, profile.webhookUrl || '', profile.sessionId || '']);
}

export function isActiveRun(run) {
  return ['queued', 'running'].includes(run.status) ||
    run.status === 'interrupted' && isNativeProfile(run) && Boolean(run.externalRunId || run.sessionId);
}

export function runStatusLabel(run) {
  if (run.reviewDecision === 'accepted') return '已采纳';
  if (run.reviewDecision === 'rejected') return '已退回安排';
  if (run.reviewed) return '已复核';
  if (run.handedOff) return '已接力';
  if (isActiveRun(run) && run.attention) return { approval: '等待审批', input: '需要你补充', login: '需要重新登录' }[run.attention.kind] || '需要你处理';
  if (isNativeProfile(run)) {
    if (run.status === 'cancelled') return isRuntimeProfile(run) && run.remoteStopped ? '已取消运行' : '已停止等待';
    if (run.status === 'interrupted' && (run.externalRunId || run.sessionId)) return '等待恢复同步';
    if (run.status === 'running' && run.deliveryStatus === 'unknown') return '派发待核实';
    if (run.status === 'running' && run.deliveryStatus === 'accepted' && !run.progress) return '已送达 · 等待回报';
    if (run.status === 'running' && run.deliveryStatus === 'pending') return '正在派发';
  }
  return { queued: '排队中', running: '处理中', review: '待复核', failed: '执行失败', cancelled: '已取消', interrupted: '已中断' }[run.status] || run.status;
}

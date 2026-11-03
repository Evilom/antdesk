/** Read-only validation against DeepSeek's documented model-list endpoint.
 * This never generates a model response and never returns credential material.
 * https://api-docs.deepseek.com/api/list-models/
 * https://api-docs.deepseek.com/api/deepseek-api/
 */
const MODEL_URL = 'https://api.deepseek.com/models';
const MODEL_ID = /^[a-zA-Z0-9._/-]{1,150}$/;
const MAX_BODY_BYTES = 1024 * 1024;

export const DEEPSEEK_FAILURES = Object.freeze({
  ACCOUNT_SIGN_IN_REQUIRED: '请先使用 DeepSeek 官方账号登录。',
  ACCOUNT_TOKEN_INVALID: 'DeepSeek 官方账号登录已失效，请重新登录。',
  ACCOUNT_QUOTA: 'DeepSeek 官方账号额度不足，请在官方账号页面查看额度。',
  CLIENT_UPGRADE_REQUIRED: '当前 DeepSeek 官方运行时版本不支持所选模型，请升级运行时。',
  MODEL_UNSUPPORTED: '当前 DeepSeek 官方运行时不支持所选模型，请选择可用模型。',
  MISSING_CREDENTIAL: '尚未配置 DeepSeek 官方 API 密钥。',
  INVALID_CREDENTIAL: 'DeepSeek 官方 API 密钥格式无效，请重新配置。',
  AUTHENTICATION: 'DeepSeek 官方服务未接受当前凭据，请重新登录或检查 API 密钥。',
  AUTH: 'DeepSeek 官方服务未接受当前凭据或权限，请重新登录或检查 API 密钥。',
  PERMISSION: '当前 DeepSeek 账号没有访问此服务的权限。',
  QUOTA: 'DeepSeek 官方 API 额度不足，请在官方平台查看额度。',
  RATE_LIMIT: 'DeepSeek 官方服务暂时限制请求频率，请稍后重试。',
  MODEL_NOT_FOUND: '所选 DeepSeek 模型未出现在当前账号的可用模型中。',
  NETWORK: '暂时无法连接 DeepSeek 官方服务，请检查网络后重试。',
  TRANSPORT: 'DeepSeek 官方服务连接中断，请检查网络后恢复原会话。',
  SERVER: 'DeepSeek 官方服务暂时不可用，请稍后重试。',
  CONTEXT_WINDOW_EXCEEDED: '这轮 DeepSeek 会话超出模型的上下文限制，请缩短任务背景或新建会话。',
  INVALID_REQUEST: 'DeepSeek 官方服务未接受当前请求，请检查模型和任务内容。',
  EMPTY_RESPONSE: 'DeepSeek 官方服务未返回有效内容，请稍后重试。',
  TIMEOUT: 'DeepSeek 官方服务响应超时，请稍后重试。',
  RESPONSE_INVALID: 'DeepSeek 官方服务没有返回可验证的模型列表，请稍后重试。',
});

export function deepseekFailure(code, fallback = 'DeepSeek 官方运行时未能完成请求，请检查连接状态后重试。') {
  return Object.hasOwn(DEEPSEEK_FAILURES, code || '') ? DEEPSEEK_FAILURES[code] : fallback;
}

export function deepseekHttpFailure(status) {
  return ({ 401: 'AUTHENTICATION', 403: 'PERMISSION', 402: 'QUOTA', 404: 'MODEL_NOT_FOUND', 429: 'RATE_LIMIT' })[status] || 'NETWORK';
}

export async function boundedDeepSeekJson(response) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('Response exceeds limit.');
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_BODY_BYTES) throw new Error('Response exceeds limit.');
    return JSON.parse(text);
  }
  const reader = response.body.getReader(), chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_BODY_BYTES) throw new Error('Response exceeds limit.');
      chunks.push(value);
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
}

export function safeDeepSeekModels(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.slice(0, 256).flatMap(row => {
    const id = row && typeof row === 'object' ? row.id : undefined;
    if (typeof id !== 'string' || !MODEL_ID.test(id) || seen.has(id)) return [];
    seen.add(id);
    const name = typeof row.name === 'string' ? row.name : typeof row.display_name === 'string' ? row.display_name : id;
    return [{ id, name: name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 150) || id }];
  });
}

export async function validateDeepSeekApiKey(apiKey, { fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) {
    return { state: 'invalid', code: 'INVALID_CREDENTIAL', models: [], message: deepseekFailure('INVALID_CREDENTIAL') };
  }
  let response;
  try {
    response = await fetchImpl(MODEL_URL, {
      method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey.trim()}` },
    });
  } catch (error) {
    const code = ['TimeoutError', 'AbortError'].includes(error?.name) ? 'TIMEOUT' : 'NETWORK';
    return { state: 'unverified', code, models: [], message: deepseekFailure(code) };
  }
  if (response.status !== 200) {
    try { await response.body?.cancel?.(); } catch {}
    const code = deepseekHttpFailure(response.status);
    return { state: [401, 403].includes(response.status) ? 'invalid' : 'unverified', code, models: [], message: deepseekFailure(code) };
  }
  try {
    const payload = await boundedDeepSeekJson(response);
    const models = safeDeepSeekModels(payload?.data);
    if (!models.length) throw new Error('No model catalog.');
    return { state: 'verified', models, verifiedAt: Date.now(), message: '官方 API 密钥已通过模型列表校验；任务额度由官方服务在执行时确认。' };
  } catch {
    return { state: 'unverified', code: 'RESPONSE_INVALID', models: [], message: deepseekFailure('RESPONSE_INVALID') };
  }
}

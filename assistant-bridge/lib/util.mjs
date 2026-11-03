import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class BridgeError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new BridgeError(status, code, message); };
export const random = (size = 32) => randomBytes(size).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export function equal(a, b) {
  const left = Buffer.from(String(a)); const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
export function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
export function string(value, name, max = 256, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max || value.includes('\0')) fail(400, 'invalid_input', name + ' is missing or too long.');
  return value;
}
export function identifier(value, name = 'id') {
  string(value, name, 256);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:~-]{0,255}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) fail(400, 'invalid_input', name + ' is invalid.');
  return value;
}
export async function readBody(req, limit = 512 * 1024) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) fail(413, 'too_large', 'Request is too large.'); chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
export async function readJson(req) {
  try { const value = JSON.parse(await readBody(req)); if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400,'invalid_json','A JSON object is required.'); return value; }
  catch (error) { if (error instanceof BridgeError) throw error; fail(400, 'invalid_json', 'A JSON object is required.'); }
}
export function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers }); res.end(JSON.stringify(body));
}
export function bearer(req) { return /^Bearer ([^\s]+)$/i.exec(req.headers.authorization || '')?.[1] || ''; }
export function escapeHtml(text) { return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
export function snapshot(run) {
  return { id: run.id, status: run.status, deliveryStatus: run.deliveryStatus, progress: run.progress || '', result: run.result || '', error: run.error || '', updatedAt: run.updatedAt, ...Object.fromEntries(['sessionId','turnId','cursor','attention','messages','remoteStopped'].filter(key=>run[key]!==undefined).map(key=>[key,structuredClone(run[key])])) };
}
export function touch(run) { run.updatedAt = Math.max(Date.now(), (run.updatedAt || 0) + 1); }
export function terminal(run) { return ['review', 'failed', 'cancelled', 'interrupted'].includes(run.status); }

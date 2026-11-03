import fs from 'node:fs';
import path from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const initial = () => ({version:1, revision:0, runs:{}, tombstones:{}, subscriptions:{}, outbox:{}, agents:{}, oauth:{clients:{}, codes:{}, tokens:{}, refresh:{}, approvals:{}}});
export class Store {
  constructor(file, adminToken) {
    this.file = file; this.key = createHash('sha256').update(adminToken).digest();
    fs.mkdirSync(path.dirname(file), {recursive:true, mode:0o700});
    this.lockPath = file + '.lock';
    try { this.lock = fs.openSync(this.lockPath, 'wx', 0o600); fs.writeFileSync(this.lock, String(process.pid)); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let live = true;
      try { process.kill(Number(fs.readFileSync(this.lockPath, 'utf8')), 0); } catch (e) { if (e.code === 'ESRCH') live = false; }
      if (live) throw new Error('The bridge state is already in use.');
      fs.unlinkSync(this.lockPath); this.lock = fs.openSync(this.lockPath, 'wx', 0o600); fs.writeFileSync(this.lock, String(process.pid));
    }
    try { this.data = JSON.parse(fs.readFileSync(file, 'utf8')); if (this.data.version !== 1) throw new Error('Unsupported bridge state version.'); }
    catch (error) { if (error.code === 'ENOENT') this.data = initial(); else { this.close(); throw error; } }
    this.commit(s => {
      for (const run of Object.values(s.runs)) {
        if (run.protocol === 'grok-webhook' && run.deliveryStatus === 'pending' && ['queued','running'].includes(run.status)) {
          run.deliveryStatus = 'unknown'; run.status = 'interrupted'; run.error = '发送过程被中断，远端是否已接收尚未确认。请检查助理会话，避免重复派发。'; run.updatedAt = Math.max(Date.now(), run.updatedAt + 1);
        }
      }
      s.oauth.codes = {}; s.oauth.approvals = {};
    });
  }
  commit(fn) {
    const next = structuredClone(this.data); const result = fn(next); next.revision++;
    const temp = this.file + '.tmp-' + process.pid;
    const fd = fs.openSync(temp, 'w', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(next)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file); this.data = next; return result;
  }
  seal(text) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const value = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), value]).toString('base64');
  }
  unseal(text) {
    const bytes = Buffer.from(text, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0,12));
    decipher.setAuthTag(bytes.subarray(12,28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
  }
  close() { if (this.lock !== undefined) { fs.closeSync(this.lock); this.lock = undefined; try { fs.unlinkSync(this.lockPath); } catch {} } }
}

/** Dependency-free WebRTC client. Device key stays in memory. */
export function encodeEvent(event) {
  return JSON.stringify({ type: 'data_message', data: JSON.stringify(event) });
}

export function decodeEvent(raw) {
  let event = typeof raw === 'string' ? JSON.parse(raw) : raw;
  for (let i = 0; i < 3 && event?.type === 'data_message'; i++) {
    event = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
  }
  return event;
}

export function userMessage(content) {
  return { id: crypto.randomUUID(), author: { role: 'user' }, create_time: Date.now() / 1000,
    content, metadata: { serialization_metadata: { custom_symbol_offsets: [] } },
    clientMetadata: { isOptimistic: true } };
}

export function captionDelta(previous = {}, event) {
  const data = event?.type === 'chat_message_delta' ? event : event?.payload;
  if (data?.type !== 'chat_message_delta') return null;
  const delta = data.delta || data.payload?.delta || {};
  const message = delta.v?.message;
  if (message) {
    const parts = message.content?.parts || [];
    let role = message.author?.role;
    if (!['user', 'assistant'].includes(role)) {
      const audio = parts.find(p => p?.content_type === 'audio_transcription');
      role = audio?.direction === 'in' ? 'user' : audio?.direction === 'out' ? 'assistant' : '';
    }
    if (!role) return null;
    return { id: message.id || '', role, text: parts.map(p => typeof p === 'string' ? p : p?.text || p?.transcript || '').join('\n') };
  }
  if (!Array.isArray(delta.v) || !previous.role) return null;
  const append = delta.v.filter(p => p.o === 'append' && /^\/message\/content\/parts\/\d+\/text$/.test(p.p)).map(p => p.v).join('');
  return append ? { ...previous, text: previous.text + append } : null;
}

export class GatewayAPIError extends Error {
  constructor(status, error) {
    super(error?.message || `Gateway HTTP ${status}`);
    this.status = status;
    this.code = error?.code || 'http_error';
    this.retryable = error?.retryable === true;
  }
}

export function requestMicrophone(timeoutMs = 20000, signal) {
  if (!navigator.mediaDevices?.getUserMedia) {
    return Promise.reject(new Error('当前浏览器不支持麦克风，请在 Safari 或 Chrome 中打开此页面。'));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cancel = () => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(new Error('连接已取消。'));
    };
    const timer = setTimeout(() => {
      settled = true;
      signal?.removeEventListener('abort', cancel);
      reject(new Error('等待麦克风授权超时。请允许麦克风；若没有弹出提示，请在系统 Safari 或 Chrome 中重新打开。'));
    }, timeoutMs);
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) { cancel(); return; }
    navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false }).then(stream => {
      if (settled) { stream.getTracks().forEach(track => track.stop()); return; }
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); resolve(stream);
    }, error => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      const messages = {
        NotAllowedError: '麦克风权限被拒绝，请在浏览器的网站设置中允许麦克风，再重新开始。',
        NotFoundError: '没有找到可用麦克风，请检查手机或耳机的音频设备。',
        NotReadableError: '麦克风暂时无法使用，请关闭其他正在录音或通话的应用后重试。',
      };
      reject(new Error(messages[error.name] || '无法打开麦克风，请在系统 Safari 或 Chrome 中重试。'));
    });
  });
}

export class RealtimeAssistant extends EventTarget {
  constructor({ baseUrl = location.origin, apiKey, audioElement, iceServers = [], maxReconnects = 3, context = '', transport, getContext }) {
    super();
    if (typeof apiKey !== 'string' || !apiKey.trim() || apiKey.length > 128) throw new Error('请输入已配置的设备密钥。');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.apiKey = apiKey;
    this.audio = audioElement || new Audio();
    this.audio.autoplay = true;
    this.audio.playsInline = true;
    this.iceServers = iceServers;
    this.maxReconnects = maxReconnects;
    this.context = context;
    this.getContext = getContext;
    this.transport = transport;
    this.muted = false;
    this.wanted = false;
    this.epoch = 0;
    this.runEpoch = 0;
    this.releases = new Map();
    this.unreleased = new Set();
    this.retries = 0;
    this.caption = {};
  }

  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  state(value) { this.emit('state', value); }

  async request(path, { method = 'GET', body, timeout = 70000 } = {}) {
    if (this.transport) {
      const { status, payload } = await this.transport(path, { method, body, timeout });
      if (status < 200 || status >= 300) throw new GatewayAPIError(status, payload?.error);
      return payload;
    }
    const headers = { Authorization: `Bearer ${this.apiKey}` };
    if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(this.baseUrl + path, { method, headers,
        body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
        signal: controller.signal, cache: 'no-store' });
      let payload = null;
      if (response.status !== 204) {
        try { payload = await response.json(); }
        catch { throw new GatewayAPIError(response.status, { message: '网关返回异常，请稍后重试。', retryable: true }); }
      }
      if (!response.ok) throw new GatewayAPIError(response.status, payload?.error);
      return payload;
    } catch (error) {
      if (error instanceof GatewayAPIError) throw error;
      throw new Error(controller.signal.aborted ? '连接服务器超时，请检查网络后重试。' : '无法连接服务器，请检查网络或改用系统浏览器。');
    } finally { clearTimeout(timer); }
  }

  async start({ voice = 'cove', language = 'zh-CN', ttlSeconds = 1800 } = {}) {
    if (this.wanted || this.stopping) throw new Error('旧通话正在结束，请稍后再开始。');
    if (this.unreleased.size) throw new Error('旧语音会话尚未释放，请检查网络后重试结束通话。');
    const run = ++this.runEpoch;
    this.wanted = true;
    this.options = { voice, language, ttlSeconds };
    this.retries = 0;
    try { await this.connect(); }
    catch (error) {
      if (run !== this.runEpoch || !this.wanted) return;
      if (retryableFailure(error) && this.maxReconnects > 0 && !this.unreleased.size) await this.reconnect();
      else { this.wanted = false; throw error; }
    }
  }

  async connect() {
    const task = this.connectAttempt();
    this.connectTask = task;
    try { await task; }
    finally { if (this.connectTask === task) this.connectTask = null; }
  }

  async connectAttempt() {
    const epoch = ++this.epoch;
    const microphoneAbort = this.microphoneAbort = new AbortController();
    this.state(this.retries ? 'reconnecting' : 'checking');
    try {
      if (!globalThis.isSecureContext) throw new Error('麦克风需要 HTTPS 或 localhost。');
      await this.request('/v1/capabilities', { timeout: 8000 });
      if (!this.wanted || epoch !== this.epoch) return;
      this.state('microphone');
      const stream = await requestMicrophone(20000, microphoneAbort.signal);
      if (!this.wanted || epoch !== this.epoch) { stream.getTracks().forEach(t => t.stop()); return; }
      this.stream = stream;
      this.mute(this.muted);
      this.state('connecting');
      const pc = this.pc = new RTCPeerConnection({ iceServers: this.iceServers, bundlePolicy: 'max-bundle' });
      this.dc = pc.createDataChannel('oai-events', { negotiated: true, id: 0 });
      stream.getTracks().forEach(track => pc.addTrack(track, stream));
      this.dc.onmessage = ({ data }) => {
        if (!this.wanted || epoch !== this.epoch || pc !== this.pc) return;
        try {
          const event = decodeEvent(data);
          this.emit('event', event);
          const caption = captionDelta(this.caption, event);
          if (caption) { this.caption = caption; this.emit('caption', caption); }
          const usage = event?.type === 'usage_update' ? event : event?.payload;
          if (usage?.type === 'usage_update' && usage.instructions?.hang_up) {
            this.emit('error', new Error('上游要求结束通话，请检查账号额度。'));
            void this.stop();
          }
        } catch { /* Ignore unrelated protocol events. */ }
      };
      pc.ontrack = ({ track, streams }) => {
        if (!this.wanted || epoch !== this.epoch || pc !== this.pc) return;
        this.audio.srcObject = streams[0] || new MediaStream([track]);
        this.audio.play().catch(() => { if (this.wanted && epoch === this.epoch) this.emit('playbackblocked', null); });
      };
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise(resolve => {
        if (pc.iceGatheringState === 'complete') return resolve();
        const timer = setTimeout(done, 2500);
        function done() { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', check); resolve(); }
        function check() { if (pc.iceGatheringState === 'complete') done(); }
        pc.addEventListener('icegatheringstatechange', check);
      });
      if (!this.wanted || epoch !== this.epoch) return;
      const session = await this.request('/v1/realtime/sessions', { method: 'POST', body: {
        offer_sdp: pc.localDescription.sdp, voice: this.options.voice,
        language_code: this.options.language, ttl_seconds: this.options.ttlSeconds,
      } });
      if (!this.wanted || epoch !== this.epoch) { await this.release(session.id); return; }
      this.session = session;
      await pc.setRemoteDescription({ type: 'answer', sdp: session.answer_sdp });
      if (!this.wanted || epoch !== this.epoch) return;
      await new Promise((resolve, reject) => {
        const dc = this.dc;
        const timer = setTimeout(() => done(new Error('WebRTC 连接超时。')), 30000);
        const done = error => {
          clearTimeout(timer); pc.removeEventListener('connectionstatechange', check); dc.removeEventListener('open', check);
          if (this.cancelConnect === cancel) this.cancelConnect = null;
          error ? reject(error) : resolve();
        };
        const cancel = () => done(new Error('连接已取消。'));
        const check = () => {
          if (pc.connectionState === 'connected' && dc.readyState === 'open') done();
          else if (['failed', 'closed'].includes(pc.connectionState)) done(new Error('WebRTC 连接失败。'));
        };
        this.cancelConnect = cancel;
        pc.addEventListener('connectionstatechange', check); dc.addEventListener('open', check); check();
      });
      if (!this.wanted || epoch !== this.epoch) return;
      if (this.getContext) this.context = await this.getContext();
      if (!this.wanted || epoch !== this.epoch) return;
      this.caption = {};
      this.state('connected');
      this.emit('session', { id: session.id, expiresAt: session.expires_at });
      if (this.context) this.sendText(this.context);
      pc.onconnectionstatechange = () => {
        if (pc !== this.pc) return;
        clearTimeout(this.disconnectTimer);
        if (pc.connectionState === 'failed') void this.reconnect();
        else if (pc.connectionState === 'disconnected') this.disconnectTimer = setTimeout(() => void this.reconnect(), 5000);
      };
      this.heartbeat = setInterval(async () => {
        try { await this.request(`/v1/realtime/sessions/${session.id}`, { timeout: 8000 }); }
        catch (e) {
          if (!this.wanted || epoch !== this.epoch) return;
          if (e.status === 401) { this.emit('error', e); await this.stop(); }
          else void this.reconnect();
        }
      }, 20000);
      this.expiryTimer = setTimeout(() => void this.reconnect(), Math.max(0, session.expires_at * 1000 - Date.now()));
      this.stableTimer = setTimeout(() => { this.retries = 0; }, 60000);
    } catch (error) {
      if (!this.wanted || epoch !== this.epoch) return;
      await this.cleanup();
      if (!this.wanted || epoch !== this.epoch) return;
      this.state(this.reconnecting ? 'reconnecting' : 'disconnected');
      this.emit('error', error);
      throw error;
    }
  }

  async reconnect() {
    if (!this.wanted || this.reconnecting) return;
    this.reconnecting = true;
    try {
      while (this.wanted && this.retries < this.maxReconnects) {
        this.retries++;
        ++this.epoch;
        await this.cleanup();
        if (!this.wanted) return;
        if (this.unreleased.size) { this.emit('error', new Error('旧语音会话尚未释放，请检查网络后重新连接。')); await this.stop(); return; }
        this.state('reconnecting');
        await new Promise(resolve => { this.retryResolve = resolve; this.retryTimer = setTimeout(resolve, Math.min(30000, 1000 * 2 ** Math.min(5, this.retries - 1))); });
        this.retryResolve = null;
        if (!this.wanted) return;
        try { await this.connect(); return; }
        catch (error) {
          if (!retryableFailure(error)) { await this.stop(); return; }
        }
      }
      await this.stop();
    } finally { this.reconnecting = false; }
  }

  send(event) {
    if (this.dc?.readyState !== 'open') throw new Error('实时通道尚未连接。');
    this.dc.send(encodeEvent(event));
  }

  sendText(text) {
    if (!text.trim() || text.length > 8000) throw new Error('文本需要 1–8000 个字符。');
    const message = userMessage({ content_type: 'text', parts: [text] });
    this.emit('sent', { id: message.id });
    this.send({ type: 'relay_message', payload: { type: 'relay_message', message } });
  }

  interrupt() { this.send({ type: 'action_request', payload: { action: 'stop_speaking' } }); }
  mute(value = true) { this.muted = value; this.stream?.getAudioTracks().forEach(track => { track.enabled = !value; }); }

  async sendImage(file, text = '') {
    if (!this.session || this.dc?.readyState !== 'open') throw new Error('请先连接。');
    const sid = this.session.id;
    const form = new FormData(); form.append('image', file);
    const image = await this.request(`/v1/realtime/sessions/${sid}/images`, { method: 'POST', body: form, timeout: 300000 });
    if (this.session?.id !== sid) throw new Error('会话已切换，请重新发送图片。');
    const parts = [{ content_type: 'image_asset_pointer', asset_pointer: `sediment://${image.file_id}`, size_bytes: image.size, width: image.width, height: image.height }];
    if (text) parts.push(text);
    const message = userMessage({ content_type: 'multimodal_text', parts });
    message.metadata.attachments = [{ ...image, id: image.file_id }];
    this.send({ type: 'relay_message', payload: { type: 'relay_message', message } });
    return image;
  }

  async release(id) {
    if (this.releases.has(id)) return this.releases.get(id);
    this.unreleased.add(id);
    const task = (async () => {
      try {
        await this.request(`/v1/realtime/sessions/${id}`, { method: 'DELETE', timeout: 10000 });
        this.unreleased.delete(id);
      } catch (error) {
        if (error.status === 404 || error.status === 410) this.unreleased.delete(id);
      }
    })();
    this.releases.set(id, task);
    try { await task; } finally { this.releases.delete(id); }
  }

  async cleanup() {
    clearInterval(this.heartbeat); clearTimeout(this.expiryTimer); clearTimeout(this.stableTimer); clearTimeout(this.disconnectTimer);
    this.microphoneAbort?.abort();
    this.cancelConnect?.();
    if (this.dc) { this.dc.onmessage = null; this.dc.onopen = null; this.dc.onclose = null; this.dc.onerror = null; this.dc.close?.(); }
    if (this.pc) { this.pc.ontrack = null; this.pc.onconnectionstatechange = null; this.pc.close(); }
    this.pc = null; this.dc = null;
    this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
    this.audio.pause?.(); this.audio.srcObject = null;
    const session = this.session; this.session = null;
    if (session) this.unreleased.add(session.id);
    await Promise.all([...this.unreleased].map(id => this.release(id)));
  }

  stop() {
    if (this.stopping) return this.stopping;
    this.wanted = false; ++this.epoch; ++this.runEpoch;
    clearTimeout(this.retryTimer); this.retryResolve?.();
    this.state('stopping');
    const pending = this.connectTask;
    this.stopping = (async () => {
      await this.cleanup();
      // A pending POST may still allocate a server session after local capture stops.
      // Wait for that response and its DELETE before allowing a replacement call.
      await pending?.catch(() => {});
      await Promise.all(this.releases.values());
      if (this.unreleased.size) this.emit('error', new Error('麦克风已关闭，但旧语音会话尚未释放。请检查网络后重试。'));
      this.state('disconnected');
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  }
}

// Retry network loss indefinitely only when the caller opts in; never retry auth or microphone denial.
export function retryableFailure(error) {
  return error instanceof GatewayAPIError ? error.retryable && ![401, 403].includes(error.status) : /服务器超时|无法连接服务器|WebRTC 连接|无法连接语音服务|网络/.test(error?.message || '');
}

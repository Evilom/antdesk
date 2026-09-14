import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeEvent, decodeEvent, captionDelta, RealtimeAssistant, GatewayAPIError, requestMicrophone } from '../src/lib/vendor/realtime-client.mjs';

test('wire protocol preserves nested relay message and interrupt', () => {
  for (const event of [
    { type: 'relay_message', payload: { type: 'relay_message', message: { content: { parts: ['你好'] } } } },
    { type: 'action_request', payload: { action: 'stop_speaking' } },
  ]) assert.deepEqual(decodeEvent(encodeEvent(event)), event);
});

test('caption updates preserve message identity and append only text', () => {
  const first = captionDelta({}, { type: 'chat_message_delta', delta: { v: { message: {
    id: 'm1', author: { role: 'assistant' }, content: { parts: [{ text: '你好' }] },
  } } } });
  const next = captionDelta(first, { type: 'chat_message_delta', delta: { v: [
    { o: 'append', p: '/message/content/parts/0/text', v: '，大师' },
    { o: 'append', p: '/message/metadata', v: 'ignored' },
  ] } });
  assert.deepEqual(next, { id: 'm1', role: 'assistant', text: '你好，大师' });
  assert.equal(captionDelta(next, { type: 'startup_telemetry' }), null);
});

test('stop closes audio tracks and peer connection and releases server session', async () => {
  let stopped = 0, closed = 0, released;
  const client = new RealtimeAssistant({ baseUrl:'http://localhost', apiKey:'cvd_' + 'x'.repeat(43), audioElement:{} });
  client.stream = { getTracks: () => [{ stop: () => stopped++ }] };
  client.pc = { close: () => closed++ };
  client.session = { id: 'vs_test' };
  client.release = async id => { released = id; };
  client.wanted = true;
  await client.stop();
  assert.equal(stopped, 1); assert.equal(closed, 1); assert.equal(released, 'vs_test');
  assert.equal(client.wanted, false); assert.equal(client.session, null);
});

test('configured short keys reach server validation while empty keys fail locally', () => {
  assert.doesNotThrow(() => new RealtimeAssistant({ baseUrl:'https://voice.example', apiKey:'1123', audioElement:{} }));
  assert.throws(() => new RealtimeAssistant({ baseUrl:'https://voice.example', apiKey:'', audioElement:{} }), /请输入/);
});

test('invalid full-length key is checked before asking for microphone access', async () => {
  const client = new RealtimeAssistant({ baseUrl:'https://voice.example', apiKey:'cvd_'+'x'.repeat(43), audioElement:{} });
  let micCalls = 0;
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const originalSecure = Object.getOwnPropertyDescriptor(globalThis, 'isSecureContext');
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{ mediaDevices:{ getUserMedia:async () => { micCalls++; } } } });
  Object.defineProperty(globalThis, 'isSecureContext', { configurable:true, value:true });
  client.request = async path => {
    assert.equal(path, '/v1/capabilities');
    throw new GatewayAPIError(401, { message:'设备密钥无效或已撤销。' });
  };
  try {
    await assert.rejects(client.start(), /设备密钥无效/);
    assert.equal(micCalls, 0);
    assert.equal(client.wanted, false);
  } finally {
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator); else delete globalThis.navigator;
    if (originalSecure) Object.defineProperty(globalThis, 'isSecureContext', originalSecure); else delete globalThis.isSecureContext;
  }
});

test('late microphone approval after timeout releases audio instead of recording', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  let approve;
  let stopped = 0;
  Object.defineProperty(globalThis, 'navigator', { configurable:true, value:{ mediaDevices:{ getUserMedia:() => new Promise(resolve => { approve=resolve; }) } } });
  try {
    await assert.rejects(requestMicrophone(5), /授权超时/);
    approve({ getTracks:() => [{ stop:() => stopped++ }] });
    await Promise.resolve();
    assert.equal(stopped, 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'navigator', original); else delete globalThis.navigator;
  }
});

test('native transport handles authorization in Rust and preserves server error semantics', async () => {
  const calls = [];
  const client = new RealtimeAssistant({baseUrl: 'http://127.0.0.1:6080', apiKey: 'native-managed', audioElement: {},
    transport: async (path, options) => {
      calls.push({path, options});
      return {status: 429, payload: {error: {message: '已有通话', code: 'session_limit', retryable: true}}};
    }});
  await assert.rejects(client.request('/v1/realtime/sessions', {method: 'POST', body: {offer_sdp: 'v=0'}}), e =>
    e instanceof GatewayAPIError && e.status === 429 && e.code === 'session_limit' && e.retryable);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers, undefined);
  assert.equal(calls[0].options.body.offer_sdp, 'v=0');
});

test('mute intent is retained when a replacement microphone stream arrives', () => {
  const client = new RealtimeAssistant({baseUrl: 'http://localhost', apiKey: 'native-managed', audioElement: {}});
  client.mute(true);
  const track = {enabled: true};
  client.stream = {getAudioTracks: () => [track]};
  client.mute(client.muted);
  assert.equal(track.enabled, false);
  client.mute(false);
  assert.equal(track.enabled, true);
});

test('canceling while the gateway creates a session releases that late session', async () => {
  const saved = {};
  for (const key of ['navigator', 'isSecureContext', 'RTCPeerConnection']) saved[key] = Object.getOwnPropertyDescriptor(globalThis, key);
  let resolveSession, stopped = 0, closed = 0;
  const released = [];
  const track = {enabled: true, stop: () => stopped++};
  class Peer extends EventTarget {
    iceGatheringState = 'complete'; localDescription = {sdp: 'v=0'};
    createDataChannel() { return new EventTarget(); }
    addTrack() {}
    async createOffer() { return {sdp: 'v=0'}; }
    async setLocalDescription() {}
    async setRemoteDescription() {throw new Error('canceled session must not be attached');}
    close() {closed++;}
  }
  Object.defineProperty(globalThis, 'navigator', {configurable: true, value: {mediaDevices: {getUserMedia: async () => ({getTracks: () => [track], getAudioTracks: () => [track]})}}});
  Object.defineProperty(globalThis, 'isSecureContext', {configurable: true, value: true});
  Object.defineProperty(globalThis, 'RTCPeerConnection', {configurable: true, value: Peer});
  const client = new RealtimeAssistant({baseUrl: 'http://localhost', apiKey: 'test', audioElement: {}, transport: async (path, options) => {
    if (options.method === 'DELETE') {released.push(path); return {status: 204, payload: null};}
    if (path.endsWith('capabilities')) return {status: 200, payload: {}};
    return new Promise(resolve => {resolveSession = resolve;});
  }});
  try {
    const connecting = client.start();
    while (!resolveSession) await new Promise(r => setImmediate(r));
    await client.stop();
    resolveSession({status: 201, payload: {id: 'late-session', answer_sdp: 'v=0'}});
    await connecting;
    assert.equal(stopped, 1); assert.equal(closed, 1);
    assert.deepEqual(released, ['/v1/realtime/sessions/late-session']);
    assert.equal(client.pc, null); assert.equal(client.stream, null);
  } finally {
    await client.stop();
    for (const key of Object.keys(saved)) {
      if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else delete globalThis[key];
    }
  }
});

test('injected context is identified before it can return as a caption echo', () => {
  const client = new RealtimeAssistant({baseUrl: 'http://localhost', apiKey: 'test', audioElement: {}});
  let outgoing;
  const sent = new Set();
  client.addEventListener('sent', e => sent.add(e.detail.id));
  client.dc = {readyState: 'open', send: raw => {outgoing = decodeEvent(raw); assert.ok(sent.has(outgoing.payload.message.id));}};
  client.sendText('检索得到的资料');
  assert.equal(outgoing.payload.message.content.parts[0], '检索得到的资料');
});

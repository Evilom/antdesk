import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { mockIPC, mockWindows, clearMocks } from '@tauri-apps/api/mocks';
import { PhysicsEngine } from '../src/lib/PhysicsEngine.ts';
import { StateArbiter } from '../src/lib/StateArbiter.ts';
import { PetBrain } from '../src/lib/PetBrain.ts';
import { SleepSequence } from '../src/lib/SleepSequence.ts';
import { beginPetGesture } from '../src/lib/petGesture.ts';

function physicsHarness(t, screen) {
  globalThis.window = {};
  globalThis.document = new EventTarget();
  const frames = new Map(); let id = 0; const moves = []; const states = [];
  globalThis.requestAnimationFrame = cb => { frames.set(++id, cb); return id; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  mockWindows('pet');
  mockIPC((command, args) => {
    if (command === 'get_screen_bounds') return screen?.() ?? {x:0, y:0, width:1200, height:1000, scale:1};
    if (command === 'plugin:window|outer_position') return {x:800, y:798};
    if (command === 'plugin:window|set_position') moves.push(args.position);
  });
  const physics = new PhysicsEngine({windowWidth:200, windowHeight:200, onStateChange: s => states.push(s)});
  t.after(() => {physics.stop(); clearMocks();});
  return {physics, frames, moves, states};
}

test('concurrent physics starts schedule exactly one frame loop', async t => {
  const {physics, frames} = physicsHarness(t);
  await Promise.all([physics.start(), physics.start(), physics.start()]);
  assert.equal(frames.size, 1);
  physics.stop();
  assert.equal(frames.size, 0);
});

test('stopping during an asynchronous start cannot resurrect movement', async t => {
  let release;
  const screen = new Promise(resolve => release = resolve);
  const {physics, frames, moves} = physicsHarness(t, () => screen);
  const pending = physics.start();
  await setImmediate();
  physics.stop();
  release({x:0, y:0, width:1200, height:1000, scale:1});
  await pending;
  assert.equal(frames.size, 0);
  assert.equal(moves.length, 0);
});

test('an old start finishing after a restart does not create a second loop', async t => {
  let release; let calls = 0;
  const delayed = new Promise(resolve => release = resolve);
  const bounds = {x:0, y:0, width:1200, height:1000, scale:1};
  const {physics, frames} = physicsHarness(t, () => ++calls === 1 ? delayed : bounds);
  const old = physics.start(); await setImmediate();
  physics.stop(); await physics.start();
  release(bounds); await old;
  assert.equal(frames.size, 1);
});

test('release without a drag never injects a jump; a gentle drag release rests', async t => {
  const {physics, states, frames} = physicsHarness(t);
  await physics.start();
  await physics.onDragEnd();
  assert.equal(physics.getState(), 'idle');
  physics.onDragStart();
  assert.equal(frames.size, 0);
  await physics.onDragEnd();
  assert.equal(physics.getState(), 'idle');
  assert.ok(!states.includes('jump'));
});

test('oneshot animation restores the latest continuous state from the same source', t => {
  t.mock.timers.enable({apis:['setTimeout']});
  const arbiter = new StateArbiter(); t.after(() => arbiter.dispose());
  arbiter.request({source:'brain', state:'idle'});
  arbiter.request({source:'brain', state:'interact', durationMs:500});
  arbiter.request({source:'brain', state:'walk'});
  assert.equal(arbiter.getState(), 'interact');
  t.mock.timers.tick(500);
  assert.equal(arbiter.getState(), 'walk');
});

test('drag wins over notifications; priority overrides are reflected in queries', () => {
  const arbiter = new StateArbiter();
  arbiter.request({source:'user', state:'dragged'});
  arbiter.request({source:'notification', state:'notification'});
  assert.equal(arbiter.getState(), 'dragged');
  arbiter.revokeSource('user');
  assert.equal(arbiter.getState(), 'notification');
  arbiter.request({source:'emotion', state:'sleep', priority:20});
  assert.equal(arbiter.getPriority(), 20);
  arbiter.dispose();
});

test('interacting while awake resets idle time and notices prevent sleeping', t => {
  t.mock.timers.enable({apis:['setInterval', 'setTimeout']});
  const arbiter = new StateArbiter();
  const sleep = new SleepSequence({arbiter, yawnDelayMs:3000});
  t.after(() => {sleep.dispose(); arbiter.dispose();});
  sleep.start(); t.mock.timers.tick(2000); sleep.wake();
  t.mock.timers.tick(2000); assert.equal(sleep.getPhase(), 'awake');
  arbiter.request({source:'notification', state:'notification', oneshot:false});
  t.mock.timers.tick(5000); assert.equal(sleep.getPhase(), 'awake');
  arbiter.revokeSource('notification'); t.mock.timers.tick(3000);
  assert.equal(sleep.getPhase(), 'yawn');
  sleep.wake(); assert.equal(sleep.getPhase(), 'awake');
});

const kanban = (changes = {}) => ({
  actions: [], stats: {pending:0, active:0, blocked:0, completedToday:0, ...changes},
});

test('unchanged task polls do not repeat alerts and mode recovers when cleared', t => {
  globalThis.localStorage = {getItem: () => null};
  const modes = []; const notices = []; const behaviors = []; const events = [];
  const brain = new PetBrain({onModeChange:m => modes.push(m), onMoodChange:()=>{},
    onBehaviorChange:b=>behaviors.push(b), onNotify:n=>notices.push(n), onKanbanEvent:e=>events.push(e)},
    {autonomousBehavior:false});
  t.after(() => brain.dispose()); brain.start();
  brain.updateKanban(kanban({blocked:1, completedToday:4}));
  brain.updateKanban(kanban({blocked:1, completedToday:4}));
  brain.updateKanban(kanban({blocked:1, completedToday:4}));
  assert.equal(notices.length, 1);
  assert.equal(events.length, 0, 'initial history must not look like new completion events');
  brain.updateKanban(kanban());
  assert.deepEqual(modes, ['alert','leisure']);
  assert.deepEqual(behaviors, [], 'awareness-only brain must not create autonomous behaviors');
});

function mouse(target, name, x = 0, buttons = 1) {
  target.dispatchEvent(Object.assign(new Event(name), {screenX:x, screenY:0, buttons}));
}
function gestureHarness(t, overrides = {}) {
  const target = new EventTarget(); const calls = [];
  const dispose = beginPetGesture({target, startX:0, startY:0,
    startDragging:async()=>calls.push('native'), primaryButtonDown:async()=>false,
    onDragStart:()=>calls.push('drag'), onRelease:()=>calls.push('release'),
    onError:()=>calls.push('error'), ...overrides});
  t.after(dispose); return {target, calls, dispose};
}

test('click or small cursor jitter never starts native drag', t => {
  const {target, calls} = gestureHarness(t);
  mouse(target,'mousemove',3); mouse(target,'mouseup',3,0);
  assert.deepEqual(calls,['release']);
});

test('native release resolves a drag even when WebView never receives mouseup', async t => {
  const {target, calls} = gestureHarness(t);
  mouse(target,'mousemove',20); mouse(target,'mousemove',30);
  await setImmediate();
  assert.deepEqual(calls,['drag','native','release']);
  mouse(target,'mouseup',30,0);
  assert.deepEqual(calls,['drag','native','release']);
});

test('disposing a gesture ignores late native completion and removes listeners', async t => {
  let release;
  const pending = new Promise(resolve => release = resolve);
  const {target, calls, dispose} = gestureHarness(t, {startDragging:()=>pending});
  mouse(target,'mousemove',20); dispose(); release(); await setImmediate();
  mouse(target,'mouseup',20,0);
  assert.deepEqual(calls,['drag']);
});

test('failed native drag cleans up and releases once', async t => {
  const {target,calls} = gestureHarness(t, {startDragging:async()=>{throw new Error('unavailable');}});
  mouse(target,'mousemove',20); await setImmediate(); mouse(target,'mouseup',20,0);
  assert.deepEqual(calls,['drag','error','release']);
});

test('WebKit buttons=0 during a held press still recognizes dragging', async t => {
  const {target,calls} = gestureHarness(t);
  mouse(target,'mousemove',30,0); await setImmediate();
  assert.deepEqual(calls,['drag','native','release']);
});

test('native positioning classifies movement even if the OS consumes every DOM move', async t => {
  let reads = 0; const releases = [];
  const {target,calls} = gestureHarness(t, {
    readPosition:async()=> ++reads === 1 ? {x:200,y:100} : {x:260,y:100},
    onRelease:dragged=>releases.push(dragged),
  });
  assert.deepEqual(calls,['native'], 'drag must start on mousedown, before the first move');
  mouse(target,'mouseup',0,0); await setImmediate();
  assert.deepEqual(releases,[true]);
  assert.deepEqual(calls,['native','drag']);
});

test('a native press with unchanged position opens once as a click', async t => {
  const releases=[];
  const {target,calls} = gestureHarness(t, {
    readPosition:async()=>({x:200,y:100}), onRelease:dragged=>releases.push(dragged),
  });
  mouse(target,'mouseup',0,0); mouse(target,'mouseup',0,0); await setImmediate();
  assert.deepEqual(releases,[false]); assert.deepEqual(calls,['native']);
});

test('cancelling a native gesture never becomes a click', async t => {
  const releases=[];
  const {target} = gestureHarness(t, {
    readPosition:async()=>({x:200,y:100}), onRelease:dragged=>releases.push(dragged),
  });
  mouse(target,'pointercancel',0,0); await setImmediate();
  assert.deepEqual(releases,[true]);
});

test('native drag without any DOM mouse events is released after the OS event turn', async t => {
  t.mock.timers.enable({apis:['setTimeout']});
  let reads = 0; const releases=[];
  const {calls} = gestureHarness(t, {
    readPosition:async()=>({x:++reads === 1 ? 100 : 180,y:100}),
    onRelease:dragged=>releases.push(dragged),
  });
  await setImmediate();
  assert.deepEqual(releases,[]);
  t.mock.timers.tick(160); await setImmediate();
  assert.deepEqual(releases,[true]);
  assert.deepEqual(calls,['native','drag']);
});

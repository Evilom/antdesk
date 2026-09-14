import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, useCallback, useRef } from "react";
import SpinePet, { type SpinePetHandle } from "./components/SpinePet";
import { PhysicsEngine } from "./lib/PhysicsEngine";
import { StateArbiter } from "./lib/StateArbiter";
import { SleepSequence } from "./lib/SleepSequence";
import { PetBrain, type PetMode } from "./lib/PetBrain";
import {
  DesktopWorldBridge, WINDOW_INTERACTION_LABEL, isWindowInteractionMode,
  nextWindowInteractionMode, readWindowInteractionMode, writeWindowInteractionMode,
  type WindowInteractionMode,
} from "./lib/DesktopWorldBridge";
import { KanbanBridge } from "./lib/kanbanBridge";
import { useKanbanStore } from "./stores/kanbanStore";
import { useAppStore } from "./stores/appStore";
import { EmotionEngine } from "./lib/EmotionEngine";
import { getLocalNotionToken } from "./lib/localSettings";
import { beginPetGesture } from "./lib/petGesture";
import { Mic, MicOff, PhoneOff, Square } from 'lucide-react';
import { INITIAL_VOICE, publish, subscribe, type VoiceStatus } from './lib/pm';

const ANIMATIONS: Record<string, string> = {
  idle: "stand", walk: "walk", run: "run", jump: "jump", falling: "fall",
  dragged: "stand", sleep: "sleep", dozing: "stand", yawn: "stand",
  notification: "stand", interact: "idle", perch: "stand", bumped: "jump", pushed: "walk",
};

interface PetRuntime {
  physics: PhysicsEngine;
  brain: PetBrain;
  sleep: SleepSequence;
  emotion: EmotionEngine;
  arbiter: StateArbiter;
  syncMotion: () => void;
  notify: (message: string) => void;
}

/** One window, one motion owner. Task awareness never starts a second behavior loop. */
export default function Pet() {
  const native = isTauri();
  const [locked, setLocked] = useState(() => localStorage.getItem("antdesk_pet_locked") === "true");
  const [mode, setMode] = useState<WindowInteractionMode>(readWindowInteractionMode);
  const [visualState, setVisualState] = useState("idle");
  const [petMode, setPetMode] = useState<PetMode>("leisure");
  const [pendingCount, setPendingCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [voice, setVoice] = useState<VoiceStatus>(INITIAL_VOICE);
  const voiceActive = !['idle','disconnected'].includes(voice.state);
  const reduceMotion = useAppStore(s => s.settings.reduceMotion);
  const spineRef = useRef<SpinePetHandle>(null);
  const runtimeRef = useRef<PetRuntime | null>(null);
  const gestureCleanup = useRef<(() => void) | null>(null);
  const pressedRef = useRef(false);
  const hoveringRef = useRef(false);
  const optionsRef = useRef({ locked, mode, reduceMotion });
  const kanbanEndpoint = useKanbanStore(s => s.endpoint);
  const kanbanStats = useKanbanStore(s => s.data.stats);

  useEffect(()=>{
    let disposed=false;let off:(()=>void)|undefined;
    void subscribe<VoiceStatus>('pm:voice:status',setVoice).then(fn=>{if(disposed)fn();else{off=fn;void publish('pm:voice:request',null);}});
    return ()=>{disposed=true;off?.();};
  },[]);
  useEffect(()=>{
    const send=()=>{
      const runtime=runtimeRef.current;
      void publish('pm:pet:snapshot',{observedAt:Date.now(),visualState,mode:petMode,locked,sleep:runtime?.sleep.getPhase()||'unknown',emotion:runtime?.emotion.getState()||null,tasks:{notionPending:pendingCount,kanban:kanbanStats}});
    };
    send();const timer=setInterval(send,5000);return ()=>clearInterval(timer);
  },[visualState,petMode,locked,pendingCount,kanbanStats]);
  const voiceCommand=(action:string)=>{void publish('pm:voice:command',action).catch(()=>runtimeRef.current?.notify('助理连接暂不可用'));};

  useEffect(() => {
    let disposed = false;
    let notificationActive = false;
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
    const arbiter = new StateArbiter({ onResolved: state => setVisualState(state) });
    const physics = new PhysicsEngine({
      windowWidth: 200, windowHeight: 200, walkSpeed: 24, runSpeed: 46,
      mouseAttraction: 0, edgePadding: 4,
      onStateChange: state => arbiter.request({ state, source: "physics" }),
      onFacingChange: dir => spineRef.current?.setFacingDirection(dir),
    });
    const syncMotion = () => {
      if (disposed) return;
      const { locked, mode, reduceMotion } = optionsRef.current;
      physics.configure({
        interactionMode: mode === "enhanced" ? "enhanced" : "standard",
        walkSpeed: mode === "enhanced" ? 35 : 24,
        runSpeed: mode === "enhanced" ? 70 : 46,
        mouseAttraction: mode === "enhanced" ? 0.08 : 0,
      });
      const weights = emotion.getBehaviorWeights();
      physics.setBehaviorWeights(mode === "enhanced" ? weights : {
        stroll: weights.stroll * 0.4, explore: weights.explore * 0.25,
        sprint: 0, chase: 0, rest: 0.7,
      });
      if (!native || locked || mode === "off" || reduceMotion || pressedRef.current ||
          hoveringRef.current || notificationActive || sleep.getPhase() !== "awake") {
        physics.stop();
        arbiter.revokeSource("physics");
      } else {
        void physics.start().catch(error => console.warn("[Pet] motion unavailable", error));
      }
    };
    const emotion = new EmotionEngine({ onChange: () => syncMotion() });
    const sleep = new SleepSequence({
      arbiter, yawnDelayMs: 120_000, dozeDurationMs: 10_000,
      onSleepChange: phase => {
        if (disposed) return;
        if (phase === "sleeping") emotion.emit("sleeping");
        syncMotion();
      },
    });
    const notify = (message: string) => {
      if (disposed) return;
      notificationActive = true;
      clearTimeout(noticeTimer);
      sleep.wake();
      emotion.emit("notification");
      setNotice(message);
      arbiter.request({ state: "notification", source: "notification", oneshot: false });
      syncMotion();
      noticeTimer = setTimeout(() => {
        notificationActive = false;
        setNotice(null);
        arbiter.revokeSource("notification");
        syncMotion();
      }, 8000);
    };
    const brain = new PetBrain({
      onBehaviorChange: () => {},
      onMoodChange: () => {},
      onModeChange: next => {
        setPetMode(next);
        if (next === "alert" || next === "anxious") emotion.emit("task_overdue");
        if (next === "celebrate") emotion.emit("task_completed");
      },
      onNotify: notify,
      onKanbanEvent: (_event, message) => notify(message),
    }, { autonomousBehavior: false });
    runtimeRef.current = { physics, brain, sleep, emotion, arbiter, syncMotion, notify };
    emotion.start();
    sleep.start();
    brain.start();
    syncMotion();
    return () => {
      disposed = true;
      gestureCleanup.current?.();
      gestureCleanup.current = null;
      clearTimeout(noticeTimer);
      physics.stop();
      brain.dispose();
      sleep.dispose();
      emotion.dispose();
      arbiter.dispose();
      runtimeRef.current = null;
    };
  }, [native]);

  useEffect(() => {
    optionsRef.current = { locked, mode, reduceMotion };
    localStorage.setItem("antdesk_pet_locked", String(locked));
    writeWindowInteractionMode(mode);
    runtimeRef.current?.syncMotion();
  }, [locked, mode, reduceMotion]);

  useEffect(() => {
    spineRef.current?.setAnimation(ANIMATIONS[visualState] ?? "stand", true);
  }, [visualState]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const subscriptions = [
      listen("toggle-lock", () => setLocked(value => !value)),
      listen("toggle-bubble", () => void invoke("toggle_quick_panel").catch(() => {})),
      listen("toggle-window-interaction", () => setMode(nextWindowInteractionMode)),
      listen<WindowInteractionMode>("set-window-interaction-mode", event => {
        if (isWindowInteractionMode(event.payload)) setMode(event.payload);
      }),
    ];
    const unlisten: Array<() => void> = [];
    for (const promise of subscriptions) void promise.then(fn => {
      if (disposed) fn(); else unlisten.push(fn);
    }).catch(error => console.warn("[Pet] menu listener", error));
    return () => { disposed = true; unlisten.forEach(fn => fn()); };
  }, [native]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const token = getLocalNotionToken() || await invoke<string>("get_notion_token");
        const count = token ? await invoke<number>("get_pending_count", { token }) : 0;
        if (!disposed) setPendingCount(count);
      } catch { /* Keep the last successful count during transient failures. */ }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 60_000);
    return () => { disposed = true; clearInterval(timer); };
  }, [native]);

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    const bridge = new KanbanBridge({
      endpoint: kanbanEndpoint || undefined,
      onData: data => {
        if (disposed) return;
        useKanbanStore.getState().setData(data);
        useKanbanStore.getState().setConnected(true);
        runtimeRef.current?.brain.updateKanban(data);
      },
      onError: error => { if (!disposed) useKanbanStore.getState().setError(error); },
    });
    bridge.start();
    return () => { disposed = true; bridge.dispose(); };
  }, [native, kanbanEndpoint]);

  useEffect(() => {
    const physics = runtimeRef.current?.physics;
    if (!native || mode === "off") { physics?.setPlatforms([]); return; }
    const bridge = new DesktopWorldBridge({
      mode,
      onSurfaces: surfaces => physics?.setPlatforms(surfaces.map(surface => ({
        ...surface, source: "window", name: surface.app,
      }))),
      onError: error => console.warn("[Pet] window interaction unavailable", error),
    });
    bridge.start();
    return () => bridge.stop();
  }, [native, mode]);

  const handleClick = useCallback(() => {
    const runtime = runtimeRef.current;
    runtime?.sleep.wake();
    runtime?.brain.interact();
    runtime?.emotion.emit("user_interaction");
    if (native) {
      void invoke("hide_fab_context_menu").catch(() => {});
      void invoke("toggle_quick_panel").catch(() => runtime?.notify("快捷面板暂时无法打开"));
    }
  }, [native]);


  const handleMouseDown = useCallback((event: React.MouseEvent) => {
    if (event.button !== 0) return;
    const runtime = runtimeRef.current;
    if (!runtime) return;
    runtime.sleep.wake();
    if (locked || !native) return;
    gestureCleanup.current?.();
    pressedRef.current = true;
    runtime.syncMotion();
    gestureCleanup.current = beginPetGesture({
      startX: event.screenX, startY: event.screenY, target: document,
      startDragging: () => getCurrentWindow().startDragging(),
      primaryButtonDown: () => invoke<boolean>("pet_primary_button_down"),
      readPosition: () => getCurrentWindow().outerPosition(),
      onDragStart: () => {
        setDragging(true);
        runtime.arbiter.request({ state: "dragged", source: "user", oneshot: false });
        void invoke("hide_fab_context_menu").catch(() => {});
      },
      onRelease: wasDragged => {
        pressedRef.current = false;
        setDragging(false);
        runtime.sleep.wake();
        runtime.arbiter.revokeSource("user");
        runtime.syncMotion();
        if (wasDragged) void invoke("update_quick_panel_position").catch(() => {});
        else handleClick();
      },
      onError: () => runtime.notify("这次没能移动，松开后再拖一下"),
    });
  }, [locked, native, handleClick]);


  const handleHover = (value: boolean) => {
    hoveringRef.current = value;
    setHovered(value);
    if (value) runtimeRef.current?.sleep.wake();
    runtimeRef.current?.syncMotion();
  };
  const count = pendingCount + kanbanStats.active + kanbanStats.blocked;
  const status = locked ? "位置已锁定" : WINDOW_INTERACTION_LABEL[mode];
  const hint = dragging ? "松开放在这里" : locked ? "点击打开 · 右键解锁" : "点击打开 · 拖动位置";

  return (
    <div className="pet-window" data-state={visualState} data-mode={petMode} data-dragging={dragging} data-locked={locked}>
      <button className="pet-view" aria-label={`${status}，${hint}`}
        onMouseDown={handleMouseDown} onClick={event => {
          // Pointer clicks are classified by the native gesture; retain keyboard/AX activation.
          if (event.detail === 0 || locked || !native) handleClick();
        }}
        onMouseEnter={() => handleHover(true)} onMouseLeave={() => handleHover(false)}
        onContextMenu={event => {
          event.preventDefault();
          runtimeRef.current?.sleep.wake();
          if (native) void invoke("show_fab_context_menu").catch(() => {});
        }}>
        <span className="pet-stage" aria-hidden="true">
          <SpinePet ref={spineRef} petName="moshumao" width={150} height={150} />
        </span>
        <span className="pet-caption" data-visible={hovered || dragging} aria-hidden="true">
          {status}{count > 0 ? ` · ${count} 项待办` : ""}
        </span>
      </button>
      {(voice.error || notice || (voiceActive && voice.caption) || hovered || dragging) && <div className="thought-bubble" role="status">
        {voice.error || notice || (voiceActive && voice.caption) || hint}
      </div>}
      <div className="pet-voice-controls" aria-label="宠物语音助理">
        <button aria-label={voiceActive?(voice.muted?'取消静音':'静音麦克风'):'开启常驻语音'} aria-pressed={voiceActive&&!voice.muted} onClick={()=>voiceCommand(voiceActive?'mute':'toggle')} disabled={voiceActive&&voice.state!=='connected'}>{voice.muted?<MicOff size={14}/>:<Mic size={14}/>}</button>
        {voiceActive && <><button aria-label="打断助理" disabled={voice.state!=='connected'} onClick={()=>voiceCommand('interrupt')}><Square size={11}/></button><button aria-label="结束语音" onClick={()=>voiceCommand('stop')}><PhoneOff size={14}/></button></>}
        {voice.error && <button aria-label="打开助理设置" onClick={()=>{voiceCommand('settings');if(native)void invoke('open_full_panel');}}>设置</button>}
      </div>
    </div>
  );
}

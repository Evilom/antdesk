import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { useEffect, useState, useCallback, useRef } from "react";
import SpinePet, { type SpinePetHandle } from "./components/SpinePet";
import { PhysicsEngine } from "./lib/PhysicsEngine";
import { StateArbiter } from "./lib/StateArbiter";
import { SleepSequence } from "./lib/SleepSequence";
import { PetBrain, MODE_PHYSICS, type PetMode, type BehaviorState } from "./lib/PetBrain";
import { KanbanBridge } from "./lib/kanbanBridge";
import { useKanbanStore } from "./stores/kanbanStore";
import type { KanbanData } from "./types/kanban";
import { EmotionEngine } from "./lib/EmotionEngine";

const BEHAVIOR_EMOJI: Record<BehaviorState, string> = {
  idle: "😊", walk: "🚶", interact: "😄", sleep: "😴",
};

/**
 * Pet = FAB. Single 200×200 transparent window.
 *
 * Priority: drag > click (open panel) > roaming
 *
 * Drag uses manual delta positioning (clawd-on-desk pattern):
 *   mousedown → snapshot cursor + window pos
 *   mousemove → delta → setPosition (pet + notepad follows)
 *   mouseup   → resume physics from new position
 */

export default function Pet() {
  const [connected, setConnected] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [locked, setLocked] = useState(false);
  const [windowInteraction, setWindowInteraction] = useState(() => localStorage.getItem("antdesk_window_interaction") === "true");
  const [petName] = useState("moshumao");
  const [petBehavior, setPetBehavior] = useState<BehaviorState>("idle");
  const [petMode, setPetMode] = useState<PetMode>("leisure");
  const [moodText, setMoodText] = useState("");
  const [moodEmoji, setMoodEmoji] = useState("😊");
  const [pendingCount, setPendingCount] = useState(0);
  const [notifyMsg, setNotifyMsg] = useState<string | null>(null);
  const [physState, setPhysState] = useState<string>("idle");
  const [emotionMood, setEmotionMood] = useState<{emoji: string; text: string} | null>(null);

  const didDrag = useRef(false);
  const spineRef = useRef<SpinePetHandle>(null);
  const physicsRef = useRef<PhysicsEngine | null>(null);
  const brainRef = useRef<PetBrain | null>(null);
  const lockedRef = useRef(false);
  const windowInteractionRef = useRef(windowInteraction);
  const notifyTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const arbiterRef = useRef<StateArbiter | null>(null);
  const emotionRef = useRef<EmotionEngine | null>(null);

  const setKanbanData = useKanbanStore((s) => s.setData);
  const setKanbanConnected = useKanbanStore((s) => s.setConnected);
  const setKanbanError = useKanbanStore((s) => s.setError);
  const kanbanEndpoint = useKanbanStore((s) => s.endpoint);

  useEffect(() => { lockedRef.current = locked; }, [locked]);
  useEffect(() => { windowInteractionRef.current = windowInteraction; localStorage.setItem("antdesk_window_interaction", String(windowInteraction)); }, [windowInteraction]);

  /* ═══ Init ═══ */
  useEffect(() => {
    invoke<string>("get_notion_token").then(() => setConnected(true)).catch(() => {});
    invoke<number>("get_pending_count").then(setPendingCount).catch(() => {});
    const t = setInterval(() => {
      invoke<number>("get_pending_count").then(setPendingCount).catch(() => {});
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  /* ═══ Native menu events ═══ */
  useEffect(() => {
    const u1 = listen("toggle-lock", () => setLocked((v) => !v));
    const u2 = listen("toggle-bubble", () => invoke("toggle_notepad"));
    return () => { u1.then((f) => f()); u2.then((f) => f()); };
  }, []);

  /* ═══ KanbanBridge ═══ */
  useEffect(() => {
    const bridge = new KanbanBridge({
      endpoint: kanbanEndpoint || undefined,
      onData: (data: KanbanData) => {
        setKanbanData(data);
        setKanbanConnected(true);
        brainRef.current?.updateKanban(data);
      },
      onError: (err) => setKanbanError(err),
    });
    bridge.start();
    return () => bridge.dispose();
  }, [kanbanEndpoint]);

  /* ═══ EmotionEngine — multi-dimensional emotion system ═══ */
  useEffect(() => {
    const emotion = new EmotionEngine({
      onChange: (state) => {
        // Push behavior weights to physics
        physicsRef.current?.setBehaviorWeights(emotion.getBehaviorWeights());
        // Update mood for thought bubble
        const mood = emotion.getMoodText();
        setEmotionMood(mood);
      },
    });
    emotion.start();
    emotionRef.current = emotion;

    // Time-of-day events
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 10) emotion.emit("morning_start");
    if (hour >= 21 || hour < 2) emotion.emit("evening");

    return () => { emotion.dispose(); emotionRef.current = null; };
  }, []);

  /* ═══ StateArbiter — priority-based state resolution ═══ */
  useEffect(() => {
    const arbiter = new StateArbiter({
      onResolved: (state, _prev) => {
        setPhysState(state);
        const anims: Record<string, { anim: string; loop: boolean; mood?: string; moodEmoji?: string }> = {
          walk:    { anim: "walk",   loop: true },
          run:     { anim: "run",    loop: true,  mood: "冲啊!", moodEmoji: "🏃" },
          idle:    { anim: "stand",  loop: true },
          jump:    { anim: "jump",   loop: false, mood: "哇!",   moodEmoji: "😮" },
          falling: { anim: "fall",   loop: true,  mood: "啊啊啊!", moodEmoji: "😱" },
          landing: { anim: "stand",  loop: false, mood: "呼...",  moodEmoji: "😮\u200d💨" },
          dizzy:   { anim: "dizzy",  loop: false, mood: "晕了...", moodEmoji: "😵" },
          hitWall: { anim: "stand",  loop: false, mood: "好痛!",  moodEmoji: "😣" },
          slide:   { anim: "walk",   loop: true,  mood: "刹不住!", moodEmoji: "🫨" },
          dragged: { anim: "idle",   loop: true },
          sleep:   { anim: "sleep",  loop: true },
          dozing:  { anim: "stand",  loop: true,  mood: "好困...", moodEmoji: "😪" },
          yawn:    { anim: "stand",  loop: false, mood: "哈~",    moodEmoji: "🥱" },
          notification: { anim: "idle", loop: false, mood: "!", moodEmoji: "⚠️" },
          celebrate:    { anim: "run",  loop: false, mood: "太棒了!", moodEmoji: "🎉" },
          anxious:      { anim: "walk", loop: true,  mood: "任务有点多...", moodEmoji: "😰" },
          interact:     { anim: "idle", loop: false },
          explore:      { anim: "walk", loop: true },
        };
        const cfg = anims[state] ?? anims.idle;
        spineRef.current?.setAnimation(cfg.anim, cfg.loop);
        if (cfg.mood) {
          setMoodEmoji(cfg.moodEmoji || "😊");
          setMoodText(cfg.mood);
          const dur = state === "dizzy" ? 1500 : state === "hitWall" ? 800 : state === "landing" ? 600 : 1200;
          setTimeout(() => setMoodText(""), dur);
        }
      },
    });
    arbiterRef.current = arbiter;

    // Sleep sequence — mouse idle detection
    const sleep = new SleepSequence({
      arbiter,
      yawnDelayMs: 60000,
      dozeDurationMs: 10000,
      onSleepChange: (phase) => {
        if (phase === "awake") {
          // Resume physics if was sleeping
          if (!lockedRef.current) physicsRef.current?.start().catch(() => {});
        } else if (phase === "sleeping") {
          emotionRef.current?.emit("sleeping");
          physicsRef.current?.stop();
        }
      },
    });
    sleep.start();

    // Track mouse for sleep detection
    const onMouse = (e: MouseEvent) => sleep.updateMouse(e.screenX, e.screenY);
    document.addEventListener("mousemove", onMouse);

    return () => {
      arbiter.dispose(); arbiterRef.current = null;
      sleep.dispose();
      document.removeEventListener("mousemove", onMouse);
    };
  }, []);

  /* ═══ Window Interaction — periodic refresh of window platforms ═══ */
  useEffect(() => {
    const refreshPlatforms = async () => {
      if (!windowInteractionRef.current || !physicsRef.current) return;
      try {
        const wins = await invoke<Array<{name: string; x: number; y: number; width: number; height: number}>>("get_visible_windows");
        const platforms = wins.map(w => ({
          x: w.x, y: w.y,
          width: w.width,
          height: w.height,
          source: "window" as const, name: w.name,
        }));
        physicsRef.current.refreshPlatforms(platforms);
      } catch (e) {
        console.warn("[Pet] refreshPlatforms failed:", e);
      }
    };

    refreshPlatforms();
    const interval = setInterval(refreshPlatforms, 2000);
    return () => clearInterval(interval);
  }, []);

  /* ═══ PetBrain ═══ */
  useEffect(() => {
    const brain = new PetBrain({
      onBehaviorChange: (state, anim) => {
        setPetBehavior(state);
        // Brain states have priority 1 (same as physics locomotion)
        // Higher priority events (notification, anxious) will override
        arbiterRef.current?.request({ state, source: "brain" });
        if (state === "sleep") {
          physicsRef.current?.stop();
        } else if (state === "walk" && !lockedRef.current) {
          physicsRef.current?.start().catch(() => {});
        }
      },
      onModeChange: (mode) => {
        setPetMode(mode);
        physicsRef.current?.configure(MODE_PHYSICS[mode]);
        if (mode === "anxious" || mode === "alert") emotionRef.current?.emit("task_overdue");
        if (mode === "celebrate") emotionRef.current?.emit("task_completed");
      },
      onMoodChange: (mood) => setMoodText(mood),
      onNotify: (msg) => {
        setNotifyMsg(msg);
        emotionRef.current?.emit("notification");
        arbiterRef.current?.request({
          state: "notification", source: "notification",
          oneshot: true, durationMs: 6000,
        });
        if (notifyTimer.current) clearTimeout(notifyTimer.current);
        notifyTimer.current = setTimeout(() => setNotifyMsg(null), 6000);
      },
      onKanbanEvent: (_e, detail) => {
        setNotifyMsg(detail);
        emotionRef.current?.emit("notification");
        arbiterRef.current?.request({
          state: "notification", source: "notification",
          oneshot: true, durationMs: 8000,
        });
        if (notifyTimer.current) clearTimeout(notifyTimer.current);
        notifyTimer.current = setTimeout(() => setNotifyMsg(null), 8000);
      },
    });
    brain.start();
    brainRef.current = brain;
    return () => { brain.dispose(); brainRef.current = null; };
  }, []);

  /* ═══ PhysicsEngine ═══ */
  useEffect(() => {
    const physics = new PhysicsEngine({
      windowWidth: 200, windowHeight: 200,
      walkSpeed: 35, runSpeed: 85, idleProbability: 0.3, edgePadding: 4, mouseAttraction: 0.12,
      onStateChange: (state) => {
        arbiterRef.current?.request({ state, source: "physics" });
      },
      onFacingChange: (dir) => spineRef.current?.setFacingDirection(dir),
    });
    physics.start()
      .then(() => console.log("[Pet] roaming started"))
      .catch((e) => console.error("[Pet] roaming failed:", e));
    physicsRef.current = physics;
    return () => { physics.stop(); physicsRef.current = null; };
  }, []);

  /* ═══ Lock ═══ */
  useEffect(() => {
    if (locked) physicsRef.current?.stop();
    else if (petBehavior !== "sleep") physicsRef.current?.start().catch(() => {});
  }, [locked, petBehavior]);

  /* ═══ Close menu on outside click ═══ */
  useEffect(() => {
    if (!menuOpen) return;
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest(".menu")) setMenuOpen(false);
    };
    const t = setTimeout(() => document.addEventListener("mousedown", close), 50);
    return () => { clearTimeout(t); document.removeEventListener("mousedown", close); };
  }, [menuOpen]);

  /* ═══════════════════════════════════════════
     DRAG — manual delta (clawd-on-desk pattern)
     P0: overrides click and roaming
     ═══════════════════════════════════════════ */
  const handlePetMouseDown = useCallback(
    async (e: React.MouseEvent) => {
      if (e.button !== 0 || locked || menuOpen) return;

      const win = getCurrentWindow();
      const startScreenX = e.screenX;
      const startScreenY = e.screenY;

      // Pause physics
      physicsRef.current?.onDragStart();

      // Snapshot window position (logical pixels)
      const scale = window.devicePixelRatio || 1;
      const pos = await win.outerPosition();
      const startWinX = pos.x / scale;
      const startWinY = pos.y / scale;

      // Snapshot notepad offset (if visible)
      let npOffset: { dx: number; dy: number } | null = null;
      let npWin: Window | null = null;
      try {
        npWin = await Window.getByLabel("notepad");
        if (npWin && await npWin.isVisible()) {
          const npPos = await npWin.outerPosition();
          npOffset = {
            dx: npPos.x / scale - startWinX,
            dy: npPos.y / scale - startWinY,
          };
        }
      } catch {}

      didDrag.current = false;

      // Track drag history for release velocity calculation
      const history: Array<{ x: number; y: number; t: number }> = [];

      const onMove = (me: MouseEvent) => {
        if (me.buttons !== 1) return;
        const dx = me.screenX - startScreenX;
        const dy = me.screenY - startScreenY;
        if (!didDrag.current && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
          didDrag.current = true;
        }
        const newX = startWinX + dx;
        const newY = startWinY + dy;
        win.setPosition(new LogicalPosition(newX, newY)).catch(() => {});
        if (npOffset && npWin) {
          npWin.setPosition(
            new LogicalPosition(newX + npOffset.dx, newY + npOffset.dy)
          ).catch(() => {});
        }
        // Record position for velocity
        history.push({ x: me.screenX, y: me.screenY, t: performance.now() });
        if (history.length > 6) history.shift();
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        // Calculate release velocity (logical px/s)
        let releaseVx = 0, releaseVy = 0;
        if (history.length >= 2) {
          const first = history[0];
          const last = history[history.length - 1];
          const dtMs = last.t - first.t;
          if (dtMs > 0 && dtMs < 300) {
            const dt = dtMs / 1000;
            releaseVx = (last.x - first.x) / dt;
            releaseVy = (last.y - first.y) / dt;
          }
        }
        physicsRef.current?.onDragEnd(releaseVx, releaseVy);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [locked, menuOpen]
  );

  /* ═══ CLICK → toggle quick panel ═══ */
  const handlePetClick = useCallback(() => {
    if (didDrag.current) return;
    if (menuOpen) { setMenuOpen(false); return; }
    brainRef.current?.interact();
    emotionRef.current?.emit("user_interaction");
    invoke("toggle_notepad");
  }, [menuOpen]);

  /* ═══ RIGHT-CLICK → context menu ═══ */
  const handlePetContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setMenuOpen(true);
  }, []);

  /* ═══ Derived ═══ */
  const kanbanStats = useKanbanStore((s) => s.data.stats);
  const totalBadge = pendingCount + kanbanStats.active + kanbanStats.blocked;
  const sleeping = petBehavior === "sleep";

  /* ═══ Thought system — single bubble cycling through pet thoughts ═══ */
  const [thoughtIdx, setThoughtIdx] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setThoughtIdx(i => i + 1), 3000);
    return () => clearInterval(interval);
  }, []);

  const thoughtPool = (() => {
    const pool: Array<{emoji: string; text: string; key: string; priority?: boolean}> = [];
    if (notifyMsg) return [{ emoji: "⚠️", text: notifyMsg, key: "notify", priority: true }];
    if (physState === "dizzy") return [{ emoji: "💫", text: "晕了...", key: "dizzy", priority: true }];
    if (physState === "falling") return [{ emoji: "😱", text: "啊啊啊!", key: "fall", priority: true }];
    if (physState === "jump") return [{ emoji: "😮", text: "哇!", key: "jump", priority: true }];
    if (physState === "hitWall") return [{ emoji: "😣", text: "好痛!", key: "hitwall", priority: true }];
    if (physState === "slide") return [{ emoji: "🫨", text: "刹不住!", key: "slide", priority: true }];
    if (physState === "landing") return [{ emoji: "😮‍💨", text: "呼...", key: "landing", priority: true }];
    if (physState === "run") return [{ emoji: "🏃", text: "冲啊!", key: "run", priority: true }];
    if (petMode === "anxious") pool.push({ emoji: "😰", text: "任务有点多...", key: "anxious" });
    if (petMode === "alert") pool.push({ emoji: "⏰", text: "有逾期任务!", key: "alert" });
    if (petMode === "celebrate") pool.push({ emoji: "🎉", text: "干得漂亮!", key: "celebrate" });
    if (totalBadge > 0) pool.push({ emoji: "📋", text: `${totalBadge}个待办`, key: "badge" });
    if (moodText) pool.push({ emoji: moodEmoji, text: moodText, key: "mood" });
    if (emotionMood && emotionMood.text !== "~") pool.push({ emoji: emotionMood.emoji, text: emotionMood.text, key: "emotion" });
    if (petBehavior === "walk" && !locked) pool.push({ emoji: "🐾", text: "散步中~", key: "walk" });
    if (sleeping) pool.push({ emoji: "💤", text: "zzZ", key: "sleep" });
    if (connected) pool.push({ emoji: "🔗", text: "已连接", key: "conn" });
    pool.push({ emoji: "😊", text: "~", key: "idle" });
    return pool;
  })();
  const currentThought = thoughtPool[thoughtIdx % thoughtPool.length];

  return (
    <div
      className="pet-window"
      data-state={physState === "dizzy" || physState === "falling" ? physState : sleeping ? "sleep" : petBehavior}
      data-mode={petMode}
    >
      <div
        className="pet-view"
        onMouseDown={handlePetMouseDown}
        onClick={handlePetClick}
        onContextMenu={handlePetContextMenu}
      >
        <SpinePet ref={spineRef} petName={petName} width={150} height={150} />

        {/* Single thought bubble — shows current thought */}
        {currentThought && (
          <div className="thought-bubble" data-priority={currentThought.priority}>
            <span className="thought-e">{currentThought.emoji}</span>
            {currentThought.text}
          </div>
        )}
      </div>

      {menuOpen && (
        <div className="menu">
          <div className="menu-item" onClick={() => { setMenuOpen(false); invoke("expand_panel"); }}>
            📋 主面板
          </div>
          <div className="menu-item" onClick={() => { setMenuOpen(false); invoke("toggle_notepad"); }}>
            📝 便签
          </div>
          <div className="menu-sep" />
          <div className="menu-item" onClick={() => { setLocked((v) => !v); setMenuOpen(false); }}>
            {locked ? "🔓 解锁位置" : "🔒 锁定位置"}
          </div>
          <div className="menu-item" onClick={() => { setMenuOpen(false); invoke("hide_pet"); }}>
            👁️ 隐藏宠物
          </div>
          <div className="menu-sep" />
          <div className="menu-item" onClick={() => {
            const next = !windowInteraction;
            setWindowInteraction(next);
            if (next) {
              invoke<Array<any>>("get_visible_windows").then(wins => {
                const platforms = wins.map((w: any) => ({
                  x: w.x, y: w.y,
                  width: w.width,
                  height: w.height,
                  source: "window" as const, name: w.name,
                }));
                physicsRef.current?.setPlatforms(platforms);
              }).catch(() => {});
            } else {
              physicsRef.current?.setPlatforms([]);
            }
            setMenuOpen(false);
          }}>
            {windowInteraction ? "🪟 窗口交互 ✓" : "🪟 窗口交互"}
          </div>
          <div className="menu-sep" />
          <div className="menu-item quit" onClick={() => invoke("quit_app")}>
            🚪 退出
          </div>
        </div>
      )}
    </div>
  );
}

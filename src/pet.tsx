import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { useEffect, useState, useCallback, useRef } from "react";
import SpinePet, { type SpinePetHandle } from "./components/SpinePet";
import { PhysicsEngine, type PetContactState } from "./lib/PhysicsEngine";
import { StateArbiter } from "./lib/StateArbiter";
import { SleepSequence } from "./lib/SleepSequence";
import { PetBrain, MODE_PHYSICS, type PetMode, type BehaviorState } from "./lib/PetBrain";
import {
  DesktopWorldBridge,
  WINDOW_INTERACTION_LABEL,
  isWindowInteractionMode,
  nextWindowInteractionMode,
  readWindowInteractionMode,
  writeWindowInteractionMode,
  type DesktopCapability,
  type WindowInteractionMode,
} from "./lib/DesktopWorldBridge";
import { KanbanBridge } from "./lib/kanbanBridge";
import { useKanbanStore } from "./stores/kanbanStore";
import type { KanbanData } from "./types/kanban";
import { EmotionEngine } from "./lib/EmotionEngine";
import { getLocalNotionToken } from "./lib/localSettings";
import { IconLock } from "./components/Icons";

type SnapEdge = "none" | "left" | "right" | "top" | "bottom";

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
  const [locked, setLocked] = useState(false);
  const [windowInteractionMode, setWindowInteractionMode] = useState<WindowInteractionMode>(() => readWindowInteractionMode());
  const [petName] = useState("moshumao");
  const [petBehavior, setPetBehavior] = useState<BehaviorState>("idle");
  const [petMode, setPetMode] = useState<PetMode>("leisure");
  const [moodText, setMoodText] = useState("");
  const [moodEmoji, setMoodEmoji] = useState("😊");
  const [pendingCount, setPendingCount] = useState(0);
  const [notifyMsg, setNotifyMsg] = useState<string | null>(null);
  const [physState, setPhysState] = useState<string>("idle");
  const [emotionMood, setEmotionMood] = useState<{emoji: string; text: string} | null>(null);
  const [petHovered, setPetHovered] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [snapEdge, setSnapEdge] = useState<SnapEdge>("none");
  const [petContact, setPetContact] = useState<PetContactState>("desktop");
  const [desktopCapability, setDesktopCapability] = useState<DesktopCapability>("none");

  const didDrag = useRef(false);
  const spineRef = useRef<SpinePetHandle>(null);
  const physicsRef = useRef<PhysicsEngine | null>(null);
  const brainRef = useRef<PetBrain | null>(null);
  const lockedRef = useRef(false);
  const windowInteractionModeRef = useRef(windowInteractionMode);
  const notifyTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const arbiterRef = useRef<StateArbiter | null>(null);
  const emotionRef = useRef<EmotionEngine | null>(null);

  const setKanbanData = useKanbanStore((s) => s.setData);
  const setKanbanConnected = useKanbanStore((s) => s.setConnected);
  const setKanbanError = useKanbanStore((s) => s.setError);
  const kanbanEndpoint = useKanbanStore((s) => s.endpoint);

  useEffect(() => { lockedRef.current = locked; }, [locked]);
  useEffect(() => {
    windowInteractionModeRef.current = windowInteractionMode;
    writeWindowInteractionMode(windowInteractionMode);
  }, [windowInteractionMode]);
  const windowInteraction = windowInteractionMode !== "off";

  /* ═══ Init ═══ */
  useEffect(() => {
    const refreshCount = async () => {
      const localToken = getLocalNotionToken();
      const envToken = localToken ? "" : await invoke<string>("get_notion_token").catch(() => "");
      const token = localToken || envToken;
      setConnected(Boolean(token));
      if (!token) {
        setPendingCount(0);
        return;
      }
      invoke<number>("get_pending_count", { token }).then(setPendingCount).catch(() => setPendingCount(0));
    };
    refreshCount();
    const t = setInterval(() => {
      refreshCount();
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  /* ═══ Native menu events ═══ */
  useEffect(() => {
    const u1 = listen("toggle-lock", () => setLocked((v) => !v));
    const u2 = listen("toggle-bubble", () => invoke("toggle_quick_panel"));
    const u3 = listen("toggle-window-interaction", () => {
      setWindowInteractionMode((current) => nextWindowInteractionMode(current));
    });
    const u4 = listen<WindowInteractionMode>("set-window-interaction-mode", (event) => {
      if (isWindowInteractionMode(event.payload)) {
        setWindowInteractionMode(event.payload);
      }
    });
    return () => { u1.then((f) => f()); u2.then((f) => f()); u3.then((f) => f()); u4.then((f) => f()); };
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
          perch:   { anim: "stand",  loop: true,  mood: "这里视野不错", moodEmoji: "🪟" },
          bumped:  { anim: "jump",   loop: false, mood: "哇!", moodEmoji: "😮" },
          pushed:  { anim: "walk",   loop: true,  mood: "让一下~", moodEmoji: "↔" },
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

  /* ═══ Desktop World — cross-platform window surfaces + velocity ═══ */
  useEffect(() => {
    if (windowInteractionMode === "off") {
      setDesktopCapability("none");
      setPetContact("desktop");
      physicsRef.current?.setPlatforms([]);
      return;
    }

    const bridge = new DesktopWorldBridge({
      mode: windowInteractionMode,
      onSurfaces: (surfaces, meta) => {
        setDesktopCapability(meta.capability);
        physicsRef.current?.refreshPlatforms(surfaces.map((s) => ({
          id: s.id,
          x: s.x,
          y: s.y,
          width: s.width,
          height: s.height,
          source: "window" as const,
          name: s.app,
          title: s.title,
          kind: s.kind,
          focused: s.focused,
          vx: s.vx,
          vy: s.vy,
          moving: s.moving,
        })));
      },
      onError: (e) => console.warn("[Pet] desktop world sampling failed:", e),
    });
    bridge.start();
    return () => bridge.stop();
  }, [windowInteractionMode]);

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
      interactionMode: windowInteractionModeRef.current === "enhanced" ? "enhanced" : "standard",
      onStateChange: (state) => {
        arbiterRef.current?.request({ state, source: "physics" });
      },
      onFacingChange: (dir) => spineRef.current?.setFacingDirection(dir),
      onContactChange: (state) => setPetContact(state),
    });
    physics.start()
      .then(() => console.log("[Pet] roaming started"))
      .catch((e) => console.error("[Pet] roaming failed:", e));
    physicsRef.current = physics;
    return () => { physics.stop(); physicsRef.current = null; };
  }, []);

  useEffect(() => {
    physicsRef.current?.configure({
      interactionMode: windowInteractionMode === "enhanced" ? "enhanced" : "standard",
    });
  }, [windowInteractionMode]);

  /* ═══ Lock ═══ */
  useEffect(() => {
    if (locked) physicsRef.current?.stop();
    else if (petBehavior !== "sleep") physicsRef.current?.start().catch(() => {});
  }, [locked, petBehavior]);

  /* ═══════════════════════════════════════════
     DRAG — manual delta (clawd-on-desk pattern)
     P0: overrides click and roaming
     ═══════════════════════════════════════════ */
  const handlePetMouseDown = useCallback(
    async (e: React.MouseEvent) => {
      if (e.button !== 0 || locked) return;

      const win = getCurrentWindow();
      const startScreenX = e.screenX;
      const startScreenY = e.screenY;
      setDragging(true);

      // Pause physics
      physicsRef.current?.onDragStart();
      Window.getByLabel("fab-menu").then((menu) => menu?.hide().catch(() => {})).catch(() => {});

      // Snapshot window position (logical pixels)
      const scale = window.devicePixelRatio || 1;
      const pos = await win.outerPosition();
      const startWinX = pos.x / scale;
      const startWinY = pos.y / scale;
      const bounds = await invoke<{ x: number; y: number; width: number; height: number; scale: number }>("get_screen_bounds")
        .then((raw) => ({
          x: raw.x / raw.scale,
          y: raw.y / raw.scale,
          width: raw.width / raw.scale,
          height: raw.height / raw.scale,
        }))
        .catch(() => null);

      const companions: Array<{ win: Window; dx: number; dy: number }> = [];
      for (const label of ["quick", "notepad"]) {
        try {
          const companion = await Window.getByLabel(label);
          if (companion && await companion.isVisible()) {
            const companionPos = await companion.outerPosition();
            companions.push({
              win: companion,
              dx: companionPos.x / scale - startWinX,
              dy: companionPos.y / scale - startWinY,
            });
          }
        } catch {}
      }

      didDrag.current = false;

      // Track drag history for release velocity calculation
      const history: Array<{ x: number; y: number; t: number }> = [];
      let pending: { x: number; y: number } | null = null;
      let raf = 0;

      const clampDrag = (x: number, y: number) => {
        if (!bounds) return { x, y };
        const minX = bounds.x + 2;
        const minY = bounds.y + 2;
        const maxX = bounds.x + bounds.width - 200 - 2;
        const maxY = bounds.y + bounds.height - 200 - 2;
        return {
          x: Math.max(minX, Math.min(maxX, x)),
          y: Math.max(minY, Math.min(maxY, y)),
        };
      };

      const detectSnapEdge = (next: { x: number; y: number }): SnapEdge => {
        if (!bounds) return "none";
        const threshold = 18;
        const distLeft = Math.abs(next.x - (bounds.x + 2));
        const distRight = Math.abs(next.x - (bounds.x + bounds.width - 200 - 2));
        const distTop = Math.abs(next.y - (bounds.y + 2));
        const distBottom = Math.abs(next.y - (bounds.y + bounds.height - 200 - 2));
        const distances: Array<[SnapEdge, number]> = [
          ["left", distLeft],
          ["right", distRight],
          ["top", distTop],
          ["bottom", distBottom],
        ];
        const [edge, dist] = distances.sort((a, b) => a[1] - b[1])[0];
        return dist <= threshold ? edge : "none";
      };

      const flushMove = () => {
        raf = 0;
        if (!pending) return;
        const next = pending;
        pending = null;
        win.setPosition(new LogicalPosition(next.x, next.y)).catch(() => {});
        for (const companion of companions) {
          companion.win.setPosition(
            new LogicalPosition(next.x + companion.dx, next.y + companion.dy)
          ).catch(() => {});
        }
      };

      const onMove = (me: MouseEvent) => {
        if (me.buttons !== 1) return;
        const dx = me.screenX - startScreenX;
        const dy = me.screenY - startScreenY;
        if (!didDrag.current && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
          didDrag.current = true;
        }
        pending = clampDrag(startWinX + dx, startWinY + dy);
        setSnapEdge(detectSnapEdge(pending));
        if (!raf) raf = requestAnimationFrame(flushMove);
        // Record position for velocity
        history.push({ x: me.screenX, y: me.screenY, t: performance.now() });
        if (history.length > 6) history.shift();
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        if (raf) cancelAnimationFrame(raf);
        flushMove();
        setDragging(false);
        setSnapEdge("none");
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
        invoke("update_quick_panel_position").catch(() => {});
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [locked]
  );

  /* ═══ CLICK → toggle quick panel ═══ */
  const handlePetClick = useCallback(() => {
    if (didDrag.current) return;
    brainRef.current?.interact();
    emotionRef.current?.emit("user_interaction");
    invoke("toggle_quick_panel");
  }, []);

  /* ═══ RIGHT-CLICK → context menu ═══ */
  const handlePetContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    invoke("show_fab_context_menu").catch((err) => console.error("show_fab_context_menu failed:", err));
  }, []);

  /* ═══ Derived ═══ */
  const kanbanStats = useKanbanStore((s) => s.data.stats);
  const totalBadge = pendingCount + kanbanStats.active + kanbanStats.blocked;
  const sleeping = petBehavior === "sleep";
  const animatedStates = new Set(["run", "jump", "landing", "hitWall", "slide", "dizzy", "falling", "dragged", "perch", "bumped", "pushed"]);
  const visualState = animatedStates.has(physState) ? physState : sleeping ? "sleep" : petBehavior;
  const modeLabel: Record<PetMode, string> = {
    leisure: "闲逛",
    busy: "忙碌",
    anxious: "焦虑",
    alert: "提醒",
    celebrate: "庆祝",
  };
  const edgeLabel: Record<SnapEdge, string> = {
    none: "吸附",
    left: "左侧",
    right: "右侧",
    top: "顶部",
    bottom: "底部",
  };
  const contactLabel: Record<PetContactState, string> = {
    desktop: desktopCapability === "degraded" ? "降级" : "桌面",
    window: "窗口",
    pushed: "推动",
    avoiding: "避让",
  };

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
    if (physState === "bumped") return [{ emoji: "😮", text: "被窗口碰到了", key: "bumped", priority: true }];
    if (physState === "pushed") return [{ emoji: "↔", text: "让一下~", key: "pushed", priority: true }];
    if (physState === "perch" && petHovered) pool.push({ emoji: "🪟", text: "窗口上", key: "perch" });
    if (physState === "landing") return [{ emoji: "😮‍💨", text: "呼...", key: "landing", priority: true }];
    if (physState === "run") return [{ emoji: "🏃", text: "冲啊!", key: "run", priority: true }];
    if (locked) pool.push({ emoji: "🔒", text: "位置已锁定", key: "locked" });
    if (petMode === "anxious") pool.push({ emoji: "😰", text: "任务有点多...", key: "anxious" });
    if (petMode === "alert") pool.push({ emoji: "⏰", text: "有逾期任务!", key: "alert" });
    if (petMode === "celebrate") pool.push({ emoji: "🎉", text: "干得漂亮!", key: "celebrate" });
    if (totalBadge > 0) pool.push({ emoji: "📋", text: `${totalBadge}个待办`, key: "badge" });
    if (moodText) pool.push({ emoji: moodEmoji, text: moodText, key: "mood" });
    if (emotionMood && emotionMood.text !== "~") pool.push({ emoji: emotionMood.emoji, text: emotionMood.text, key: "emotion" });
    if (petBehavior === "walk" && !locked && petHovered) pool.push({ emoji: "🐾", text: "散步中~", key: "walk" });
    if (sleeping) pool.push({ emoji: "💤", text: "zzZ", key: "sleep" });
    if (connected && petHovered) pool.push({ emoji: "🔗", text: "已连接", key: "conn" });
    if (petHovered) pool.push({ emoji: "😊", text: modeLabel[petMode], key: "idle" });
    return pool;
  })();
  const currentThought = thoughtPool.length > 0 ? thoughtPool[thoughtIdx % thoughtPool.length] : null;

  return (
    <div
      className="pet-window"
      data-state={visualState}
      data-mode={petMode}
      data-dragging={dragging}
      data-window-interaction={windowInteraction}
      data-locked={locked}
      data-snap-edge={snapEdge}
    >
      <div className="pet-snap-rails" aria-hidden="true" />
      <div
        className="pet-view"
        onMouseDown={handlePetMouseDown}
        onClick={handlePetClick}
        onContextMenu={handlePetContextMenu}
        onMouseEnter={() => setPetHovered(true)}
        onMouseLeave={() => setPetHovered(false)}
        title={locked ? "位置已锁定，右键打开菜单" : `拖拽移动，点击打开快捷面板，宠物模式: ${WINDOW_INTERACTION_LABEL[windowInteractionMode]}`}
      >
        <div className="pet-anchor-halo" aria-hidden="true" />
        <div className="pet-stage" aria-hidden="true">
          <div className="pet-control-ring" />
          <div className="pet-mode-beacon" />
          <SpinePet ref={spineRef} petName={petName} width={150} height={150} />
        </div>

        <div className="pet-hud" data-expanded={petHovered || dragging || windowInteraction}>
          <div className={`hud-dot ${connected ? "connected" : "offline"}`} />
          {totalBadge > 0 && <span className="hud-count">{totalBadge > 99 ? "99+" : totalBadge}</span>}
          {locked && <IconLock size={10} className="hud-lock" />}
          {(petHovered || dragging || windowInteraction) && (
            <span className="hud-mode">{dragging ? edgeLabel[snapEdge] : windowInteraction ? contactLabel[petContact] : modeLabel[petMode]}</span>
          )}
        </div>

        {dragging && snapEdge !== "none" && (
          <div className="pet-edge-chip">{edgeLabel[snapEdge]}吸附</div>
        )}

        {/* Single thought bubble — shows current thought */}
        {currentThought && (
          <div className="thought-bubble" data-priority={currentThought.priority}>
            {currentThought.text}
          </div>
        )}
      </div>
    </div>
  );
}

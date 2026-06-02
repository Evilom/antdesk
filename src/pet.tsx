import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow, Window } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { useEffect, useState, useCallback, useRef } from "react";
import SpinePet, { type SpinePetHandle } from "./components/SpinePet";
import { PhysicsEngine } from "./lib/PhysicsEngine";
import { PetBrain, MODE_PHYSICS, type PetMode, type BehaviorState } from "./lib/PetBrain";
import { KanbanBridge } from "./lib/kanbanBridge";
import { useKanbanStore } from "./stores/kanbanStore";
import type { KanbanData } from "./types/kanban";

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
  const [petName] = useState("moshumao");
  const [petBehavior, setPetBehavior] = useState<BehaviorState>("idle");
  const [petMode, setPetMode] = useState<PetMode>("leisure");
  const [moodText, setMoodText] = useState("");
  const [moodEmoji, setMoodEmoji] = useState("😊");
  const [pendingCount, setPendingCount] = useState(0);
  const [notifyMsg, setNotifyMsg] = useState<string | null>(null);

  const didDrag = useRef(false);
  const spineRef = useRef<SpinePetHandle>(null);
  const physicsRef = useRef<PhysicsEngine | null>(null);
  const brainRef = useRef<PetBrain | null>(null);
  const lockedRef = useRef(false);
  const notifyTimer = useRef<ReturnType<typeof setTimeout>>(null);

  const setKanbanData = useKanbanStore((s) => s.setData);
  const setKanbanConnected = useKanbanStore((s) => s.setConnected);
  const setKanbanError = useKanbanStore((s) => s.setError);
  const kanbanEndpoint = useKanbanStore((s) => s.endpoint);

  useEffect(() => { lockedRef.current = locked; }, [locked]);

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

  /* ═══ PetBrain ═══ */
  useEffect(() => {
    const brain = new PetBrain({
      onBehaviorChange: (state, anim) => {
        setPetBehavior(state);
        setMoodEmoji(BEHAVIOR_EMOJI[state] || "😊");
        spineRef.current?.setAnimation(anim, state !== "interact");
        if (state === "sleep") physicsRef.current?.stop();
        else if (state === "walk" && !lockedRef.current) physicsRef.current?.start();
      },
      onModeChange: (mode) => {
        setPetMode(mode);
        physicsRef.current?.configure(MODE_PHYSICS[mode]);
      },
      onMoodChange: (mood) => setMoodText(mood),
      onNotify: (msg) => {
        setNotifyMsg(msg);
        if (notifyTimer.current) clearTimeout(notifyTimer.current);
        notifyTimer.current = setTimeout(() => setNotifyMsg(null), 6000);
      },
      onKanbanEvent: (_e, detail) => {
        setNotifyMsg(detail);
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
      walkSpeed: 35, idleProbability: 0.3, mouseAttraction: 0.1,
      onStateChange: (state) => {
        const b = brainRef.current?.getBehavior();
        if (b === "idle" || b === "walk") {
          spineRef.current?.setAnimation(state === "walk" ? "walk" : "stand", true);
        }
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
      };

      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        physicsRef.current?.onDragEnd();
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

  return (
    <div
      className="pet-window"
      data-state={sleeping ? "sleep" : petBehavior}
      data-mode={petMode}
    >
      <div
        className="pet-view"
        onMouseDown={handlePetMouseDown}
        onClick={handlePetClick}
        onContextMenu={handlePetContextMenu}
      >
        <SpinePet ref={spineRef} petName={petName} width={150} height={150} />

        <span className={`dot ${connected ? "on" : "off"}`} />
        {totalBadge > 0 && (
          <span className="badge">{totalBadge > 99 ? "99+" : totalBadge}</span>
        )}
        {petBehavior === "walk" && !locked && <span className="state-icon">🚶</span>}
        {sleeping && <span className="state-icon">💤</span>}

        {moodText && (
          <div className="mood">
            <span className="mood-e">{moodEmoji}</span>{moodText}
          </div>
        )}

        {notifyMsg && (
          <div className="notify" onClick={() => setNotifyMsg(null)}>
            ⚠️ {notifyMsg}
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
          <div className="menu-item quit" onClick={() => invoke("quit_app")}>
            🚪 退出
          </div>
        </div>
      )}
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
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

type OverlayMode = "pet" | "bubble" | "menu";

export default function Pet() {
  const [connected, setConnected] = useState(false);
  const [overlay, setOverlay] = useState<OverlayMode>("pet");
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

  /* ═══════════════════════════════════════
     Init: Notion connectivity + pending count
     ═══════════════════════════════════════ */
  useEffect(() => {
    invoke<string>("get_notion_token").then(() => setConnected(true)).catch(() => {});
    invoke<number>("get_pending_count").then(setPendingCount).catch(() => {});
    const t = setInterval(() => {
      invoke<number>("get_pending_count").then(setPendingCount).catch(() => {});
    }, 60_000);
    return () => clearInterval(t);
  }, []);

  /* ═══════════════════════════════════════
     Listen for native menu events
     ═══════════════════════════════════════ */
  useEffect(() => {
    const u1 = listen("toggle-lock", () => setLocked((v) => !v));
    const u2 = listen("toggle-bubble", () =>
      setOverlay((v) => (v === "bubble" ? "pet" : "bubble"))
    );
    return () => { u1.then((f) => f()); u2.then((f) => f()); };
  }, []);

  /* ═══════════════════════════════════════
     KanbanBridge (remote Hermes data)
     ═══════════════════════════════════════ */
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

  /* ═══════════════════════════════════════
     PetBrain (behavior state machine)
     ═══════════════════════════════════════ */
  useEffect(() => {
    const brain = new PetBrain({
      onBehaviorChange: (state, anim) => {
        setPetBehavior(state);
        setMoodEmoji(BEHAVIOR_EMOJI[state] || "😊");
        spineRef.current?.setAnimation(anim, state !== "interact");
        if (state === "sleep") physicsRef.current?.stop();
        else if (state === "walk" && !lockedRef.current)
          physicsRef.current?.start();
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

  /* ═══════════════════════════════════════
     PhysicsEngine (desktop roaming)
     ═══════════════════════════════════════ */
  useEffect(() => {
    const physics = new PhysicsEngine({
      windowWidth: 200,
      windowHeight: 200,
      walkSpeed: 35,
      idleProbability: 0.3,
      mouseAttraction: 0.1,
      onStateChange: (state) => {
        const b = brainRef.current?.getBehavior();
        if (b === "idle" || b === "walk") {
          spineRef.current?.setAnimation(
            state === "walk" ? "walk" : "stand",
            true
          );
        }
      },
      onFacingChange: (dir) => spineRef.current?.setFacingDirection(dir),
    });
    physics
      .start()
      .then(() => console.log("[Pet] roaming started"))
      .catch((e) => console.error("[Pet] roaming failed:", e));
    physicsRef.current = physics;
    return () => { physics.stop(); physicsRef.current = null; };
  }, []);

  /* ═══════════════════════════════════════
     Lock toggle → stop/start roaming
     ═══════════════════════════════════════ */
  useEffect(() => {
    if (locked) physicsRef.current?.stop();
    else if (petBehavior !== "sleep")
      physicsRef.current?.start().catch(() => {});
  }, [locked, petBehavior]);

  /* ═══════════════════════════════════════
     Drag: mousedown → 4px threshold → startDragging
     ═══════════════════════════════════════ */
  const handlePetMouseDown = useCallback(
    (e: React.MouseEvent) => {
      // Only drag from pet state, left button, not locked
      if (e.button !== 0 || locked || overlay !== "pet") return;
      didDrag.current = false;
      const sx = e.screenX;
      const sy = e.screenY;

      const onMove = (me: MouseEvent) => {
        if (me.buttons !== 1) return;
        const dx = Math.abs(me.screenX - sx);
        const dy = Math.abs(me.screenY - sy);
        if (!didDrag.current && (dx > 4 || dy > 4)) {
          didDrag.current = true;
          cleanup();
          physicsRef.current?.stop();
          getCurrentWindow()
            .startDragging()
            .then(() => {
              if (!lockedRef.current) physicsRef.current?.start();
            })
            .catch(console.warn);
        }
      };

      const onUp = () => cleanup();

      const cleanup = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };

      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [locked, overlay]
  );

  /* ═══════════════════════════════════════
     Click: pet → bubble, menu click-outside → close
     ═══════════════════════════════════════ */
  const handlePetClick = useCallback(() => {
    if (didDrag.current) return;
    // If menu is showing, click on exposed pet-view area closes it
    if (overlay === "menu") {
      setOverlay("pet");
      return;
    }
    // Normal pet click → open bubble
    if (overlay === "pet") {
      brainRef.current?.interact();
      setOverlay("bubble");
    }
  }, [overlay]);

  /* ═══════════════════════════════════════
     Right-click → context menu
     ═══════════════════════════════════════ */
  const handlePetContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (overlay === "pet") setOverlay("menu");
    },
    [overlay]
  );

  /* ═══════════════════════════════════════
     Derived data for bubble
     ═══════════════════════════════════════ */
  const kanbanStats = useKanbanStore((s) => s.data.stats);
  const kanbanActions = useKanbanStore((s) => s.data.actions);
  const todos = (() => {
    try {
      return JSON.parse(localStorage.getItem("antdesk_todos") || "[]");
    } catch {
      return [];
    }
  })();
  const pendingTodos = todos.filter((t: any) => !t.status);
  const activeKanban = kanbanActions.filter((a) => a.status === "active");

  const totalBadge = pendingCount + kanbanStats.active + kanbanStats.blocked;
  const sleeping = petBehavior === "sleep";

  /* ═══════════════════════════════════════
     Render
     ═══════════════════════════════════════ */
  return (
    <div
      className="pet-window"
      data-state={sleeping ? "sleep" : petBehavior}
      data-mode={petMode}
    >
      {/* ── Pet view: ALWAYS rendered (Spine + indicators) ── */}
      <div
        className="pet-view"
        onMouseDown={handlePetMouseDown}
        onClick={handlePetClick}
        onContextMenu={handlePetContextMenu}
      >
        <SpinePet ref={spineRef} petName={petName} width={150} height={150} />

        <span className={`dot ${connected ? "on" : "off"}`} />
        {totalBadge > 0 && (
          <span className="badge">
            {totalBadge > 99 ? "99+" : totalBadge}
          </span>
        )}
        {petBehavior === "walk" && !locked && (
          <span className="state-icon">🚶</span>
        )}
        {sleeping && <span className="state-icon">💤</span>}

        {moodText && (
          <div className="mood">
            <span className="mood-e">{moodEmoji}</span>
            {moodText}
          </div>
        )}

        {notifyMsg && (
          <div className="notify" onClick={() => setNotifyMsg(null)}>
            ⚠️ {notifyMsg}
          </div>
        )}
      </div>

      {/* ── Bubble overlay (compact, inside 200×200) ── */}
      {overlay === "bubble" && (
        <div className="bubble">
          <div className="bubble-header">
            <span>⚡ 快捷</span>
            <button
              className="bubble-close"
              onClick={() => setOverlay("pet")}
            >
              ✕
            </button>
          </div>
          <div className="bubble-scroll">
            {pendingTodos.length > 0 && (
              <div className="bubble-section">
                <div className="bubble-label">
                  📋 待办 ({pendingTodos.length})
                </div>
                {pendingTodos.slice(0, 5).map((t: any) => (
                  <div key={t.id} className="bubble-row">
                    <span
                      className="bubble-dot"
                      style={{
                        background:
                          t.priority === "High"
                            ? "#ff6b6b"
                            : t.priority === "Medium"
                            ? "#ffeaa7"
                            : "#55efc4",
                      }}
                    />
                    <span className="bubble-name">{t.name}</span>
                  </div>
                ))}
              </div>
            )}
            {activeKanban.length > 0 && (
              <div className="bubble-section">
                <div className="bubble-label">
                  📊 进行中 ({activeKanban.length})
                </div>
                {activeKanban.slice(0, 3).map((a) => (
                  <div key={a.id} className="bubble-row">
                    <span
                      className="bubble-dot"
                      style={{ background: "#74b9ff" }}
                    />
                    <span className="bubble-name">{a.title}</span>
                  </div>
                ))}
              </div>
            )}
            {pendingTodos.length === 0 && activeKanban.length === 0 && (
              <div className="bubble-empty">✨ 暂无待办</div>
            )}
          </div>
          <div className="bubble-actions">
            <button
              onClick={() => {
                setOverlay("pet");
                invoke("expand_panel");
              }}
            >
              📋
            </button>
            <button
              onClick={() => {
                setOverlay("pet");
                invoke("toggle_notepad");
              }}
            >
              📝
            </button>
            <button onClick={() => setLocked((v) => !v)}>
              {locked ? "🔓" : "🔒"}
            </button>
            <button onClick={() => invoke("hide_pet")}>👁️</button>
          </div>
        </div>
      )}

      {/* ── Context menu (centered overlay, inside 200×200) ── */}
      {overlay === "menu" && (
        <div className="menu">
          <div
            className="menu-item"
            onClick={() => {
              setOverlay("pet");
              invoke("expand_panel");
            }}
          >
            📋 主面板
          </div>
          <div className="menu-item" onClick={() => setOverlay("bubble")}>
            💬 快捷面板
          </div>
          <div
            className="menu-item"
            onClick={() => {
              setOverlay("pet");
              invoke("toggle_notepad");
            }}
          >
            📝 便签
          </div>
          <div className="menu-sep" />
          <div className="menu-item" onClick={() => setLocked((v) => !v)}>
            {locked ? "🔓 解锁位置" : "🔒 锁定位置"}
          </div>
          <div
            className="menu-item"
            onClick={() => {
              setOverlay("pet");
              invoke("hide_pet");
            }}
          >
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

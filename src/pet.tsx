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

export default function Pet() {
  const [connected, setConnected] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [locked, setLocked] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showMood, setShowMood] = useState(false);
  const [moodText, setMoodText] = useState("");
  const [moodEmoji, setMoodEmoji] = useState("😊");
  const [petName, setPetName] = useState("moshumao");
  const [petBehavior, setPetBehavior] = useState<BehaviorState>("idle");
  const [petMode, setPetMode] = useState<PetMode>("leisure");
  const [notifyMsg, setNotifyMsg] = useState<string | null>(null);
  const [showBubble, setShowBubble] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const didDrag = useRef(false);
  const spineRef = useRef<SpinePetHandle>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const physicsRef = useRef<PhysicsEngine | null>(null);
  const brainRef = useRef<PetBrain | null>(null);
  const notifyTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const isHovering = useRef(false);
  const lockedRef = useRef(false);

  const setKanbanData = useKanbanStore((s) => s.setData);
  const setKanbanConnected = useKanbanStore((s) => s.setConnected);
  const setKanbanError = useKanbanStore((s) => s.setError);
  const kanbanEndpoint = useKanbanStore((s) => s.endpoint);

  useEffect(() => { lockedRef.current = locked; }, [locked]);

  // ── Notion connection ──
  useEffect(() => {
    invoke<string>("get_notion_token").then(() => setConnected(true)).catch(() => {});
  }, []);

  // ── Pending count ──
  useEffect(() => {
    const f = () => { invoke<number>("get_pending_count").then(setPendingCount).catch(() => {}); };
    f();
    const t = setInterval(f, 30_000);
    return () => clearInterval(t);
  }, []);

  // ── KanbanBridge ──
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

  // ── PetBrain ──
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

  // ── PhysicsEngine — direct start, no setIgnoreCursorEvents ──
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
          spineRef.current?.setAnimation(state === "walk" ? "walk" : "stand", true);
        }
      },
      onFacingChange: (dir) => {
        if (!isHovering.current) spineRef.current?.setFacingDirection(dir);
      },
    });

    physics.start().catch((e) => console.warn("[Pet] PhysicsEngine start failed:", e));
    physicsRef.current = physics;
    return () => { physics.stop(); physicsRef.current = null; };
  }, []);

  // ── Lock stops/resumes roaming ──
  useEffect(() => {
    if (locked) physicsRef.current?.stop();
    else if (petBehavior !== "sleep") physicsRef.current?.start();
  }, [locked]);

  // ── Drag — simple, no setIgnoreCursorEvents ──
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return; // left button only
    didDrag.current = false;
    const startX = e.screenX;
    const startY = e.screenY;
    setIsDragging(false);

    const onMove = (me: MouseEvent) => {
      if (Math.abs(me.screenX - startX) > 4 || Math.abs(me.screenY - startY) > 4) {
        didDrag.current = true;
        setIsDragging(true);
        setShowBubble(false);
        setShowMenu(false);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        getCurrentWindow().startDragging();
      }
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      setTimeout(() => setIsDragging(false), 100);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  const handleMouseEnter = useCallback(() => {
    isHovering.current = true;
    hoverTimer.current = setTimeout(() => setShowMood(true), 1000);
  }, []);

  const handleMouseLeave = useCallback(() => {
    isHovering.current = false;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setShowMood(false);
  }, []);

  // ── Click → toggle bubble menu ──
  const handleClick = useCallback(() => {
    if (didDrag.current) return;
    brainRef.current?.interact();
    setShowBubble((v) => !v);
    setShowMenu(false);
  }, []);

  // ── Right-click → context menu ──
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setShowMenu(true);
    setMenuPos({ x: e.clientX, y: e.clientY });
    setShowBubble(false);
  }, []);

  // ── Close menus on outside click ──
  useEffect(() => {
    if (!showBubble && !showMenu) return;
    const close = (e: MouseEvent) => {
      // Check if click is outside pet-area
      const target = e.target as HTMLElement;
      if (!target.closest(".pet-area") && !target.closest(".bubble-menu") && !target.closest(".pet-menu")) {
        setShowBubble(false);
        setShowMenu(false);
      }
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [showBubble, showMenu]);

  // ── Menu actions ──
  const handleShowPanel = useCallback(async () => {
    setShowMenu(false);
    try { await invoke("expand_panel"); } catch {}
  }, []);

  const handleHidePet = useCallback(async () => {
    setShowMenu(false);
    try { await invoke("hide_pet"); } catch {}
  }, []);

  const handleQuit = useCallback(() => {
    setShowMenu(false);
    invoke("quit_app");
  }, []);

  const toggleLock = useCallback(() => {
    setShowMenu(false);
    setLocked((v) => !v);
  }, []);

  const switchPet = useCallback((name: string) => {
    setShowMenu(false);
    setPetName(name);
    localStorage.setItem("pet-name", name);
  }, []);

  // Derived
  const kanbanStats = useKanbanStore((s) => s.data.stats);
  const kanbanActions = useKanbanStore((s) => s.data.actions);
  const kanbanBadge = kanbanStats.active + kanbanStats.blocked;
  const totalBadge = pendingCount + kanbanBadge;
  const sleeping = petBehavior === "sleep";
  const stateEmoji = sleeping ? "💤" : petBehavior === "walk" ? "🚶" : petBehavior === "interact" ? "💬" : "";

  // Quick items for bubble
  const todos = (() => {
    try { return JSON.parse(localStorage.getItem("antdesk_todos") || "[]"); } catch { return []; }
  })();
  const pendingTodos = todos.filter((t: any) => !t.status).slice(0, 5);
  const activeKanban = kanbanActions.filter((a) => a.status === "active").slice(0, 3);

  return (
    <div className="pet-root" data-state={sleeping ? "sleep" : petBehavior} data-mode={petMode}>
      {/* ── Pet area — all events here ── */}
      <div className="pet-area"
        onMouseDown={handleMouseDown}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <SpinePet ref={spineRef} petName={petName} width={160} height={160} />

        {/* Floating indicators */}
        <span className={`pet-dot ${connected ? "on" : "off"}`} />
        {stateEmoji && <div className="pet-state">{stateEmoji}</div>}
        {totalBadge > 0 && <div className="pet-badge">{totalBadge > 99 ? "99+" : totalBadge}</div>}

        {/* Mood bubble */}
        {showMood && !isDragging && (
          <div className="pet-mood">
            <span className="mood-emoji">{moodEmoji}</span> {moodText || "(^・ω・^)"}
          </div>
        )}
      </div>

      {/* ── Bubble menu — simple list attached to pet ── */}
      {showBubble && (
        <div className="bubble-menu">
          {/* Notion todos */}
          {pendingTodos.length > 0 && (
            <div className="bubble-section">
              <div className="bubble-header">📋 待办 ({pendingCount})</div>
              {pendingTodos.map((t: any) => (
                <div key={t.id} className="bubble-item">
                  <span className="bubble-dot" style={{ background: t.priority === "High" ? "#ff6b6b" : t.priority === "Medium" ? "#ffeaa7" : "#55efc4" }} />
                  <span className="bubble-text">{t.name}</span>
                </div>
              ))}
            </div>
          )}

          {/* Kanban active */}
          {activeKanban.length > 0 && (
            <div className="bubble-section">
              <div className="bubble-header">📊 进行中 ({kanbanStats.active})</div>
              {activeKanban.map((a) => (
                <div key={a.id} className="bubble-item">
                  <span className="bubble-priority" style={{ background: a.priority >= 7 ? "#ff6b6b" : "#74b9ff" }}>P{a.priority}</span>
                  <span className="bubble-text">{a.title}</span>
                </div>
              ))}
            </div>
          )}

          {/* Quick actions */}
          <div className="bubble-actions">
            <button className="bubble-action" onClick={() => { setShowBubble(false); invoke("expand_panel"); }}>
              📋 主面板
            </button>
            <button className="bubble-action" onClick={() => { setShowBubble(false); invoke("toggle_notepad"); }}>
              📝 便签
            </button>
          </div>

          {/* Empty state */}
          {pendingTodos.length === 0 && activeKanban.length === 0 && (
            <div className="bubble-empty">✨ 暂无待办</div>
          )}
        </div>
      )}

      {/* ── Context menu ── */}
      {showMenu && (
        <div className="pet-menu" style={{ left: menuPos.x, top: menuPos.y }} onClick={(e) => e.stopPropagation()}>
          <div className="pet-menu-item" onClick={handleShowPanel}>📋 主面板</div>
          <div className="pet-menu-item" onClick={() => { setShowMenu(false); setShowBubble((v) => !v); }}>💬 快捷面板</div>
          <div className="pet-menu-item" onClick={() => { setShowMenu(false); invoke("toggle_notepad"); }}>📝 便签</div>
          <div className="pet-menu-sep" />
          <div className="pet-menu-item" onClick={() => switchPet("moshumao")}>
            🐱 墨鼠猫 {petName === "moshumao" && "✓"}
          </div>
          <div className="pet-menu-sep" />
          <div className="pet-menu-item" onClick={toggleLock}>
            {locked ? "🔓 解锁位置" : "🔒 锁定位置"}
          </div>
          <div className="pet-menu-item" onClick={handleHidePet}>👁️ 隐藏宠物</div>
          <div className="pet-menu-sep" />
          <div className="pet-menu-item" onClick={handleQuit}>🚪 退出</div>
        </div>
      )}

      {/* ── Notification ── */}
      {notifyMsg && (
        <div className="pet-notify" onClick={() => setNotifyMsg(null)}>⚠️ {notifyMsg}</div>
      )}
    </div>
  );
}

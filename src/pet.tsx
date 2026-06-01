import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  currentMonitor,
} from "@tauri-apps/api/window";
import { useEffect, useState, useCallback, useRef } from "react";
import SpinePet, { type SpinePetHandle } from "./components/SpinePet";
import QuickChat from "./components/QuickChat";
import { PhysicsEngine } from "./lib/PhysicsEngine";
import {
  PetBrain,
  MODE_PHYSICS,
  type PetMode,
  type BehaviorState,
} from "./lib/PetBrain";
import { KanbanBridge } from "./lib/kanbanBridge";
import { useKanbanStore } from "./stores/kanbanStore";
import type { KanbanData } from "./types/kanban";

type PetSize = "tiny" | "small" | "medium" | "large";

const SIZES: Record<PetSize, { w: number; h: number }> = {
  tiny: { w: 120, h: 120 },
  small: { w: 200, h: 200 },
  medium: { w: 260, h: 260 },
  large: { w: 360, h: 360 },
};

const BEHAVIOR_EMOJI: Record<BehaviorState, string> = {
  idle: "😊",
  walk: "🚶",
  interact: "😄",
  sleep: "😴",
};

export default function Pet() {
  const [connected, setConnected] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [menuPos, setMenuPos] = useState({ x: 0, y: 0 });
  const [size] = useState<PetSize>("medium");
  const [locked, setLocked] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showMood, setShowMood] = useState(false);
  const [moodText, setMoodText] = useState("");
  const [moodEmoji, setMoodEmoji] = useState("😊");
  const [petName, setPetName] = useState("moshumao");
  const [petBehavior, setPetBehavior] = useState<BehaviorState>("idle");
  const [petMode, setPetMode] = useState<PetMode>("leisure");
  const [notifyMsg, setNotifyMsg] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const didDrag = useRef(false);
  const spineRef = useRef<SpinePetHandle>(null);
  const petBodyRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const physicsRef = useRef<PhysicsEngine | null>(null);
  const brainRef = useRef<PetBrain | null>(null);
  const kanbanBridgeRef = useRef<KanbanBridge | null>(null);
  const notifyTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const isHovering = useRef(false);
  const lockedRef = useRef(false);

  const setKanbanData = useKanbanStore((s) => s.setData);
  const setKanbanConnected = useKanbanStore((s) => s.setConnected);
  const setKanbanError = useKanbanStore((s) => s.setError);
  const kanbanEndpoint = useKanbanStore((s) => s.endpoint);

  useEffect(() => { lockedRef.current = locked; }, [locked]);

  // Check Notion connection
  useEffect(() => {
    invoke<string>("get_notion_token")
      .then(() => setConnected(true))
      .catch(() => setConnected(false));
  }, []);

  // Poll pending count for badge
  useEffect(() => {
    const fetch = () => {
      invoke<number>("get_pending_count").then(setPendingCount).catch(() => {});
    };
    fetch();
    const t = setInterval(fetch, 30_000);
    return () => clearInterval(t);
  }, []);

  // Listen for expand/collapse from Rust
  useEffect(() => {
    const unlisten = listen<boolean>("pet-expanded", (e) => {
      setExpanded(e.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
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
    kanbanBridgeRef.current = bridge;
    return () => { bridge.dispose(); kanbanBridgeRef.current = null; };
  }, [kanbanEndpoint, setKanbanData, setKanbanConnected, setKanbanError]);

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
      onKanbanEvent: (_event, detail) => {
        setNotifyMsg(detail);
        if (notifyTimer.current) clearTimeout(notifyTimer.current);
        notifyTimer.current = setTimeout(() => setNotifyMsg(null), 8000);
      },
    });
    brain.start();
    brainRef.current = brain;
    return () => { brain.dispose(); brainRef.current = null; };
  }, []);

  // ── PhysicsEngine ──
  useEffect(() => {
    const physics = new PhysicsEngine({
      windowWidth: SIZES[size].w,
      windowHeight: SIZES[size].h,
      walkSpeed: 40,
      idleProbability: 0.3,
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
    physics.start();
    physicsRef.current = physics;
    return () => { physics.stop(); physicsRef.current = null; };
  }, [size]);

  // Pause physics when expanded
  useEffect(() => {
    if (expanded) {
      physicsRef.current?.stop();
    } else if (petBehavior !== "sleep") {
      physicsRef.current?.start();
    }
  }, [expanded, petBehavior]);

  // ── Drag (only when collapsed) ──
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (expanded) return;
      didDrag.current = false;
      const startX = e.screenX;
      const startY = e.screenY;
      setIsDragging(false);

      const onMove = (me: MouseEvent) => {
        if (Math.abs(me.screenX - startX) > 5 || Math.abs(me.screenY - startY) > 5) {
          didDrag.current = true;
          setIsDragging(true);
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
    },
    [expanded]
  );

  // ── Hover → mood ──
  const handleMouseEnter = useCallback(() => {
    isHovering.current = true;
    hoverTimer.current = setTimeout(() => setShowMood(true), 800);
  }, []);

  const handleMouseLeave = useCallback(() => {
    isHovering.current = false;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setShowMood(false);
  }, []);

  // ── Click → toggle expand ──
  const handleClick = useCallback(() => {
    if (didDrag.current) return;
    brainRef.current?.interact();
    if (expanded) {
      invoke("pet_collapse").catch(() => {});
      setExpanded(false);
    } else {
      invoke("pet_expand").catch(() => {});
      setExpanded(true);
    }
  }, [expanded]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setShowMenu(true);
    setMenuPos({ x: e.clientX, y: e.clientY });
  }, []);

  // ── Context menu actions ──
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
    invoke("quit_app").catch(() => {});
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

  const closeQuickChat = useCallback(() => {
    invoke("pet_collapse").catch(() => {});
    setExpanded(false);
  }, []);

  // Derived state
  const kanbanStats = useKanbanStore((s) => s.data.stats);
  const kanbanBadge = kanbanStats.active + kanbanStats.blocked;
  const totalBadge = pendingCount + kanbanBadge;
  const sleeping = petBehavior === "sleep";
  const stateLabel = sleeping ? "💤" : petBehavior === "walk" ? "🚶" : petBehavior === "interact" ? "💬" : "";

  return (
    <div
      className={`pet-root ${expanded ? "expanded" : "collapsed"}`}
      data-size={size}
      data-state={sleeping ? "sleep" : petBehavior}
      data-mode={petMode}
    >
      {/* ── Pet body (always visible, left side) ── */}
      <div
        ref={petBodyRef}
        className={`pet-body ${isDragging ? "dragging" : ""} ${sleeping ? "sleeping" : ""} mode-${petMode}`}
        onMouseDown={handleMouseDown}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
      >
        <span className={`pet-status ${connected ? "connected" : "disconnected"}`} />

        <SpinePet
          ref={spineRef}
          petName={petName}
          width={SIZES[size].w * 0.65}
          height={SIZES[size].h * 0.65}
        />

        {stateLabel && <div className="pet-state-label">{stateLabel}</div>}

        {showMood && !isDragging && !expanded && (
          <div className="pet-mood-bubble">
            <span className="mood-emoji">{moodEmoji}</span> {moodText || "(^・ω・^)"}
          </div>
        )}

        {locked && <div className="pet-lock-badge">🔒</div>}

        {/* Badge */}
        {totalBadge > 0 && !expanded && (
          <div className="pet-badge">{totalBadge > 99 ? "99+" : totalBadge}</div>
        )}
      </div>

      {/* ── QuickChat panel (slides out to the right) ── */}
      <QuickChat open={expanded} onClose={closeQuickChat} />

      {/* ── Notification ── */}
      {notifyMsg && (
        <div className="pet-notify" onClick={() => setNotifyMsg(null)}>
          <span>⚠️</span> <span>{notifyMsg}</span>
        </div>
      )}

      {/* ── Context menu ── */}
      {showMenu && (
        <div
          className="pet-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="pet-menu-item" onClick={handleShowPanel}>
            <span className="emoji">📋</span> 主面板
          </div>
          <div className="pet-menu-item" onClick={() => { setShowMenu(false); if (expanded) closeQuickChat(); else { invoke("pet_expand"); setExpanded(true); } }}>
            <span className="emoji">💬</span> {expanded ? "关闭面板" : "快捷面板"}
          </div>
          <div className="pet-menu-sep" />
          <div className="pet-menu-item" onClick={() => switchPet("moshumao")}>
            <span className="emoji">🐱</span> 墨鼠猫
            {petName === "moshumao" && <span className="check">✓</span>}
          </div>
          <div className="pet-menu-sep" />
          <div className="pet-menu-item" onClick={toggleLock}>
            <span className="emoji">{locked ? "🔓" : "🔒"}</span> {locked ? "解锁位置" : "锁定位置"}
          </div>
          <div className="pet-menu-sep" />
          <div className="pet-menu-item" onClick={handleHidePet}>
            <span className="emoji">👁️</span> 隐藏
          </div>
          <div className="pet-menu-item" onClick={handleQuit}>
            <span className="emoji">🚪</span> 退出
          </div>
        </div>
      )}
    </div>
  );
}

import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  currentMonitor,
  LogicalSize,
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

// Expanded size when QuickChat is open (pet + panel side by side)
const EXPANDED_WIDTH = 560;

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
  const [size, setSize] = useState<PetSize>("medium");
  const [locked, setLocked] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [showMood, setShowMood] = useState(false);
  const [moodText, setMoodText] = useState("");
  const [moodEmoji, setMoodEmoji] = useState("😊");
  const [petName, setPetName] = useState("moshumao");
  const [petBehavior, setPetBehavior] = useState<BehaviorState>("idle");
  const [petMode, setPetMode] = useState<PetMode>("leisure");
  const [notifyMsg, setNotifyMsg] = useState<string | null>(null);
  const [quickChatOpen, setQuickChatOpen] = useState(false);

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

  // Kanban store
  const setKanbanData = useKanbanStore((s) => s.setData);
  const setKanbanConnected = useKanbanStore((s) => s.setConnected);
  const setKanbanError = useKanbanStore((s) => s.setError);
  const kanbanEndpoint = useKanbanStore((s) => s.endpoint);

  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  // Check connection
  useEffect(() => {
    invoke<string>("get_notion_token")
      .then(() => setConnected(true))
      .catch(() => setConnected(false));
  }, []);

  // Load saved preferences
  useEffect(() => {
    const savedSize = localStorage.getItem("pet-size") as PetSize | null;
    if (savedSize && SIZES[savedSize]) setSize(savedSize);
    const savedLocked = localStorage.getItem("pet-locked");
    if (savedLocked === "true") setLocked(true);
    const savedPet = localStorage.getItem("pet-name");
    if (savedPet) setPetName(savedPet);
  }, []);

  // ── Initialize KanbanBridge ──
  useEffect(() => {
    const bridge = new KanbanBridge({
      endpoint: kanbanEndpoint || undefined,
      onData: (data: KanbanData) => {
        setKanbanData(data);
        setKanbanConnected(true);
        // Feed to PetBrain
        brainRef.current?.updateKanban(data);
      },
      onError: (err) => {
        setKanbanError(err);
      },
    });

    bridge.start();
    kanbanBridgeRef.current = bridge;

    return () => {
      bridge.dispose();
      kanbanBridgeRef.current = null;
    };
  }, [kanbanEndpoint, setKanbanData, setKanbanConnected, setKanbanError]);

  // ── Initialize PetBrain ──
  useEffect(() => {
    const brain = new PetBrain({
      onBehaviorChange: (state, anim) => {
        setPetBehavior(state);
        setMoodEmoji(BEHAVIOR_EMOJI[state] || "😊");

        const isLoop = state !== "interact";
        spineRef.current?.setAnimation(anim, isLoop);

        if (state === "sleep") {
          physicsRef.current?.stop();
        } else if (state === "walk") {
          if (!lockedRef.current) {
            physicsRef.current?.start();
          }
        }
      },
      onModeChange: (mode) => {
        setPetMode(mode);
        const params = MODE_PHYSICS[mode];
        physicsRef.current?.configure(params);
      },
      onMoodChange: (mood) => setMoodText(mood),
      onNotify: (message) => {
        setNotifyMsg(message);
        if (notifyTimer.current) clearTimeout(notifyTimer.current);
        notifyTimer.current = setTimeout(() => setNotifyMsg(null), 6000);
      },
      onKanbanEvent: (event, detail) => {
        // Show kanban event as notification
        setNotifyMsg(detail);
        if (notifyTimer.current) clearTimeout(notifyTimer.current);
        notifyTimer.current = setTimeout(() => setNotifyMsg(null), 8000);
      },
    });

    brain.start();
    brainRef.current = brain;

    return () => {
      brain.dispose();
      brainRef.current = null;
    };
  }, []);

  // ── Initialize PhysicsEngine ──
  useEffect(() => {
    const physics = new PhysicsEngine({
      windowWidth: SIZES.medium.w,
      windowHeight: SIZES.medium.h,
      walkSpeed: 40,
      idleProbability: 0.3,
      onStateChange: (state) => {
        const brainBehavior = brainRef.current?.getBehavior();
        if (brainBehavior === "idle" || brainBehavior === "walk") {
          if (state === "walk") {
            spineRef.current?.setAnimation("walk", true);
          } else if (state === "idle") {
            spineRef.current?.setAnimation("stand", true);
          }
        }
      },
      onFacingChange: (dir) => {
        if (!isHovering.current) {
          spineRef.current?.setFacingDirection(dir);
        }
      },
    });

    physics.start();
    physicsRef.current = physics;

    return () => {
      physics.stop();
      physicsRef.current = null;
    };
  }, []);

  // ── Window resize for QuickChat ──
  const resizeWindow = useCallback(async (expanded: boolean) => {
    try {
      const win = getCurrentWindow();
      const monitor = await currentMonitor();
      const scale = monitor?.scaleFactor || 1;
      const baseW = SIZES[size].w;

      if (expanded) {
        await win.setSize(new LogicalSize(EXPANDED_WIDTH, SIZES[size].h));
      } else {
        await win.setSize(new LogicalSize(baseW, SIZES[size].h));
      }
    } catch (e) {
      console.warn("[Pet] resize failed:", e);
    }
  }, [size]);

  const toggleQuickChat = useCallback(() => {
    setQuickChatOpen((prev) => {
      const next = !prev;
      resizeWindow(next);
      return next;
    });
  }, [resizeWindow]);

  // ── Drag handling ──
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (quickChatOpen) return; // Don't drag when panel is open
      didDrag.current = false;
      const startX = e.screenX;
      const startY = e.screenY;
      setIsDragging(false);

      const onMouseMove = (me: MouseEvent) => {
        if (
          Math.abs(me.screenX - startX) > 5 ||
          Math.abs(me.screenY - startY) > 5
        ) {
          didDrag.current = true;
          setIsDragging(true);
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          getCurrentWindow().startDragging();
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
        setTimeout(() => setIsDragging(false), 100);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [quickChatOpen]
  );

  const handleMouseMove = useCallback(() => {
    if (lockedRef.current || quickChatOpen) return;
  }, [quickChatOpen]);

  // ── Hover → mood bubble ──
  const handleMouseEnter = useCallback(() => {
    isHovering.current = true;
    hoverTimer.current = setTimeout(() => {
      setShowMood(true);
    }, 800);
  }, []);

  const handleMouseLeave = useCallback(() => {
    isHovering.current = false;
    if (hoverTimer.current) clearTimeout(hoverTimer.current);
    setShowMood(false);
  }, []);

  // ── Click → toggle QuickChat ──
  const handleClick = useCallback(() => {
    if (didDrag.current) return;
    brainRef.current?.interact();
    toggleQuickChat();
  }, [toggleQuickChat]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setShowMenu(true);
      setMenuPos({ x: e.clientX, y: e.clientY });
    },
    []
  );

  // ── Context menu actions ──
  const changeSize = useCallback(
    (s: PetSize) => {
      setShowMenu(false);
      setSize(s);
      localStorage.setItem("pet-size", s);
      if (quickChatOpen) resizeWindow(true);
    },
    [quickChatOpen, resizeWindow]
  );

  const toggleLock = useCallback(() => {
    setShowMenu(false);
    setLocked((v) => {
      localStorage.setItem("pet-locked", String(!v));
      return !v;
    });
  }, []);

  const switchPet = useCallback((name: string) => {
    setShowMenu(false);
    setPetName(name);
    localStorage.setItem("pet-name", name);
  }, []);

  const handleShowPanel = useCallback(async () => {
    setShowMenu(false);
    try {
      await invoke("expand_panel");
    } catch {}
  }, []);

  const handleHidePet = useCallback(async () => {
    setShowMenu(false);
    try {
      await invoke("hide_pet");
    } catch {}
  }, []);

  const handleQuit = useCallback(() => {
    setShowMenu(false);
    invoke("quit_app").catch(() => {});
  }, []);

  // ── Kanban badge count ──
  const kanbanStats = useKanbanStore((s) => s.data.stats);
  const kanbanBadge = kanbanStats.active + kanbanStats.blocked;

  const stateLabel =
    petBehavior === "sleep"
      ? "💤"
      : petBehavior === "walk"
        ? "🚶"
        : petBehavior === "interact"
          ? "💬"
          : "";

  const sleeping = petBehavior === "sleep";

  return (
    <div
      className={`pet-container ${quickChatOpen ? "expanded" : ""}`}
      data-size={size}
      data-state={sleeping ? "sleep" : petBehavior}
      data-mode={petMode}
    >
      {/* Left: Pet body */}
      <div
        ref={petBodyRef}
        className={`pet-body ${isDragging ? "dragging" : ""} ${sleeping ? "sleeping" : ""} mode-${petMode}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title={`AntDesk Pet [${sleeping ? "sleep" : petBehavior}/${petMode}]`}
      >
        <span
          className={`pet-status ${connected ? "connected" : "disconnected"}`}
        />
        <SpinePet
          ref={spineRef}
          petName={petName}
          width={SIZES[size].w * 0.7}
          height={SIZES[size].h * 0.7}
        />

        {stateLabel && (
          <div className="pet-state-label">{stateLabel}</div>
        )}

        {showMood && !isDragging && !quickChatOpen && (
          <div className="pet-mood-bubble">
            <span className="mood-emoji">{moodEmoji}</span>{" "}
            {moodText || "(^・ω・^)"}
          </div>
        )}

        {locked && <div className="pet-lock-badge">🔒</div>}

        {/* Kanban badge */}
        {kanbanBadge > 0 && !quickChatOpen && (
          <div className="pet-kanban-badge">{kanbanBadge}</div>
        )}
      </div>

      {/* Right: QuickChat panel (slides out) */}
      <QuickChat open={quickChatOpen} onClose={() => {
        setQuickChatOpen(false);
        resizeWindow(false);
      }} />

      {/* Notification banner */}
      {notifyMsg && (
        <div
          className="pet-notify-banner"
          onClick={() => setNotifyMsg(null)}
        >
          <span className="pet-notify-icon">⚠️</span>
          <span className="pet-notify-text">{notifyMsg}</span>
        </div>
      )}

      {/* Context menu */}
      <div
        className={`pet-menu ${showMenu ? "" : "hidden"}`}
        style={{ position: "absolute", left: menuPos.x, top: menuPos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pet-menu-item" onClick={handleShowPanel}>
          <span className="emoji">📋</span> 显示主面板
        </div>
        <div className="pet-menu-item" onClick={toggleQuickChat}>
          <span className="emoji">💬</span> {quickChatOpen ? "关闭面板" : "快捷面板"}
        </div>
        <div className="pet-menu-separator" />

        <div className="pet-menu-item" onClick={() => switchPet("moshumao")}>
          <span className="emoji">🐱</span> 墨鼠猫
          {petName === "moshumao" && (
            <span style={{ marginLeft: "auto", opacity: 0.5 }}>✓</span>
          )}
        </div>
        <div className="pet-menu-separator" />

        <div className="pet-menu-item" onClick={() => changeSize("tiny")}>
          <span className="emoji">🔹</span> 小 (120)
          {size === "tiny" && <span style={{ marginLeft: "auto", opacity: 0.5 }}>✓</span>}
        </div>
        <div className="pet-menu-item" onClick={() => changeSize("small")}>
          <span className="emoji">🔸</span> 中 (200)
          {size === "small" && <span style={{ marginLeft: "auto", opacity: 0.5 }}>✓</span>}
        </div>
        <div className="pet-menu-item" onClick={() => changeSize("medium")}>
          <span className="emoji">🟡</span> 大 (260)
          {size === "medium" && <span style={{ marginLeft: "auto", opacity: 0.5 }}>✓</span>}
        </div>
        <div className="pet-menu-item" onClick={() => changeSize("large")}>
          <span className="emoji">🟠</span> 特大 (360)
          {size === "large" && <span style={{ marginLeft: "auto", opacity: 0.5 }}>✓</span>}
        </div>
        <div className="pet-menu-separator" />

        <div className="pet-menu-item" onClick={toggleLock}>
          <span className="emoji">{locked ? "🔓" : "🔒"}</span>{" "}
          {locked ? "解锁位置" : "锁定位置"}
        </div>
        <div className="pet-menu-separator" />

        <div className="pet-menu-item" onClick={handleHidePet}>
          <span className="emoji">👁️</span> 隐藏宠物
        </div>
        <div className="pet-menu-item" onClick={handleQuit}>
          <span className="emoji">🚪</span> 退出
        </div>
      </div>
    </div>
  );
}

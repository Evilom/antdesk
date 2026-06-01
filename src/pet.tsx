import { invoke } from "@tauri-apps/api/core";
import {
  getCurrentWindow,
  currentMonitor,
} from "@tauri-apps/api/window";
import { useEffect, useState, useCallback, useRef } from "react";
import SpinePet, { type SpinePetHandle } from "./components/SpinePet";
import { PhysicsEngine } from "./lib/PhysicsEngine";
import {
  PetBrain,
  MODE_PHYSICS,
  type PetMode,
  type BehaviorState,
} from "./lib/PetBrain";

type PetSize = "tiny" | "small" | "medium" | "large";

const SIZES: Record<PetSize, { w: number; h: number }> = {
  tiny: { w: 120, h: 120 },
  small: { w: 200, h: 200 },
  medium: { w: 260, h: 260 },
  large: { w: 360, h: 360 },
};

// 行为状态 → 显示 emoji
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

  const didDrag = useRef(false);
  const spineRef = useRef<SpinePetHandle>(null);
  const petBodyRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const physicsRef = useRef<PhysicsEngine | null>(null);
  const brainRef = useRef<PetBrain | null>(null);
  const notifyTimer = useRef<ReturnType<typeof setTimeout>>(null);
  const isHovering = useRef(false);
  const lockedRef = useRef(false);

  // Keep lockedRef in sync
  useEffect(() => {
    lockedRef.current = locked;
  }, [locked]);

  // Check connection on mount
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

  // ── Initialize PetBrain (behavior state machine + todo advisor) ──
  useEffect(() => {
    const brain = new PetBrain({
      onBehaviorChange: (state, anim) => {
        setPetBehavior(state);
        setMoodEmoji(BEHAVIOR_EMOJI[state] || "😊");

        // Drive SpinePet animation
        const isLoop = state !== "interact";
        spineRef.current?.setAnimation(anim, isLoop);

        // Control PhysicsEngine based on behavior
        if (state === "sleep") {
          physicsRef.current?.stop();
        } else if (state === "interact") {
          // Brief pause — PhysicsEngine keeps its current state
        } else if (state === "walk") {
          if (!lockedRef.current) {
            physicsRef.current?.start();
          }
        }
        // "idle" — let PhysicsEngine do its own idle/walk cycle
      },
      onModeChange: (mode) => {
        setPetMode(mode);
        // Adjust PhysicsEngine params based on todo mode
        const params = MODE_PHYSICS[mode];
        physicsRef.current?.configure(params);
      },
      onMoodChange: (mood) => setMoodText(mood),
      onNotify: (message) => {
        setNotifyMsg(message);
        if (notifyTimer.current) clearTimeout(notifyTimer.current);
        notifyTimer.current = setTimeout(() => setNotifyMsg(null), 6000);
      },
    });

    brain.start();
    brainRef.current = brain;

    return () => {
      brain.dispose();
      brainRef.current = null;
    };
  }, []);

  // ── Initialize PhysicsEngine (movement engine) ──
  useEffect(() => {
    const physics = new PhysicsEngine({
      windowWidth: SIZES.medium.w,
      windowHeight: SIZES.medium.h,
      walkSpeed: 40,
      idleProbability: 0.3,
      onStateChange: (state) => {
        // Only override SpinePet animation if brain is in idle or walk
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

    // Apply current mode params from PetBrain
    if (brainRef.current) {
      physics.configure(MODE_PHYSICS[brainRef.current.getMode()]);
    }

    // Start if not locked and not sleeping
    if (!locked && !brainRef.current?.isSleeping()) {
      physics.start();
    }
    physicsRef.current = physics;

    return () => {
      physics.stop();
      physicsRef.current = null;
    };
  }, []);

  // ── Handle locked state changes ──
  useEffect(() => {
    if (locked || brainRef.current?.isSleeping()) {
      physicsRef.current?.stop();
    } else {
      physicsRef.current?.start();
    }
  }, [locked]);

  // ── Handle size changes ──
  useEffect(() => {
    const { w, h } = SIZES[size];
    physicsRef.current?.updateWindowSize(w, h);
  }, [size]);

  // ── Hover: pet faces mouse + mood bubble ──
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (isDragging || !petBodyRef.current) return;
      const rect = petBodyRef.current.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const dir: 1 | -1 = e.clientX > centerX ? 1 : -1;
      spineRef.current?.setFacingDirection(dir);
    },
    [isDragging]
  );

  const handleMouseEnter = useCallback(() => {
    if (isDragging) return;
    isHovering.current = true;
    brainRef.current?.notifyInteraction("hover");

    hoverTimer.current = setTimeout(() => {
      setShowMood(true);
    }, 400);
  }, [isDragging]);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
    isHovering.current = false;
    setShowMood(false);
  }, []);

  // ── Drag with animation ──
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      if (locked) return;
      didDrag.current = false;
      const startX = e.screenX;
      const startY = e.screenY;

      brainRef.current?.notifyInteraction("drag");
      physicsRef.current?.onDragStart();

      const onMouseMove = (me: MouseEvent) => {
        if (
          Math.abs(me.screenX - startX) > 5 ||
          Math.abs(me.screenY - startY) > 5
        ) {
          didDrag.current = true;
          setIsDragging(true);
          setShowMood(false);
          spineRef.current?.setAnimation("drag", true);
          document.removeEventListener("mousemove", onMouseMove);
          document.removeEventListener("mouseup", onMouseUp);
          getCurrentWindow().startDragging();
        }
      };

      const onMouseUp = () => {
        document.removeEventListener("mousemove", onMouseMove);
        document.removeEventListener("mouseup", onMouseUp);
      };

      document.addEventListener("mousemove", onMouseMove);
      document.addEventListener("mouseup", onMouseUp);
    },
    [locked]
  );

  // Restore roaming when drag ends
  useEffect(() => {
    const handleFocus = () => {
      if (isDragging) {
        setIsDragging(false);
        spineRef.current?.setAnimation("stand", true);
        physicsRef.current?.onDragEnd();
      }
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [isDragging]);

  // ── Click: open notepad panel ──
  const handleClick = useCallback(async () => {
    if (didDrag.current) return;
    setShowMenu(false);
    brainRef.current?.notifyInteraction("click");
    try {
      await invoke("toggle_notepad");
    } catch (e) {
      console.error("pet click failed:", e);
    }
  }, []);

  // ── Context menu ──
  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (didDrag.current) return;
      setMenuPos({ x: e.clientX, y: e.clientY });
      setShowMenu((v) => !v);
    },
    []
  );

  // Close menu on outside click
  useEffect(() => {
    if (!showMenu) return;
    const close = () => setShowMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [showMenu]);

  // ── Menu actions ──
  const changeSize = useCallback(async (newSize: PetSize) => {
    setShowMenu(false);
    setSize(newSize);
    localStorage.setItem("pet-size", newSize);
    try {
      await invoke("set_pet_size", { size: newSize });
    } catch (e) {
      console.error("set_pet_size failed:", e);
    }
  }, []);

  const toggleLock = useCallback(() => {
    setShowMenu(false);
    setLocked((v) => {
      localStorage.setItem("pet-locked", String(!v));
      return !v;
    });
  }, []);

  const switchPet = useCallback(async (name: string) => {
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

  // ── State indicator text ──
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
      className="pet-container"
      data-size={size}
      data-state={sleeping ? "sleep" : petBehavior}
      data-mode={petMode}
    >
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

        {/* State label */}
        {stateLabel && (
          <div className="pet-state-label">{stateLabel}</div>
        )}

        {/* Mood bubble — hover to show */}
        {showMood && !isDragging && (
          <div className="pet-mood-bubble">
            <span className="mood-emoji">{moodEmoji}</span>{" "}
            {moodText || "(^・ω・^)"}
          </div>
        )}

        {/* Lock indicator */}
        {locked && <div className="pet-lock-badge">🔒</div>}
      </div>

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
        style={{
          position: "absolute",
          left: menuPos.x,
          top: menuPos.y,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="pet-menu-item" onClick={handleShowPanel}>
          <span className="emoji">📋</span> 显示面板
        </div>
        <div className="pet-menu-separator" />

        {/* Switch pet */}
        <div className="pet-menu-item" onClick={() => switchPet("moshumao")}>
          <span className="emoji">🐱</span> 墨鼠猫
          {petName === "moshumao" && (
            <span style={{ marginLeft: "auto", opacity: 0.5 }}>✓</span>
          )}
        </div>
        <div className="pet-menu-separator" />

        {/* Size submenu */}
        <div className="pet-menu-item" onClick={() => changeSize("tiny")}>
          <span className="emoji">🔹</span> 小 (120)
          {size === "tiny" && (
            <span style={{ marginLeft: "auto", opacity: 0.5 }}>✓</span>
          )}
        </div>
        <div className="pet-menu-item" onClick={() => changeSize("small")}>
          <span className="emoji">🔸</span> 中 (200)
          {size === "small" && (
            <span style={{ marginLeft: "auto", opacity: 0.5 }}>✓</span>
          )}
        </div>
        <div className="pet-menu-item" onClick={() => changeSize("medium")}>
          <span className="emoji">🟡</span> 大 (260)
          {size === "medium" && (
            <span style={{ marginLeft: "auto", opacity: 0.5 }}>✓</span>
          )}
        </div>
        <div className="pet-menu-item" onClick={() => changeSize("large")}>
          <span className="emoji">🟠</span> 特大 (360)
          {size === "large" && (
            <span style={{ marginLeft: "auto", opacity: 0.5 }}>✓</span>
          )}
        </div>
        <div className="pet-menu-separator" />

        {/* Lock position */}
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

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit } from "@tauri-apps/api/event";
import { useEffect, useState, useCallback, useRef } from "react";

const PIE_ITEMS = [
  { tag: "all", label: "全部", emoji: "📋", color: "rgba(255,255,255,0.5)" },
  { tag: "工作", label: "工作", emoji: "💼", color: "#0a84ff" },
  { tag: "生活", label: "生活", emoji: "🏠", color: "#30d158" },
  { tag: "项目", label: "项目", emoji: "🎯", color: "#ff9f0a" },
  { tag: "__expand", label: "展开", emoji: "⬆️", color: "rgba(255,255,255,0.3)" },
];

const PIE_RADIUS = 62;

export default function FAB() {
  const [connected, setConnected] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const [showPie, setShowPie] = useState(false);
  const [pieAbove, setPieAbove] = useState(true); // pie goes upward by default
  const didDrag = useRef(false);
  const hideTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    invoke<string>("get_notion_token")
      .then(() => setConnected(true))
      .catch(() => setConnected(false));
  }, []);

  useEffect(() => {
    const fetchCount = () => {
      invoke<number>("get_pending_count")
        .then(setPendingCount)
        .catch(() => {});
    };
    fetchCount();
    const interval = setInterval(fetchCount, 30000);
    return () => clearInterval(interval);
  }, []);

  // Determine pie direction based on FAB position on screen
  const updatePieDirection = useCallback(async () => {
    try {
      const pos = await invoke<[number, number]>("get_fab_position");
      const screenH = window.screen.height;
      const fabCenterY = pos[1] + 100; // 200/2 = 100 (FAB window center)
      setPieAbove(fabCenterY > screenH / 2);
    } catch {}
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    didDrag.current = false;
    const startX = e.screenX;
    const startY = e.screenY;

    const onMouseMove = (me: MouseEvent) => {
      if (Math.abs(me.screenX - startX) > 3 || Math.abs(me.screenY - startY) > 3) {
        didDrag.current = true;
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
  }, []);

  const handleClick = useCallback(async () => {
    if (didDrag.current) return;
    try {
      await invoke("fab_click");
    } catch (e) {
      console.error("fab_click failed:", e);
    }
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    invoke("show_fab_context_menu").catch((err) =>
      console.error("show_fab_context_menu failed:", err)
    );
  }, []);

  const handleMouseEnter = useCallback(() => {
    clearTimeout(hideTimer.current);
    updatePieDirection();
    setShowPie(true);
  }, [updatePieDirection]);

  const handleMouseLeave = useCallback(() => {
    hideTimer.current = setTimeout(() => setShowPie(false), 300);
  }, []);

  const handlePieClick = useCallback(async (tag: string) => {
    setShowPie(false);
    if (tag === "__expand") {
      try {
        await invoke("toggle_quick_panel");
        await invoke("open_full_panel");
      } catch (e) {
        console.error("expand failed:", e);
      }
      return;
    }
    try {
      await emit("pie-filter-changed", { tag });
      await invoke("toggle_quick_panel");
    } catch (e) {
      console.error("pie filter emit failed:", e);
    }
  }, []);

  // Calculate pie item positions — adapt arc based on direction
  const piePositions = PIE_ITEMS.map((_, i) => {
    let angleDeg: number;
    if (pieAbove) {
      // FAB in bottom half → pie arcs upward (left to top)
      angleDeg = -180 + (-90 - (-180)) * (i / (PIE_ITEMS.length - 1));
    } else {
      // FAB in top half → pie arcs downward (left to bottom)
      angleDeg = 180 + (90 - 180) * (i / (PIE_ITEMS.length - 1));
    }
    const angleRad = (angleDeg * Math.PI) / 180;
    return {
      x: Math.cos(angleRad) * PIE_RADIUS,
      y: Math.sin(angleRad) * PIE_RADIUS,
    };
  });

  return (
    <div
      className="fab-container"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {/* Pie menu items */}
      {PIE_ITEMS.map((item, i) => (
        <div
          key={item.tag}
          className={`pie-item ${showPie ? "visible" : ""}`}
          style={{
            "--tx": `${piePositions[i].x}px`,
            "--ty": `${piePositions[i].y}px`,
            "--delay": `${i * 0.04}s`,
            "--color": item.color,
          } as React.CSSProperties}
          onClick={() => handlePieClick(item.tag)}
        >
          <span className="pie-emoji">{item.emoji}</span>
          <span className="pie-label">{item.label}</span>
        </div>
      ))}

      {/* Main FAB button */}
      <button
        className="fab-button"
        onMouseDown={handleMouseDown}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        title="AntDesk"
      >
        <span style={{ fontSize: "22px", lineHeight: 1 }}>&#129514;</span>
        <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
        {pendingCount > 0 && (
          <span className="pending-badge">{pendingCount > 99 ? "99+" : pendingCount}</span>
        )}
      </button>
    </div>
  );
}

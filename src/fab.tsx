import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useCallback, useRef } from "react";

export default function FAB() {
  const [connected, setConnected] = useState(false);
  const isDragging = useRef(false);


  useEffect(() => {
    invoke<string>("get_notion_token")
      .then(() => setConnected(true))
      .catch(() => setConnected(false));
  }, []);

  const handleMouseDown = useCallback(async (e: React.MouseEvent) => {
    isDragging.current = false;
    const startX = e.screenX;
    const startY = e.screenY;
    
    // Get initial window position once
    let winX = 0, winY = 0;
    try {
      const pos = await invoke<[number, number]>("get_fab_position");
      winX = pos[0]; winY = pos[1];
    } catch {}

    let rafId: number | null = null;
    let latestMouse = { x: e.screenX, y: e.screenY };

    const handleMouseMove = (me: MouseEvent) => {
      const dx = Math.abs(me.screenX - startX);
      const dy = Math.abs(me.screenY - startY);
      if (dx > 2 || dy > 2) isDragging.current = true;
      if (!isDragging.current) return;
      
      latestMouse.x = me.screenX;
      latestMouse.y = me.screenY;
      
      // Throttle to one RAF per frame for smooth 60fps
      if (rafId === null) {
        rafId = requestAnimationFrame(() => {
          const newX = winX + (latestMouse.x - startX);
          const newY = winY + (latestMouse.y - startY);
          invoke("set_fab_position", { x: newX, y: newY });
          rafId = null;
        });
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      if (rafId !== null) cancelAnimationFrame(rafId);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  const handleClick = useCallback(async () => {
    if (isDragging.current) return;
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

  return (
    <button
      className="fab-button"
      onMouseDown={handleMouseDown}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title="AntDesk"
    >
      <span style={{ fontSize: "22px", lineHeight: 1 }}>&#129514;</span>
      <span
        className={`status-dot ${connected ? "connected" : "disconnected"}`}
      />
    </button>
  );
}

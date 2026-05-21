import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState, useCallback, useRef } from "react";

export default function FAB() {
  const [connected, setConnected] = useState(false);
  const isDragging = useRef(false);
  const dragStartPos = useRef({ x: 0, y: 0 });
  const windowStartPos = useRef({ x: 0, y: 0 });

  useEffect(() => {
    invoke<string>("get_notion_token")
      .then(() => setConnected(true))
      .catch(() => setConnected(false));
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    isDragging.current = false;
    dragStartPos.current = { x: e.screenX, y: e.screenY };

    const handleMouseMove = async (me: MouseEvent) => {
      const dx = Math.abs(me.screenX - dragStartPos.current.x);
      const dy = Math.abs(me.screenY - dragStartPos.current.y);
      if (dx > 3 || dy > 3) {
        if (!isDragging.current) {
          isDragging.current = true;
          try {
            const pos = await invoke<[number, number]>("get_fab_position");
            windowStartPos.current = { x: pos[0], y: pos[1] };
          } catch (err) {
            console.error("get_fab_position failed:", err);
          }
        }
        const newX = windowStartPos.current.x + (me.screenX - dragStartPos.current.x);
        const newY = windowStartPos.current.y + (me.screenY - dragStartPos.current.y);
        invoke("set_fab_position", { x: newX, y: newY }).catch((err) =>
          console.error("set_fab_position failed:", err)
        );
      }
    };

    document.addEventListener("mousemove", handleMouseMove);
    const cleanup = () => {
      document.removeEventListener("mousemove", handleMouseMove);
    };
    document.addEventListener("mouseup", cleanup, { once: true });
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

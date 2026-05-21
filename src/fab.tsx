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
    const mouseStartX = e.screenX;
    const mouseStartY = e.screenY;

    let winStartX = 0, winStartY = 0;
    try {
      const pos = await invoke<[number, number]>("get_fab_position");
      winStartX = pos[0];
      winStartY = pos[1];
    } catch {}

    const handleMouseMove = (me: MouseEvent) => {
      const dx = Math.abs(me.screenX - mouseStartX);
      const dy = Math.abs(me.screenY - mouseStartY);
      if (dx > 2 || dy > 2) isDragging.current = true;
      if (!isDragging.current) return;

      invoke("set_fab_position", {
        x: winStartX + (me.screenX - mouseStartX),
        y: winStartY + (me.screenY - mouseStartY),
      });
    };

    const handleMouseUp = () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
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

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState, useCallback, useRef } from "react";

export default function FAB() {
  const [connected, setConnected] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);
  const didDrag = useRef(false);

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
      {pendingCount > 0 && (
        <span className="pending-badge">{pendingCount > 99 ? "99+" : pendingCount}</span>
      )}
    </button>
  );
}

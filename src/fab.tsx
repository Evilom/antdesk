import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

export default function FAB() {
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    // Check Notion connectivity on mount
    invoke<string>("get_notion_token")
      .then(() => setConnected(true))
      .catch(() => setConnected(false));
  }, []);

  const handleClick = async () => {
    try {
      await invoke("fab_click");
    } catch (e) {
      console.error("fab_click failed:", e);
    }
  };

  return (
    <button className="fab-button" onClick={handleClick} title="AntDesk">
      <span style={{ fontSize: "28px", lineHeight: 1 }}>&#129514;</span>
      <span
        className={`status-dot ${connected ? "connected" : "disconnected"}`}
      />
    </button>
  );
}

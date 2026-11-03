import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  WINDOW_INTERACTION_LABEL,
  nextWindowInteractionMode,
  readWindowInteractionMode,
  type WindowInteractionMode,
} from "../lib/DesktopWorldBridge";
import {
  IconEdit,
  IconEyeOff,
  IconLock,
  IconPower,
  IconReport,
  IconSettings,
  IconTarget,
  IconWindow,
} from "./Icons";

type MenuAction =
  | "quick"
  | "notepad"
  | "panel"
  | "settings"
  | "lock"
  | "window-interaction"
  | "hide"
  | "quit";

const BASE_ITEMS: Array<
  | { type: "item"; id: MenuAction; label: string; hint?: string; danger?: boolean; Icon: typeof IconTarget }
  | { type: "sep" }
> = [
  { type: "item", id: "quick", label: "快捷待办", Icon: IconTarget },
  { type: "item", id: "notepad", label: "便签", Icon: IconEdit },
  { type: "item", id: "panel", label: "打开主面板", Icon: IconReport },
  { type: "sep" },
  { type: "item", id: "settings", label: "设置", Icon: IconSettings },
  { type: "sep" },
  { type: "item", id: "lock", label: "锁定位置", Icon: IconLock },
  { type: "item", id: "hide", label: "隐藏桌宠", Icon: IconEyeOff },
  { type: "sep" },
  { type: "item", id: "quit", label: "退出 AntDesk", danger: true, Icon: IconPower },
];

export default function FabContextMenu() {
  const [interactionMode, setInteractionMode] = useState<WindowInteractionMode>(() => readWindowInteractionMode());
  const [pendingAction, setPendingAction] = useState<MenuAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const acting = useRef(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const hideSelf = useCallback(async () => {
    try { await invoke("hide_fab_context_menu"); }
    catch (e) { setError(`无法关闭菜单：${String(e)}`); }
  }, []);

  const items = useMemo(() => {
    return [
      ...BASE_ITEMS.slice(0, 6),
      {
        type: "item" as const,
        id: "window-interaction" as const,
        label: "桌面互动",
        hint: WINDOW_INTERACTION_LABEL[interactionMode],
        Icon: IconWindow,
      },
      ...BASE_ITEMS.slice(6),
    ];
  }, [interactionMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" || e.key === "Tab") { e.preventDefault(); void hideSelf(); return; }
      const buttons = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [])];
      if (!buttons.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : (index + (e.key === "ArrowUp" ? -1 : 1) + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    window.addEventListener("keydown", onKey);

    let disposed = false;
    let unlistenFocus: (() => void) | null = null;
    (async () => {
      try {
        const off = await getCurrentWindow().onFocusChanged(({ payload }) => {
          if (payload) {
            setInteractionMode(readWindowInteractionMode());
            setError(null);
            menuRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
          }
          else hideSelf();
        });
        if (disposed) off(); else unlistenFocus = off;
      } catch (e) { setError(`菜单监听失败：${String(e)}`); }
    })();

    return () => {
      disposed = true;
      window.removeEventListener("keydown", onKey);
      if (unlistenFocus) unlistenFocus();
    };
  }, [hideSelf]);

  const runAction = useCallback(async (action: MenuAction) => {
    if (acting.current) return;
    acting.current = true;
    setPendingAction(action);
    setError(null);
    try {
      switch (action) {
        case "quick":
          await invoke("toggle_quick_panel");
          break;
        case "notepad":
          await invoke("toggle_notepad");
          break;
        case "panel":
          await invoke("open_full_panel");
          break;
        case "settings":
          await invoke("show_settings");
          break;
        case "lock":
          await emitTo("pet", "toggle-lock");
          break;
        case "window-interaction":
          await emitTo("pet", "toggle-window-interaction");
          setInteractionMode((current) => nextWindowInteractionMode(current));
          break;
        case "hide":
          await invoke("hide_pet");
          break;
        case "quit":
          await invoke("quit_app");
          return;
      }
      await hideSelf();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e || "操作失败");
      console.error(`fab menu action failed: ${action}`, e);
      setError(message);
      setPendingAction(null);
      return;
    } finally {
      acting.current = false;
      setPendingAction(null);
    }
    setPendingAction(null);
  }, [hideSelf]);

  return (
    <div className="fab-menu-shell" onClick={e => { if (e.target === e.currentTarget) void hideSelf(); }}>
      <div
        ref={menuRef}
        className="fab-menu"
        role="menu"
        aria-label="宠物菜单"
      >
        {items.map((item, index) => {
          if (item.type === "sep") return <div key={`sep-${index}`} className="fab-menu-sep" />;
          const Icon = item.Icon;
          return (
            <button
              key={item.id}
              className={`fab-menu-item ${item.danger ? "danger" : ""}`}
              onClick={() => runAction(item.id)}
              disabled={pendingAction !== null}
              data-loading={pendingAction === item.id}
              role="menuitem"
            >
              <span className="fab-menu-icon"><Icon size={14} /></span>
              <span className="fab-menu-text">{item.label}</span>
              {item.hint && <span className="fab-menu-hint">{item.hint}</span>}
            </button>
          );
        })}
        {error && <div className="fab-menu-error">操作失败：{error}</div>}
      </div>
    </div>
  );
}

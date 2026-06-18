import { useCallback, useEffect, useMemo, useState } from "react";
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
  { type: "item", id: "quick", label: "焦点行动", hint: "快捷入口", Icon: IconTarget },
  { type: "item", id: "notepad", label: "便签记录", hint: "新增待办", Icon: IconEdit },
  { type: "item", id: "panel", label: "主面板", hint: "打开 AntDesk", Icon: IconReport },
  { type: "sep" },
  { type: "item", id: "settings", label: "设置", hint: "账号与外观", Icon: IconSettings },
  { type: "sep" },
  { type: "item", id: "lock", label: "锁定/解锁宠物", hint: "位置状态", Icon: IconLock },
  { type: "item", id: "hide", label: "隐藏宠物", hint: "保留后台", Icon: IconEyeOff },
  { type: "sep" },
  { type: "item", id: "quit", label: "退出 AntDesk", danger: true, Icon: IconPower },
];

export default function FabContextMenu() {
  const [interactionMode, setInteractionMode] = useState<WindowInteractionMode>(() => readWindowInteractionMode());
  const [pendingAction, setPendingAction] = useState<MenuAction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hideSelf = useCallback(async () => {
    try {
      await getCurrentWindow().hide();
    } catch {}
  }, []);

  const items = useMemo(() => {
    const next = nextWindowInteractionMode(interactionMode);
    return [
      ...BASE_ITEMS.slice(0, 6),
      {
        type: "item" as const,
        id: "window-interaction" as const,
        label: `宠物模式: ${WINDOW_INTERACTION_LABEL[interactionMode]}`,
        hint: `切换到${WINDOW_INTERACTION_LABEL[next]}`,
        Icon: IconWindow,
      },
      ...BASE_ITEMS.slice(6),
    ];
  }, [interactionMode]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hideSelf();
    };
    window.addEventListener("keydown", onKey);

    let unlistenFocus: (() => void) | null = null;
    (async () => {
      try {
        unlistenFocus = await getCurrentWindow().onFocusChanged(({ payload }) => {
          if (payload) {
            setInteractionMode(readWindowInteractionMode());
            setError(null);
          }
          else hideSelf();
        });
      } catch {}
    })();

    return () => {
      window.removeEventListener("keydown", onKey);
      if (unlistenFocus) unlistenFocus();
    };
  }, [hideSelf]);

  const runAction = useCallback(async (action: MenuAction) => {
    if (pendingAction) return;
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
      if (action === "quit") setPendingAction(null);
    }
    setPendingAction(null);
  }, [hideSelf, pendingAction]);

  return (
    <div className="fab-menu-shell">
      <div
        className="fab-menu"
        role="menu"
        aria-label="AntDesk FAB menu"
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

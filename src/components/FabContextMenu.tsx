import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
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

const MODE_LABEL: Record<WindowInteractionMode, string> = {
  off: "关闭",
  standard: "标准",
  enhanced: "增强",
};

const BASE_ITEMS: Array<
  | { type: "item"; id: MenuAction; label: string; hint?: string; danger?: boolean; Icon: typeof IconTarget }
  | { type: "sep" }
> = [
  { type: "item", id: "quick", label: "快捷面板", hint: "任务队列", Icon: IconTarget },
  { type: "item", id: "notepad", label: "便签", hint: "快速记录", Icon: IconEdit },
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
        label: `窗口交互: ${MODE_LABEL[interactionMode]}`,
        hint: `切换到${MODE_LABEL[next]}`,
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
          if (payload) setInteractionMode(readWindowInteractionMode());
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
          await emit("toggle-lock");
          break;
        case "window-interaction":
          await emit("toggle-window-interaction");
          setInteractionMode((current) => nextWindowInteractionMode(current));
          break;
        case "hide":
          await invoke("hide_pet");
          break;
        case "quit":
          await invoke("quit_app");
          return;
      }
    } finally {
      await hideSelf();
    }
  }, [hideSelf]);

  return (
    <div className="fab-menu-shell">
      <div className="fab-menu" role="menu" aria-label="AntDesk FAB menu">
        {items.map((item, index) => {
          if (item.type === "sep") return <div key={`sep-${index}`} className="fab-menu-sep" />;
          const Icon = item.Icon;
          return (
            <button
              key={item.id}
              className={`fab-menu-item ${item.danger ? "danger" : ""}`}
              onClick={() => runAction(item.id)}
              role="menuitem"
            >
              <span className="fab-menu-icon"><Icon size={14} /></span>
              <span className="fab-menu-text">{item.label}</span>
              {item.hint && <span className="fab-menu-hint">{item.hint}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

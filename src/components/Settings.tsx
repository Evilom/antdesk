import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../stores/appStore";
import { IconCheck } from "./Icons";
import {
  WINDOW_INTERACTION_HINT,
  WINDOW_INTERACTION_LABEL,
  readWindowInteractionMode,
  writeWindowInteractionMode,
  type WindowInteractionMode,
} from "../lib/DesktopWorldBridge";
import type { ThemeMode, AccentColor, FontSize, GlassIntensity } from "../types";

const ACCENT_OPTIONS: { id: AccentColor; label: string; color: string }[] = [
  { id: "blue",   label: "蓝", color: "#0a84ff" },
  { id: "purple", label: "紫", color: "#bf5af2" },
  { id: "green",  label: "绿", color: "#30d158" },
  { id: "orange", label: "橙", color: "#ff9f0a" },
  { id: "red",    label: "红", color: "#ff453a" },
  { id: "pink",   label: "粉", color: "#ff375f" },
];

const FONT_OPTIONS: { id: FontSize; label: string; size: string }[] = [
  { id: "small",  label: "小", size: "12px" },
  { id: "medium", label: "中", size: "13px" },
  { id: "large",  label: "大", size: "14px" },
];

const GLASS_OPTIONS: { id: GlassIntensity; label: string; desc: string }[] = [
  { id: "low",    label: "轻", desc: "更实" },
  { id: "medium", label: "中", desc: "平衡" },
  { id: "high",   label: "透", desc: "更透" },
];

const PET_MODE_OPTIONS: WindowInteractionMode[] = ["off", "standard", "enhanced"];

export default function Settings() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const notionConnected = useAppStore((s) => s.notionConnected);

  const [tokenInput, setTokenInput] = useState(settings.notionToken);
  const [endpointInput, setEndpointInput] = useState(settings.aiEndpoint);
  const [modelInput, setModelInput] = useState(settings.aiModel);
  const [petMode, setPetMode] = useState<WindowInteractionMode>(() => readWindowInteractionMode());

  // Autostart
  const [autostartEnabled, setAutostartEnabled] = useState(false);

  // Update
  const [updateStatus, setUpdateStatus] = useState("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    invoke<boolean>("plugin:autostart|is_enabled")
      .then((enabled) => setAutostartEnabled(enabled))
      .catch(() => {});
  }, []);

  // Sync inputs when settings change externally
  useEffect(() => {
    setTokenInput(settings.notionToken);
    setEndpointInput(settings.aiEndpoint);
    setModelInput(settings.aiModel);
  }, [settings.notionToken, settings.aiEndpoint, settings.aiModel]);

  const handleSave = () => {
    updateSettings({
      notionToken: tokenInput,
      aiEndpoint: endpointInput,
      aiModel: modelInput,
    });
  };

  const handlePetModeChange = (mode: WindowInteractionMode) => {
    setPetMode(mode);
    writeWindowInteractionMode(mode);
    emit("set-window-interaction-mode", mode).catch(() => {});
  };

  const handleClearCache = async () => {
    try {
      await invoke("clear_token_cache");
      setTokenInput("");
    } catch {}
  };

  const handleToggleAutostart = async () => {
    try {
      if (autostartEnabled) {
        await invoke("plugin:autostart|disable");
        setAutostartEnabled(false);
        setUpdateStatus("已关闭开机自启");
      } else {
        await invoke("plugin:autostart|enable");
        setAutostartEnabled(true);
        setUpdateStatus("已开启开机自启");
      }
      setTimeout(() => setUpdateStatus(""), 3000);
    } catch (e) {
      console.error("Autostart toggle failed:", e);
      setUpdateStatus(`自启设置失败: ${e}`);
      setTimeout(() => setUpdateStatus(""), 5000);
    }
  };

  const isDev = import.meta.env.DEV;

  const handleCheckUpdate = async () => {
    if (isDev) {
      setUpdateStatus("开发模式下不支持自动更新");
      setTimeout(() => setUpdateStatus(""), 3000);
      return;
    }
    setChecking(true);
    setUpdateStatus("检查中...");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check({ timeout: 30_000 });
      if (update?.available) {
        setUpdateStatus(`发现 v${update.version}，下载中...`);
        try {
          await update.downloadAndInstall((progress) => {
            if (progress.event === "Started" && progress.data.contentLength) {
              const mb = (progress.data.contentLength / 1024 / 1024).toFixed(1);
              setUpdateStatus(`发现 v${update.version}，下载 ${mb} MB...`);
            } else if (progress.event === "Progress") {
              setUpdateStatus(`发现 v${update.version}，下载中...`);
            } else if (progress.event === "Finished") {
              setUpdateStatus("下载完成，安装中...");
            }
          }, { timeout: 120_000 });
          setUpdateStatus("安装完成，即将重启...");
          const { relaunch } = await import("@tauri-apps/plugin-process");
          try {
            await relaunch();
          } catch (e: any) {
            console.error("Relaunch after update failed:", e);
            setUpdateStatus("安装完成，请手动重启 AntDesk");
          }
        } catch (e: any) {
          console.error("Update download failed:", e);
          setUpdateStatus(`下载失败: ${e?.message || e}`);
        }
      } else {
        setUpdateStatus("已是最新版本");
      }
    } catch (e: any) {
      console.error("Update check failed:", e);
      setUpdateStatus(`检查失败: ${e?.message || e}`);
    } finally {
      setChecking(false);
      setTimeout(() => setUpdateStatus(""), 8000);
    }
  };

  return (
    <div className="space-y-4 fade-in">
      {/* ── 外观 ── */}
      <Section title="外观">
        {/* 主题 */}
        <Label>主题模式</Label>
        <div className="flex gap-1.5">
          {(["dark", "light", "auto"] as ThemeMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => updateSettings({ theme: mode })}
              className={`flex-1 py-1.5 rounded-lg text-[10px] transition-all ${
                settings.theme === mode
                  ? "text-white"
                  : "text-text-muted hover:text-text-secondary"
              }`}
              style={{
                background: settings.theme === mode ? "var(--accent-primary)" : "var(--bg-input)",
                border: `1px solid ${settings.theme === mode ? "var(--accent-primary)" : "var(--border-card)"}`,
              }}
            >
              {mode === "dark" ? "深色" : mode === "light" ? "浅色" : "跟随系统"}
            </button>
          ))}
        </div>

        {/* 主题色 */}
        <Label>主题色</Label>
        <div className="flex gap-2">
          {ACCENT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => updateSettings({ accent: opt.id })}
              className="w-7 h-7 rounded-full flex items-center justify-center transition-all"
              style={{
                background: opt.color,
                boxShadow: settings.accent === opt.id ? `0 0 0 2px var(--bg-root), 0 0 0 4px ${opt.color}` : "none",
                transform: settings.accent === opt.id ? "scale(1.1)" : "scale(1)",
              }}
              title={opt.label}
            >
              {settings.accent === opt.id && <IconCheck size={12} className="text-white" />}
            </button>
          ))}
        </div>

        {/* 字体大小 */}
        <Label>字体大小</Label>
        <div className="flex gap-1.5">
          {FONT_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => updateSettings({ fontSize: opt.id })}
              className={`flex-1 py-1.5 rounded-lg transition-all ${
                settings.fontSize === opt.id ? "text-white" : "text-text-muted"
              }`}
              style={{
                background: settings.fontSize === opt.id ? "var(--accent-primary)" : "var(--bg-input)",
                border: `1px solid ${settings.fontSize === opt.id ? "var(--accent-primary)" : "var(--border-card)"}`,
                fontSize: opt.size,
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>

        {/* 透明度 */}
        <Label>透明度</Label>
        <div className="flex items-center gap-2">
          <span className="text-[9px] text-text-muted w-6">实</span>
          <input
            type="range"
            min={0}
            max={175}
            value={settings.transparency ?? 100}
            onChange={(e) => updateSettings({ transparency: Number(e.target.value) })}
            className="flex-1 accent-accent h-1"
            style={{ accentColor: "var(--accent-primary)" }}
          />
          <span className="text-[9px] text-text-muted w-6 text-right">透</span>
          <span className="text-[9px] text-text-muted w-6 text-right">
            {settings.transparency ?? 100}
          </span>
        </div>
      </Section>

      {/* ── 桌宠 ── */}
      <Section title="桌宠">
        <Label>行为模式</Label>
        <div className="flex gap-1.5">
          {PET_MODE_OPTIONS.map((mode) => (
            <button
              key={mode}
              onClick={() => handlePetModeChange(mode)}
              className={`flex-1 py-1.5 rounded-lg text-[10px] transition-all ${
                petMode === mode
                  ? "text-white"
                  : "text-text-muted hover:text-text-secondary"
              }`}
              style={{
                background: petMode === mode ? "var(--accent-primary)" : "var(--bg-input)",
                border: `1px solid ${petMode === mode ? "var(--accent-primary)" : "var(--border-card)"}`,
              }}
            >
              {WINDOW_INTERACTION_LABEL[mode]}
            </button>
          ))}
        </div>
        <div className="text-[10px] text-text-secondary leading-relaxed">
          {WINDOW_INTERACTION_HINT[petMode]}
        </div>
        <div className="text-[9px] text-text-muted leading-relaxed">
          标准/增强仅用窗口位置做避让和物理反馈；密码、银行、隐私浏览等敏感窗口会在本机过滤。
        </div>
      </Section>

      {/* ── Notion ── */}
      <Section title="Notion 连接">
        <div className="flex items-center gap-2 mb-2">
          <span className={`w-2 h-2 rounded-full ${notionConnected ? "bg-accent-green" : "bg-accent-red"}`} />
          <span className="text-xs text-text-secondary">
            {notionConnected ? "已连接" : "未连接"}
          </span>
        </div>
        <Label>Notion Token</Label>
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="ntn_..."
          className="input-field"
        />
        <button onClick={handleClearCache} className="text-[10px] text-accent-red hover:text-accent-red/80 mt-1 transition-colors">
          清除缓存
        </button>
      </Section>

      {/* ── AI ── */}
      <Section title="AI 配置">
        <Label>API 端点</Label>
        <input
          type="text"
          value={endpointInput}
          onChange={(e) => setEndpointInput(e.target.value)}
          className="input-field mb-2"
        />
        <Label>模型</Label>
        <select
          value={modelInput}
          onChange={(e) => setModelInput(e.target.value)}
          className="input-field cursor-pointer"
        >
          <option value="DeepSeek-V3.2">DeepSeek-V3.2 (稳定)</option>
          <option value="deepseek-v4-flash-think">deepseek-v4-flash-think (快速)</option>
        </select>
      </Section>

      {/* ── Kanban ── */}
      <Section title="看板连接">
        <Label>Hermes 看板端点</Label>
        <input
          type="text"
          value={localStorage.getItem("antdesk_kanban_endpoint") || ""}
          onChange={(e) => {
            localStorage.setItem("antdesk_kanban_endpoint", e.target.value);
            updateSettings({ kanbanEndpoint: e.target.value });
          }}
          placeholder="http://YOUR_IP:8765/kanban.json"
          className="input-field"
        />
        <div className="text-[9px] text-text-muted mt-1">
          运行 kanban-server.py 后填入地址
        </div>
      </Section>

      {/* ── 通用 ── */}
      <Section title="通用">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-secondary">开机自启动</span>
          <button
            onClick={handleToggleAutostart}
            className={`relative w-10 h-5 rounded-full transition-colors ${autostartEnabled ? "" : ""}`}
            style={{ background: autostartEnabled ? "var(--accent-primary)" : "var(--bg-input)" }}
          >
            <div
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${autostartEnabled ? "translate-x-5" : "translate-x-0.5"}`}
            />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-secondary">检查更新</span>
          <button
            onClick={handleCheckUpdate}
            disabled={checking}
            className="text-[10px] px-3 py-1 rounded-lg transition-colors disabled:opacity-40"
            style={{ background: "var(--bg-hover)", color: "var(--accent-text)" }}
          >
            {checking ? "检查中..." : "检查"}
          </button>
        </div>
        {updateStatus && (
          <div className="text-[10px] text-accent-green text-center">{updateStatus}</div>
        )}
      </Section>

      {/* Save */}
      <button
        onClick={handleSave}
        className="w-full py-2 text-white text-xs rounded-button hover:opacity-85 transition-colors"
        style={{ background: "var(--accent-primary)" }}
      >
        保存设置
      </button>

      {/* Info */}
      <div className="text-center text-[10px] text-text-muted space-y-0.5">
        <AppVersion />
        <div>Tauri 2 + React 19 + Zustand</div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="card p-3 space-y-2">
      <h3 className="text-caption text-text-secondary">{title}</h3>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-[10px] text-text-muted block mb-1">{children}</label>;
}

function AppVersion() {
  const [ver, setVer] = useState("");
  useEffect(() => {
    import("@tauri-apps/api/app").then(({ getVersion }) => {
      getVersion().then((v) => setVer(`v${v}`)).catch(() => {});
    }).catch(() => {});
  }, []);
  return <div>AntDesk {ver}</div>;
}

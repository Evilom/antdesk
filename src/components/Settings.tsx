import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";
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

export default function Settings() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const notionConnected = useAppStore((s) => s.notionConnected);

  const [tokenInput, setTokenInput] = useState(settings.notionToken);
  const [endpointInput, setEndpointInput] = useState(settings.aiEndpoint);
  const [modelInput, setModelInput] = useState(settings.aiModel);

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
      } else {
        await invoke("plugin:autostart|enable");
      }
      setAutostartEnabled(!autostartEnabled);
    } catch (e) {
      console.error("Autostart toggle failed:", e);
    }
  };

  const isDev = window.location.hostname === "localhost" || window.location.protocol === "http:";

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
      const update = await check();
      if (update?.available) {
        setUpdateStatus(`发现 v${update.version}，下载中...`);
        try {
          await update.downloadAndInstall();
          setUpdateStatus("安装完成，即将重启...");
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        } catch {
          setUpdateStatus("下载失败，请手动下载");
        }
      } else {
        setUpdateStatus("已是最新版本");
      }
    } catch (e) {
      setUpdateStatus("检查失败，请检查网络");
    } finally {
      setChecking(false);
      setTimeout(() => setUpdateStatus(""), 5000);
    }
  };

  return (
    <div className="space-y-4 fade-in">
      <h2 className="text-sm font-medium text-text-primary">设置</h2>

      {/* ── 外观 ── */}
      <Section title=" 外观">
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
              {mode === "dark" ? " 深色" : mode === "light" ? "☀️ 浅色" : " 跟随系统"}
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
              {settings.accent === opt.id && <span className="text-white text-[10px]">✓</span>}
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

        {/* 玻璃效果 */}
        <Label>玻璃效果</Label>
        <div className="flex gap-1.5">
          {GLASS_OPTIONS.map((opt) => (
            <button
              key={opt.id}
              onClick={() => updateSettings({ glass: opt.id })}
              className={`flex-1 py-1.5 rounded-lg text-[10px] transition-all ${
                settings.glass === opt.id ? "text-white" : "text-text-muted"
              }`}
              style={{
                background: settings.glass === opt.id ? "var(--accent-primary)" : "var(--bg-input)",
                border: `1px solid ${settings.glass === opt.id ? "var(--accent-primary)" : "var(--border-card)"}`,
              }}
            >
              {opt.label}<br/><span className="text-[8px] opacity-60">{opt.desc}</span>
            </button>
          ))}
        </div>
      </Section>

      {/* ── Notion ── */}
      <Section title=" Notion 连接">
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
          className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2.5 py-1.5 outline-none border border-white/5 focus:border-accent-blue/50 transition-colors placeholder:text-text-muted"
        />
        <button onClick={handleClearCache} className="text-[10px] text-accent-red hover:text-accent-red/80 mt-1 transition-colors">
          清除缓存
        </button>
      </Section>

      {/* ── AI ── */}
      <Section title=" AI 配置">
        <Label>API 端点</Label>
        <input
          type="text"
          value={endpointInput}
          onChange={(e) => setEndpointInput(e.target.value)}
          className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2.5 py-1.5 outline-none border border-white/5 focus:border-accent-blue/50 transition-colors mb-2"
        />
        <Label>模型</Label>
        <select
          value={modelInput}
          onChange={(e) => setModelInput(e.target.value)}
          className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2 py-1.5 outline-none border border-white/5 cursor-pointer"
        >
          <option value="DeepSeek-V3.2">DeepSeek-V3.2 (稳定)</option>
          <option value="deepseek-v4-flash-think">deepseek-v4-flash-think (快速)</option>
        </select>
      </Section>

      {/* ── 通用 ── */}
      <Section title="⚙️ 通用">
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
        <div>AntDesk v2.4.1</div>
        <div>Tauri 2 + React 19 + Zustand</div>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-bg-card rounded-card p-3 space-y-2">
      <h3 className="text-xs font-medium text-text-secondary">{title}</h3>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <label className="text-[10px] text-text-muted block mb-1">{children}</label>;
}

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../stores/appStore";

export default function Settings() {
  const settings = useAppStore((s) => s.settings);
  const updateSettings = useAppStore((s) => s.updateSettings);
  const notionConnected = useAppStore((s) => s.notionConnected);

  const [tokenInput, setTokenInput] = useState(settings.notionToken);
  const [endpointInput, setEndpointInput] = useState(settings.aiEndpoint);
  const [modelInput, setModelInput] = useState(settings.aiModel);
  const [saved, setSaved] = useState(false);

  // Autostart state
  const [autostartEnabled, setAutostartEnabled] = useState(false);

  // Update state
  const [updateStatus, setUpdateStatus] = useState<string>("");
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    // Check current autostart status
    invoke<boolean>("plugin:autostart|is_enabled").then((enabled) => {
      setAutostartEnabled(enabled);
    }).catch(() => {});
  }, []);

  const handleSave = () => {
    updateSettings({
      notionToken: tokenInput,
      aiEndpoint: endpointInput,
      aiModel: modelInput,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
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
      } else {
        await invoke("plugin:autostart|enable");
        setAutostartEnabled(true);
      }
    } catch (e) {
      console.error("Autostart toggle failed:", e);
    }
  };

  const handleCheckUpdate = async () => {
    setChecking(true);
    setUpdateStatus("检查中...");
    try {
      const { check } = await import("@tauri-apps/plugin-updater");
      const update = await check();
      if (update?.available) {
        setUpdateStatus(`发现新版本 v${update.version}`);
        const shouldUpdate = confirm(`发现新版本 v${update.version}！\n\n${update.body || "是否立即更新？"}`);
        if (shouldUpdate) {
          setUpdateStatus("下载中...");
          await update.downloadAndInstall();
          setUpdateStatus("安装完成，即将重启...");
          const { relaunch } = await import("@tauri-apps/plugin-process");
          await relaunch();
        }
      } else {
        setUpdateStatus("已是最新版本");
      }
    } catch (e) {
      setUpdateStatus("检查失败（开发模式不支持）");
    } finally {
      setChecking(false);
      setTimeout(() => setUpdateStatus(""), 3000);
    }
  };

  return (
    <div className="space-y-4 fade-in">
      <h2 className="text-sm font-medium">设置</h2>

      {/* Notion */}
      <Section title="Notion 连接">
        <div className="flex items-center gap-2 mb-2">
          <span
            className={`w-2 h-2 rounded-full ${
              notionConnected ? "bg-accent-green" : "bg-accent-red"
            }`}
          />
          <span className="text-xs text-text-secondary">
            {notionConnected ? "已连接" : "未连接"}
          </span>
        </div>
        <label className="text-[10px] text-text-muted block mb-1">
          Notion Token
        </label>
        <input
          type="password"
          value={tokenInput}
          onChange={(e) => setTokenInput(e.target.value)}
          placeholder="ntn_..."
          className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2.5 py-1.5 outline-none border border-white/5 focus:border-accent-blue/50 transition-colors placeholder:text-text-muted"
        />
        <button
          onClick={handleClearCache}
          className="text-[10px] text-accent-red hover:text-accent-red/80 mt-1 transition-colors"
        >
          清除缓存
        </button>
      </Section>

      {/* AI */}
      <Section title="AI 配置">
        <label className="text-[10px] text-text-muted block mb-1">
          API 端点
        </label>
        <input
          type="text"
          value={endpointInput}
          onChange={(e) => setEndpointInput(e.target.value)}
          className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2.5 py-1.5 outline-none border border-white/5 focus:border-accent-blue/50 transition-colors mb-2"
        />
        <label className="text-[10px] text-text-muted block mb-1">模型</label>
        <select
          value={modelInput}
          onChange={(e) => setModelInput(e.target.value)}
          className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2.5 py-1.5 outline-none border border-white/5 cursor-pointer"
        >
          <option value="DeepSeek-V3.2">DeepSeek-V3.2 (稳定)</option>
          <option value="deepseek-v4-flash-think">
            deepseek-v4-flash-think (快速)
          </option>
        </select>
      </Section>

      {/* Autostart & Update */}
      <Section title="通用">
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-secondary">开机自启动</span>
          <button
            onClick={handleToggleAutostart}
            className={`relative w-10 h-5 rounded-full transition-colors ${
              autostartEnabled ? "bg-accent-blue" : "bg-white/10"
            }`}
          >
            <div
              className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                autostartEnabled ? "translate-x-5" : "translate-x-0.5"
              }`}
            />
          </button>
        </div>
        <div className="flex items-center justify-between">
          <span className="text-xs text-text-secondary">检查更新</span>
          <button
            onClick={handleCheckUpdate}
            disabled={checking}
            className="text-[10px] px-3 py-1 bg-white/5 hover:bg-white/10 rounded-lg transition-colors text-accent-blue disabled:opacity-40"
          >
            {checking ? "检查中..." : "检查"}
          </button>
        </div>
        {updateStatus && (
          <div className="text-[10px] text-accent-green text-center">
            {updateStatus}
          </div>
        )}
      </Section>

      {/* Save */}
      <button
        onClick={handleSave}
        className="w-full py-2 bg-accent-blue text-white text-xs rounded-button hover:bg-accent-blue/80 transition-colors"
      >
        {saved ? "已保存" : "保存设置"}
      </button>

      {/* Info */}
      <div className="text-center text-[10px] text-text-muted space-y-0.5">
        <div>AntDesk v2.3.0</div>
        <div>Tauri 2 + React 19 + Zustand</div>
      </div>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-bg-card rounded-card p-3 space-y-2">
      <h3 className="text-xs font-medium text-text-secondary">{title}</h3>
      {children}
    </div>
  );
}

import { useState } from "react";
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
          className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2.5 py-1.5 outline-none border border-white/5 focus:border-accent-purple/50 transition-colors placeholder:text-text-muted"
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
          className="w-full bg-bg-input text-text-primary text-xs rounded-button px-2.5 py-1.5 outline-none border border-white/5 focus:border-accent-purple/50 transition-colors mb-2"
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

      {/* Save */}
      <button
        onClick={handleSave}
        className="w-full py-2 bg-accent-purple text-white text-xs rounded-button hover:bg-accent-purple/80 transition-colors"
      >
        {saved ? "已保存" : "保存设置"}
      </button>

      {/* Info */}
      <div className="text-center text-[10px] text-text-muted space-y-0.5">
        <div>AntDesk v2.0.0</div>
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

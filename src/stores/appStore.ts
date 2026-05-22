import { create } from "zustand";
import type { Todo, Report, Project, ChatMessage, Page, AppSettings, ThemeMode, AccentColor, FontSize, GlassIntensity } from "../types";

interface AppState {
  currentPage: Page;
  setCurrentPage: (page: Page) => void;

  todos: Todo[];
  reports: Report[];
  projects: Project[];
  notionConnected: boolean;

  setTodos: (todos: Todo[]) => void;
  addTodo: (todo: Todo) => void;
  updateTodo: (id: string, updates: Partial<Todo>) => void;
  setReports: (reports: Report[]) => void;
  setProjects: (projects: Project[]) => void;
  setNotionConnected: (connected: boolean) => void;

  chatMessages: ChatMessage[];
  chatLoading: boolean;
  addChatMessage: (msg: ChatMessage) => void;
  updateLastAssistantMessage: (content: string) => void;
  setChatLoading: (loading: boolean) => void;
  clearChat: () => void;

  settings: AppSettings;
  updateSettings: (updates: Partial<AppSettings>) => void;

  loading: boolean;
  setLoading: (loading: boolean) => void;
}

const DEFAULT_SETTINGS: AppSettings = {
  notionToken: "",
  aiEndpoint: "http://evilom.top:6037/v1/chat/completions",
  aiModel: "DeepSeek-V3.2",
  theme: "dark",
  accent: "blue",
  fontSize: "medium",
  glass: "medium",
};

function loadSettings(): AppSettings {
  try {
    const saved = localStorage.getItem("antdesk_settings");
    if (saved) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(saved) };
    }
  } catch {}
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: AppSettings) {
  try {
    localStorage.setItem("antdesk_settings", JSON.stringify(settings));
  } catch {}
}

const initialSettings = loadSettings();

export const useAppStore = create<AppState>((set) => ({
  currentPage: "today",
  setCurrentPage: (page) => set({ currentPage: page }),

  todos: [],
  reports: [],
  projects: [],
  notionConnected: false,

  setTodos: (todos) => set({ todos }),
  addTodo: (todo) => set((state) => ({ todos: [todo, ...state.todos] })),
  updateTodo: (id, updates) =>
    set((state) => ({
      todos: state.todos.map((t) => (t.id === id ? { ...t, ...updates } : t)),
    })),
  setReports: (reports) => set({ reports }),
  setProjects: (projects) => set({ projects }),
  setNotionConnected: (connected) => set({ notionConnected: connected }),

  chatMessages: [],
  chatLoading: false,
  addChatMessage: (msg) =>
    set((state) => ({ chatMessages: [...state.chatMessages, msg] })),
  updateLastAssistantMessage: (content) =>
    set((state) => {
      const msgs = [...state.chatMessages];
      const last = msgs[msgs.length - 1];
      if (last && last.role === "assistant") {
        msgs[msgs.length - 1] = { ...last, content };
      }
      return { chatMessages: msgs };
    }),
  setChatLoading: (loading) => set({ chatLoading: loading }),
  clearChat: () => set({ chatMessages: [] }),

  settings: initialSettings,
  updateSettings: (updates) =>
    set((state) => {
      const newSettings = { ...state.settings, ...updates };
      saveSettings(newSettings);
      applyTheme(newSettings);
      return { settings: newSettings };
    }),

  loading: false,
  setLoading: (loading) => set({ loading }),
}));

// ── Theme Application ──

const ACCENT_COLORS: Record<AccentColor, { primary: string; bg: string; text: string }> = {
  blue:   { primary: "#0a84ff", bg: "rgba(10,132,255,0.12)", text: "#0a84ff" },
  purple: { primary: "#bf5af2", bg: "rgba(191,90,242,0.12)", text: "#bf5af2" },
  green:  { primary: "#30d158", bg: "rgba(48,209,88,0.12)",  text: "#30d158" },
  orange: { primary: "#ff9f0a", bg: "rgba(255,159,10,0.12)", text: "#ff9f0a" },
  red:    { primary: "#ff453a", bg: "rgba(255,69,58,0.12)",  text: "#ff453a" },
  pink:   { primary: "#ff375f", bg: "rgba(255,55,95,0.12)",  text: "#ff375f" },
};

const FONT_SIZES: Record<FontSize, string> = {
  small: "12px",
  medium: "13px",
  large: "14px",
};

const GLASS_CONFIG: Record<GlassIntensity, { blur: number; opacity: number; border: number }> = {
  low:    { blur: 30,  opacity: 0.85, border: 0.12 },
  medium: { blur: 50,  opacity: 0.70, border: 0.08 },
  high:   { blur: 80,  opacity: 0.55, border: 0.06 },
};

export function applyTheme(settings: AppSettings) {
  const root = document.documentElement;
  const isDark = settings.theme === "dark" || (settings.theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  // Mode
  root.setAttribute("data-theme", isDark ? "dark" : "light");

  // Accent
  const accent = ACCENT_COLORS[settings.accent || "blue"];
  root.style.setProperty("--accent-primary", accent.primary);
  root.style.setProperty("--accent-bg", accent.bg);
  root.style.setProperty("--accent-text", accent.text);

  // Font
  root.style.setProperty("--font-size-base", FONT_SIZES[settings.fontSize || "medium"]);

  // Glass
  const glass = GLASS_CONFIG[settings.glass || "medium"];
  root.style.setProperty("--glass-blur", `${glass.blur}px`);
  root.style.setProperty("--glass-opacity", String(glass.opacity));
  root.style.setProperty("--glass-border", String(glass.border));
}

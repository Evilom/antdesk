import { create } from "zustand";
import type { Todo, Report, Project, ChatMessage, Page, AppSettings } from "../types";

interface AppState {
  // Navigation
  currentPage: Page;
  setCurrentPage: (page: Page) => void;

  // Notion data
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

  // Chat
  chatMessages: ChatMessage[];
  chatLoading: boolean;
  addChatMessage: (msg: ChatMessage) => void;
  updateLastAssistantMessage: (content: string) => void;
  setChatLoading: (loading: boolean) => void;
  clearChat: () => void;

  // Settings
  settings: AppSettings;
  updateSettings: (updates: Partial<AppSettings>) => void;

  // Loading states
  loading: boolean;
  setLoading: (loading: boolean) => void;
}

const DEFAULT_SETTINGS: AppSettings = {
  notionToken: "",
  aiEndpoint: "http://evilom.top:6037/v1/chat/completions",
  aiModel: "DeepSeek-V3.2",
  theme: "dark",
};

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

  settings: DEFAULT_SETTINGS,
  updateSettings: (updates) =>
    set((state) => ({ settings: { ...state.settings, ...updates } })),

  loading: false,
  setLoading: (loading) => set({ loading }),
}));

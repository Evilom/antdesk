/**
 * kanbanStore — Zustand store for kanban data from Hermes agentmemory
 */

import { create } from "zustand";
import type { KanbanData, KanbanAction } from "../types/kanban";
import { EMPTY_KANBAN } from "../types/kanban";

interface KanbanState {
  data: KanbanData;
  connected: boolean;
  lastError: string | null;
  endpoint: string;

  setData: (data: KanbanData) => void;
  setConnected: (connected: boolean) => void;
  setError: (err: string | null) => void;
  setEndpoint: (url: string) => void;

  // Derived selectors
  getActiveActions: () => KanbanAction[];
  getBlockedActions: () => KanbanAction[];
  getPendingActions: () => KanbanAction[];
  getHighPriorityActions: () => KanbanAction[];
  getStats: () => KanbanData["stats"];
}

export const useKanbanStore = create<KanbanState>((set, get) => ({
  data: EMPTY_KANBAN,
  connected: false,
  lastError: null,
  endpoint: localStorage.getItem("antdesk_kanban_endpoint") || "",

  setData: (data) => {
    set({ data, connected: true, lastError: null });
    // Persist for cross-window access
    try {
      localStorage.setItem("antdesk_kanban", JSON.stringify(data));
    } catch {}
  },

  setConnected: (connected) => set({ connected }),
  setError: (err) => set({ lastError: err }),
  setEndpoint: (url) => {
    set({ endpoint: url });
    localStorage.setItem("antdesk_kanban_endpoint", url);
  },

  getActiveActions: () => get().data.actions.filter((a) => a.status === "active"),
  getBlockedActions: () => get().data.actions.filter((a) => a.status === "blocked"),
  getPendingActions: () => get().data.actions.filter((a) => a.status === "pending"),
  getHighPriorityActions: () =>
    get().data.actions.filter((a) => a.priority >= 7 && a.status !== "done"),
  getStats: () => get().data.stats,
}));

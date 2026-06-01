/**
 * Kanban types — shared between Hermes agentmemory and AntDesk pet
 */

export interface KanbanAction {
  id: string;
  title: string;
  description?: string;
  status: "pending" | "active" | "blocked" | "done" | "cancelled";
  priority: number; // 1-10, 10 = highest
  tags?: string[];
  project?: string;
  requires?: string[]; // dependency action IDs
  result?: string;
  createdAt?: string;
  updatedAt?: string;
  completedAt?: string;
}

export interface KanbanData {
  actions: KanbanAction[];
  completedToday: KanbanAction[];
  exportedAt: string;
  stats: {
    pending: number;
    active: number;
    blocked: number;
    completedToday: number;
  };
}

/** Empty kanban state */
export const EMPTY_KANBAN: KanbanData = {
  actions: [],
  completedToday: [],
  exportedAt: "",
  stats: { pending: 0, active: 0, blocked: 0, completedToday: 0 },
};

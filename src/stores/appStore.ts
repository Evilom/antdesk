import { create } from 'zustand'
import * as notion from '../lib/notion'
import type { TokenStatus } from '../lib/notion'

interface AppState {
  todos: notion.Todo[]
  projects: notion.Project[]
  reports: notion.Report[]
  loading: boolean
  error: string | null
  tokenStatus: TokenStatus
  fetchAll: () => Promise<void>
  toggleTodo: (id: string, checked: boolean) => Promise<void>
  addTodo: (name: string, priority?: string, tags?: string[], projectId?: string) => Promise<void>
  refreshToken: () => Promise<void>
}

export const useAppStore = create<AppState>((set, get) => ({
  todos: [],
  projects: [],
  reports: [],
  loading: false,
  error: null,
  tokenStatus: { connected: false, token: null, error: null },

  fetchAll: async () => {
    set({ loading: true, error: null })
    try {
      const tokenStatus = await notion.getToken()
      if (!tokenStatus.connected) {
        set({ loading: false, error: tokenStatus.error })
        return
      }
      const [todos, projects, reports] = await Promise.all([
        notion.queryTodos(),
        notion.queryProjects(),
        notion.queryReports(7),
      ])
      set({ todos, projects, reports, tokenStatus, loading: false })
    } catch (e) {
      set({ error: String(e), loading: false })
    }
  },

  toggleTodo: async (id, checked) => {
    await notion.toggleTodoStatus(id, checked)
    const todos = get().todos.map(t => t.id === id ? { ...t, status: !checked } : t)
    set({ todos })
  },

  addTodo: async (name, priority, tags, projectId) => {
    await notion.createTodo(name, priority, tags, projectId)
    await get().fetchAll()
  },

  refreshToken: async () => {
    const tokenStatus = await notion.getToken()
    set({ tokenStatus })
  },
}))

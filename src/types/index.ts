export interface NotionTodo {
  id: string
  name: string
  status: boolean
  priority: 'High' | 'Medium' | 'Low' | ''
  tags: string[]
  projectId: string
  projectName?: string
}

export interface NotionProject {
  id: string
  name: string
  status: string
}

export interface NotionReport {
  id: string
  name: string
  createdTime: string
  content?: string
}

export interface NotionConfig {
  token: string
  todosDbId: string
  todosDsId: string
  projectsDbId: string
  projectsDsId: string
  reportsDbId: string
  reportsDsId: string
}

export interface ProxyConfig {
  enabled: boolean
  host: string
  port: number
  username?: string
  password?: string
}

export interface AppConfig {
  notion: NotionConfig
  proxy: ProxyConfig
  openclawUrl: string
}

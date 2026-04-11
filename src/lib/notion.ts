import { invoke } from '@tauri-apps/api/core'
import type { NotionTodo, NotionProject, NotionReport, NotionConfig } from '../types'

export interface TokenStatus {
  connected: boolean
  token: string | null
  error: string | null
}

// AntData 数据库 ID
const DB_IDS = {
  todos:    '2d51ba51-3457-8125-9d4c-f28ffa2fff14',
  projects:  '2d51ba51-3457-8127-840e-d8b43c0e5e21',
  reports:   '2d51ba51-3457-8158-84e1-c5cbc66ed8b2',
  // data_source IDs
  todosDs:    '2d51ba51-3457-815e-8850-000b6ebaa003',
  projectsDs: '2d51ba51-3457-813a-9eeb-000b6715eed1',
  reportsDs:  '2d51ba51-3457-815f-8e4d-000c70f2f91a',
}

export async function getToken(): Promise<TokenStatus> {
  try {
    const token: string = await invoke('get_notion_token')
    return { connected: true, token, error: null }
  } catch (e) {
    return { connected: false, token: null, error: String(e) }
  }
}

export async function clearToken(): Promise<void> {
  await invoke('clear_token_cache')
}

// 调用 Notion API（通过 Rust 后端代理）
async function notionFetch(path: string, method: string, body?: object): Promise<any> {
  const token = await invoke<string>('get_notion_token')
  const raw = body ? JSON.stringify(body) : undefined
  const result: string = await invoke('fetch_notion', {
    path,
    method,
    body: raw,
    token,
  })
  return JSON.parse(result)
}

// ===== 页面属性解析 =====

function extractText(prop: any): string {
  if (!prop) return ''
  if (prop.type === 'title') return prop.title?.map((t: any) => t.plain_text || '').join('') || ''
  if (prop.type === 'rich_text') return prop.rich_text?.map((t: any) => t.plain_text || '').join('') || ''
  return ''
}

function extractSelect(prop: any): string {
  if (!prop) return ''
  return prop.select?.name || ''
}

function extractMultiSelect(prop: any): string[] {
  if (!prop) return []
  return prop.multi_select?.map((s: any) => s.name) || []
}

function extractCheckbox(prop: any): boolean {
  if (!prop) return false
  return prop.checkbox || false
}

function extractRelation(prop: any): string[] {
  if (!prop) return []
  return prop.relation?.map((r: any) => r.id) || []
}

function extractDate(prop: any): string | null {
  if (!prop) return null
  return prop.date?.start || null
}

// ===== 任务 =====

export interface Todo {
  id: string
  name: string
  status: boolean  // true=已完成
  priority: string  // High/Medium/Low
  tags: string[]
  projectId?: string
  createdTime?: string
}

export async function queryTodos(): Promise<Todo[]> {
  const data = await notionFetch(`/v1/databases/${DB_IDS.todos}/query`, 'POST', {
    page_size: 100,
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  })
  return (data.results || []).map((page: any) => ({
    id: page.id,
    name: extractText(page.properties?.Name),
    status: extractCheckbox(page.properties?.Status),
    priority: extractSelect(page.properties?.Priority) || 'Medium',
    tags: extractMultiSelect(page.properties?.Tags),
    projectId: extractRelation(page.properties?.Project)[0] || undefined,
    createdTime: page.created_time,
  }))
}

export async function toggleTodoStatus(id: string, checked: boolean): Promise<void> {
  await notionFetch(`/v1/pages/${id}`, 'PATCH', {
    properties: { Status: { checkbox: !checked } }
  })
}

export async function createTodo(
  name: string,
  priority = 'Medium',
  tags: string[] = [],
  projectId?: string
): Promise<void> {
  const props: any = {
    Name: { title: [{ text: { content: name } }] },
    Status: { checkbox: false },
    Priority: { select: { name: priority } },
    Tags: { multi_select: tags.map(t => ({ name: t })) },
  }
  if (projectId) {
    props.Project = { relation: [{ id: projectId }] }
  }
  await notionFetch('/v1/pages', 'POST', {
    parent: { database_id: DB_IDS.todos },
    properties: props,
  })
}

// ===== 项目 =====

export interface Project {
  id: string
  name: string
  status: string
}

export async function queryProjects(): Promise<Project[]> {
  const data = await notionFetch(`/v1/databases/${DB_IDS.projects}/query`, 'POST', {
    page_size: 50,
  })
  return (data.results || []).map((page: any) => ({
    id: page.id,
    name: extractText(page.properties?.Name),
    status: extractSelect(page.properties?.Status),
  }))
}

// ===== 日报 =====

export interface Report {
  id: string
  date: string
  summary: string
}

export async function queryReports(limit = 7): Promise<Report[]> {
  const data = await notionFetch(`/v1/databases/${DB_IDS.reports}/query`, 'POST', {
    page_size: limit,
    sorts: [{ timestamp: 'created_time', direction: 'descending' }],
  })
  return (data.results || []).map((page: any) => ({
    id: page.id,
    date: extractDate(page.properties?.Date) || page.created_time?.slice(0, 10) || '',
    summary: extractText(page.properties?.Summary),
  }))
}

export async function createReport(date: string, summary: string): Promise<void> {
  await notionFetch('/v1/pages', 'POST', {
    parent: { database_id: DB_IDS.reports },
    properties: {
      Date: { date: { start: date } },
      Summary: { title: [{ text: { content: summary } }] },
    },
  })
}

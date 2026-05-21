export interface Todo {
  id: string;
  name: string;
  status: boolean;
  priority: "High" | "Medium" | "Low";
  tags: string[];
  projectId?: string;
  dueDate?: string;
  createdTime?: string;
}

export interface Project {
  id: string;
  name: string;
  status: string;
}

export interface Report {
  id: string;
  date: string;
  summary?: string;
  content?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  timestamp: number;
}

export type Page = "today" | "projects" | "reports" | "chat";

export type Priority = "High" | "Medium" | "Low";

export interface AppSettings {
  notionToken: string;
  aiEndpoint: string;
  aiModel: string;
  theme: "dark" | "light";
}

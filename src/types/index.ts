export type TodoCategory = "工作" | "生活" | "项目";

export interface Todo {
  id: string;
  name: string;
  status: boolean;
  priority: "High" | "Medium" | "Low";
  tags: string[];
  category: TodoCategory;
  paused: boolean;
  projectId?: string;
  dueDate?: string;
  createdTime?: string;
}

export interface Project {
  id: string;
  name: string;
  status: string;
  archived?: boolean;
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

export type Page = "agenda" | "reports" | "goals";

export type Priority = "High" | "Medium" | "Low";

export type ThemeMode = "dark" | "light" | "auto";

export type AccentColor = "blue" | "purple" | "green" | "orange" | "red" | "pink";

export type FontSize = "small" | "medium" | "large";

export type GlassIntensity = "low" | "medium" | "high";

export interface AppSettings {
  notionToken: string;
  aiEndpoint: string;
  aiModel: string;
  theme: ThemeMode;
  accent: AccentColor;
  fontSize: FontSize;
  glass: GlassIntensity;
  transparency: number; // 0-175, 0=opaque, 175=very transparent
  kanbanEndpoint: string;
}

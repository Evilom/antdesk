import type { AppSettings } from "../types";

export function getLocalSettings(): Partial<AppSettings> {
  try {
    return JSON.parse(localStorage.getItem("antdesk_settings") || "{}");
  } catch {
    return {};
  }
}

export function getLocalNotionToken(): string {
  return (getLocalSettings().notionToken || "").trim();
}

export function getLocalAiEndpoint(): string {
  return (getLocalSettings().aiEndpoint || "").trim();
}

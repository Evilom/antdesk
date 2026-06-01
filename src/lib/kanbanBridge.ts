/**
 * kanbanBridge — Fetch kanban data from remote endpoint
 *
 * Supports two modes:
 * 1. Direct HTTP fetch from configurable URL (for remote devices)
 * 2. Tauri IPC command (for local, proxied through Rust)
 */

import { invoke } from "@tauri-apps/api/core";
import type { KanbanData } from "../types/kanban";
import { EMPTY_KANBAN } from "../types/kanban";

const POLL_INTERVAL = 30_000; // 30 seconds
const STORAGE_KEY = "antdesk_kanban_endpoint";

export type KanbanSource = "remote" | "local" | "disabled";

export interface KanbanBridgeOptions {
  /** Remote URL to fetch kanban JSON from */
  endpoint?: string;
  /** Data source mode */
  source?: KanbanSource;
  /** Poll interval in ms */
  interval?: number;
  /** Callback when new data arrives */
  onData?: (data: KanbanData) => void;
  /** Callback on error */
  onError?: (err: string) => void;
}

export class KanbanBridge {
  private endpoint: string;
  private source: KanbanSource;
  private interval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastData: KanbanData = EMPTY_KANBAN;
  private lastFetch = 0;
  private disposed = false;

  private onData?: (data: KanbanData) => void;
  private onError?: (err: string) => void;

  constructor(options: KanbanBridgeOptions = {}) {
    this.endpoint = options.endpoint || localStorage.getItem(STORAGE_KEY) || "";
    this.source = options.source || (this.endpoint ? "remote" : "disabled");
    this.interval = options.interval || POLL_INTERVAL;
    this.onData = options.onData;
    this.onError = options.onError;
  }

  /** Start polling */
  start() {
    if (this.disposed) return;
    this.fetchNow();
    this.timer = setInterval(() => this.fetchNow(), this.interval);
  }

  /** Stop polling */
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Dispose */
  dispose() {
    this.disposed = true;
    this.stop();
  }

  /** Update endpoint at runtime */
  setEndpoint(url: string) {
    this.endpoint = url;
    localStorage.setItem(STORAGE_KEY, url);
    this.source = url ? "remote" : "disabled";
    // Immediate fetch on endpoint change
    if (url) this.fetchNow();
  }

  /** Get current endpoint */
  getEndpoint(): string {
    return this.endpoint;
  }

  /** Get source mode */
  getSource(): KanbanSource {
    return this.source;
  }

  /** Get last fetched data */
  getData(): KanbanData {
    return this.lastData;
  }

  /** Force fetch now */
  async fetchNow() {
    if (this.disposed || this.source === "disabled") return;

    try {
      let data: KanbanData;

      if (this.source === "remote" && this.endpoint) {
        data = await this.fetchRemote();
      } else {
        // Try local Tauri command
        data = await this.fetchLocal();
      }

      this.lastData = data;
      this.lastFetch = Date.now();
      this.onData?.(data);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn("[KanbanBridge] fetch error:", msg);
      this.onError?.(msg);
    }
  }

  /** Fetch from remote HTTP endpoint */
  private async fetchRemote(): Promise<KanbanData> {
    const resp = await fetch(this.endpoint, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return resp.json();
  }

  /** Fetch via Tauri IPC (Rust proxies the request) */
  private async fetchLocal(): Promise<KanbanData> {
    try {
      const raw = await invoke<string>("fetch_kanban");
      return JSON.parse(raw);
    } catch {
      return EMPTY_KANBAN;
    }
  }
}

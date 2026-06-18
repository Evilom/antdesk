import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type WindowInteractionMode = "off" | "standard" | "enhanced";
export type DesktopCapability = "full" | "degraded" | "none";

export const WINDOW_INTERACTION_LABEL: Record<WindowInteractionMode, string> = {
  off: "安静工作",
  standard: "标准陪伴",
  enhanced: "玩耍增强",
};

export const WINDOW_INTERACTION_HINT: Record<WindowInteractionMode, string> = {
  off: "只保留基础移动，不读取外部窗口位置",
  standard: "感知窗口位置，轻量站立、避让和推动反馈",
  enhanced: "更明显的跳跃、滑动和窗口物理反馈",
};

export interface DesktopSurface {
  id: string;
  app: string;
  title?: string;
  kind: "external-window" | "antdesk-window";
  x: number;
  y: number;
  width: number;
  height: number;
  focused: boolean;
  zIndex: number;
}

export interface DesktopSurfaceResponse {
  surfaces: DesktopSurface[];
  sampledAtMs: number;
  capability: DesktopCapability;
  reason?: string;
}

export interface WorldSurface extends DesktopSurface {
  vx: number;
  vy: number;
  moving: boolean;
}

interface DesktopWorldBridgeOptions {
  mode: WindowInteractionMode;
  onSurfaces: (surfaces: WorldSurface[], meta: { capability: DesktopCapability; reason?: string }) => void;
  onError?: (error: unknown) => void;
}

const LEGACY_KEY = "antdesk_window_interaction";
const MODE_KEY = "antdesk_window_interaction_mode";

export function readWindowInteractionMode(): WindowInteractionMode {
  const stored = localStorage.getItem(MODE_KEY);
  if (stored === "off" || stored === "standard" || stored === "enhanced") return stored;
  return localStorage.getItem(LEGACY_KEY) === "true" ? "standard" : "off";
}

export function writeWindowInteractionMode(mode: WindowInteractionMode) {
  localStorage.setItem(MODE_KEY, mode);
  localStorage.setItem(LEGACY_KEY, String(mode !== "off"));
}

export function isWindowInteractionMode(value: unknown): value is WindowInteractionMode {
  return value === "off" || value === "standard" || value === "enhanced";
}

export function nextWindowInteractionMode(mode: WindowInteractionMode): WindowInteractionMode {
  if (mode === "off") return "standard";
  if (mode === "standard") return "enhanced";
  return "off";
}

export class DesktopWorldBridge {
  private mode: WindowInteractionMode;
  private onSurfaces: DesktopWorldBridgeOptions["onSurfaces"];
  private onError?: DesktopWorldBridgeOptions["onError"];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private prev = new Map<string, { x: number; y: number; sampledAtMs: number }>();
  private hotUntil = 0;

  constructor(options: DesktopWorldBridgeOptions) {
    this.mode = options.mode;
    this.onSurfaces = options.onSurfaces;
    this.onError = options.onError;
  }

  start() {
    this.disposed = false;
    this.schedule(0);
  }

  stop() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.prev.clear();
    this.onSurfaces([], { capability: "none", reason: "window interaction disabled" });
  }

  setMode(mode: WindowInteractionMode) {
    if (this.mode === mode) return;
    this.mode = mode;
    writeWindowInteractionMode(mode);
    if (mode === "off") {
      this.stop();
    } else if (this.disposed) {
      this.start();
    } else {
      this.schedule(0);
    }
  }

  private schedule(delayMs?: number) {
    if (this.timer) clearTimeout(this.timer);
    if (this.disposed || this.mode === "off") return;
    const interval = delayMs ?? (performance.now() < this.hotUntil ? 62 : 125);
    this.timer = setTimeout(() => void this.tick(), interval);
  }

  private async tick() {
    if (this.disposed || this.mode === "off") return;
    try {
      const response = await invoke<DesktopSurfaceResponse>("get_desktop_surfaces");
      const petRect = await this.readPetRect();
      const surfaces = response.surfaces
        .filter((surface) => surface.width >= 120 && surface.height >= 80)
        .slice(0, 24)
        .map((surface) => this.withVelocity(surface, response.sampledAtMs));

      const active = surfaces.some((s) => s.moving || this.isNearPet(s, petRect));
      if (active) this.hotUntil = performance.now() + 900;
      this.onSurfaces(surfaces, { capability: response.capability, reason: response.reason });
    } catch (error) {
      this.onError?.(error);
      this.onSurfaces([], { capability: "degraded", reason: "desktop surface sampling failed" });
    } finally {
      this.schedule();
    }
  }

  private withVelocity(surface: DesktopSurface, sampledAtMs: number): WorldSurface {
    const prev = this.prev.get(surface.id);
    this.prev.set(surface.id, { x: surface.x, y: surface.y, sampledAtMs });
    if (!prev) return { ...surface, vx: 0, vy: 0, moving: false };
    const dt = Math.max(0.016, Math.min(0.5, (sampledAtMs - prev.sampledAtMs) / 1000));
    const vx = (surface.x - prev.x) / dt;
    const vy = (surface.y - prev.y) / dt;
    const moving = Math.hypot(vx, vy) > 24;
    return { ...surface, vx, vy, moving };
  }

  private async readPetRect() {
    try {
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      const scale = window.devicePixelRatio || 1;
      return {
        x: pos.x / scale,
        y: pos.y / scale,
        width: size.width / scale,
        height: size.height / scale,
      };
    } catch {
      return null;
    }
  }

  private isNearPet(surface: WorldSurface, petRect: { x: number; y: number; width: number; height: number } | null) {
    if (!petRect) return false;
    const petCx = petRect.x + petRect.width / 2;
    const petCy = petRect.y + petRect.height / 2;
    const sx = Math.max(surface.x, Math.min(surface.x + surface.width, petCx));
    const sy = Math.max(surface.y, Math.min(surface.y + surface.height, petCy));
    return Math.hypot(petCx - sx, petCy - sy) < 160;
  }
}

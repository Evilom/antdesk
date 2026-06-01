/**
 * PhysicsEngine — Desktop pet roaming physics for AntDesk.
 *
 * Manages the pet window's position on screen with:
 * - Random walk (漫游)
 * - Screen edge collision (碰壁转向)
 * - Idle state (偶尔停下)
 * - Mouse attraction (趋向鼠标)
 * - Drag resume (拖拽后从新位置继续)
 *
 * The engine runs at ~30fps and moves the actual Tauri window via setPosition().
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type PetState = "idle" | "walk" | "dragged";

interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface PhysicsEngineOptions {
  /** Window width in logical pixels */
  windowWidth: number;
  /** Window height in logical pixels */
  windowHeight: number;
  /** Walk speed in pixels per second (logical) */
  walkSpeed?: number;
  /** How often to change direction (seconds) */
  directionChangeInterval?: number;
  /** Idle duration range [min, max] in seconds */
  idleDuration?: [number, number];
  /** Probability of entering idle per direction change */
  idleProbability?: number;
  /** Mouse attraction strength (0 = off, 1 = strong) */
  mouseAttraction?: number;
  /** Mouse attraction activation distance in pixels */
  mouseAttractionDistance?: number;
  /** Padding from screen edges in pixels */
  edgePadding?: number;
  /** Callback when state changes */
  onStateChange?: (state: PetState) => void;
  /** Callback when facing direction changes */
  onFacingChange?: (dir: 1 | -1) => void;
}

export class PhysicsEngine {
  // Position in physical screen coordinates
  private x = 0;
  private y = 0;
  private prevX = 0;
  private prevY = 0;

  // Velocity in logical pixels/sec
  private vx = 0;
  private vy = 0;

  // State
  private state: PetState = "idle";
  private running = false;
  private rafId = 0;
  private lastTime = 0;

  // Screen bounds (physical pixels)
  private bounds: ScreenBounds | null = null;

  // Direction timer
  private directionTimer = 0;
  private idleTimer = 0;

  // Mouse tracking
  private mouseX = 0;
  private mouseY = 0;
  private mouseInWindow = false;

  // Config
  private windowWidth: number;
  private windowHeight: number;
  private walkSpeed: number;
  private directionChangeInterval: number;
  private idleDurationMin: number;
  private idleDurationMax: number;
  private idleProbability: number;
  private mouseAttraction: number;
  private mouseAttractionDistance: number;
  private edgePadding: number;

  // Callbacks
  private onStateChange?: (state: PetState) => void;
  private onFacingChange?: (dir: 1 | -1) => void;

  // Bound handlers for cleanup
  private boundMouseMove: (e: MouseEvent) => void;
  private boundMouseEnter: () => void;
  private boundMouseLeave: () => void;

  constructor(options: PhysicsEngineOptions) {
    this.windowWidth = options.windowWidth;
    this.windowHeight = options.windowHeight;
    this.walkSpeed = options.walkSpeed ?? 40;
    this.directionChangeInterval = options.directionChangeInterval ?? 4;
    this.idleDurationMin = options.idleDuration?.[0] ?? 2;
    this.idleDurationMax = options.idleDuration?.[1] ?? 6;
    this.idleProbability = options.idleProbability ?? 0.3;
    this.mouseAttraction = options.mouseAttraction ?? 0.15;
    this.mouseAttractionDistance = options.mouseAttractionDistance ?? 300;
    this.edgePadding = options.edgePadding ?? 16;
    this.onStateChange = options.onStateChange;
    this.onFacingChange = options.onFacingChange;

    // Mouse tracking (relative to screen)
    this.boundMouseMove = (e: MouseEvent) => {
      // screenX/Y gives position relative to screen
      this.mouseX = e.screenX;
      this.mouseY = e.screenY;
    };
    this.boundMouseEnter = () => {
      this.mouseInWindow = true;
    };
    this.boundMouseLeave = () => {
      this.mouseInWindow = false;
    };
  }

  /**
   * Initialize: read current window position, fetch screen bounds, start loop.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Fetch screen bounds from Rust
    try {
      this.bounds = await invoke<ScreenBounds>("get_screen_bounds");
    } catch (e) {
      console.warn("[PhysicsEngine] Failed to get screen bounds:", e);
      // Fallback: assume 1920x1080
      this.bounds = { x: 0, y: 25, width: 1920, height: 990, scale: 1 };
    }

    // Read current window position
    try {
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      this.x = pos.x;
      this.y = pos.y;
    } catch (e) {
      console.warn("[PhysicsEngine] Failed to read window position:", e);
    }

    // Start in walk state with random direction
    this.setRandomDirection();
    this.setState("walk");

    // Add mouse listeners
    document.addEventListener("mousemove", this.boundMouseMove);
    document.addEventListener("mouseenter", this.boundMouseEnter);
    document.addEventListener("mouseleave", this.boundMouseLeave);

    // Start loop
    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.rafId = requestAnimationFrame(this.tick.bind(this));

    console.log("[PhysicsEngine] Started at", this.x, this.y);
  }

  /**
   * Stop the engine (e.g. when locked or hidden).
   */
  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    document.removeEventListener("mousemove", this.boundMouseMove);
    document.removeEventListener("mouseenter", this.boundMouseEnter);
    document.removeEventListener("mouseleave", this.boundMouseLeave);
  }

  /**
   * Call when drag starts — pauses physics.
   */
  onDragStart(): void {
    this.setState("dragged");
  }

  /**
   * Call when drag ends — resume roaming from new position.
   */
  async onDragEnd(): Promise<void> {
    // Read new window position
    try {
      const win = getCurrentWindow();
      const pos = await win.outerPosition();
      this.x = pos.x;
      this.y = pos.y;
    } catch {}

    // Refresh bounds
    try {
      this.bounds = await invoke<ScreenBounds>("get_screen_bounds");
    } catch {}

    this.setRandomDirection();
    this.setState("walk");
  }

  /**
   * Update window dimensions when size changes.
   */
  updateWindowSize(w: number, h: number): void {
    this.windowWidth = w;
    this.windowHeight = h;
  }

  /**
   * Update engine parameters at runtime (e.g. mode-based speed/idle changes).
   */
  configure(options: Partial<PhysicsEngineOptions>): void {
    if (options.walkSpeed !== undefined) this.walkSpeed = options.walkSpeed;
    if (options.directionChangeInterval !== undefined) this.directionChangeInterval = options.directionChangeInterval;
    if (options.idleDuration !== undefined) {
      this.idleDurationMin = options.idleDuration[0];
      this.idleDurationMax = options.idleDuration[1];
    }
    if (options.idleProbability !== undefined) this.idleProbability = options.idleProbability;
    if (options.mouseAttraction !== undefined) this.mouseAttraction = options.mouseAttraction;
    if (options.mouseAttractionDistance !== undefined) this.mouseAttractionDistance = options.mouseAttractionDistance;
    if (options.edgePadding !== undefined) this.edgePadding = options.edgePadding;
  }

  /** Current state */
  getState(): PetState {
    return this.state;
  }

  // ── Internal ──

  private setState(state: PetState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  private setRandomDirection(): void {
    const angle = Math.random() * Math.PI * 2;
    this.vx = Math.cos(angle) * this.walkSpeed;
    this.vy = Math.sin(angle) * this.walkSpeed;
    this.directionTimer =
      this.directionChangeInterval * (0.7 + Math.random() * 0.6);

    // Notify facing direction
    this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
  }

  private tick(nowMs: number): void {
    if (!this.running) return;

    const now = nowMs / 1000;
    const dt = Math.min(now - this.lastTime, 0.1); // Cap at 100ms
    this.lastTime = now;

    if (this.state === "dragged") {
      // Don't update physics while dragged
      this.rafId = requestAnimationFrame(this.tick.bind(this));
      return;
    }

    if (this.state === "idle") {
      this.idleTimer -= dt;
      if (this.idleTimer <= 0) {
        this.setRandomDirection();
        this.setState("walk");
      }
      this.rafId = requestAnimationFrame(this.tick.bind(this));
      return;
    }

    // Walk state
    this.directionTimer -= dt;
    if (this.directionTimer <= 0) {
      // Chance to go idle
      if (Math.random() < this.idleProbability) {
        this.vx = 0;
        this.vy = 0;
        this.idleTimer =
          this.idleDurationMin +
          Math.random() * (this.idleDurationMax - this.idleDurationMin);
        this.setState("idle");
        this.rafId = requestAnimationFrame(this.tick.bind(this));
        return;
      }
      this.setRandomDirection();
    }

    // Apply mouse attraction (gentle pull toward cursor)
    if (this.mouseAttraction > 0 && this.bounds) {
      const scale = this.bounds.scale;
      const petCenterX = this.x + (this.windowWidth * scale) / 2;
      const petCenterY = this.y + (this.windowHeight * scale) / 2;
      const dx = this.mouseX - petCenterX;
      const dy = this.mouseY - petCenterY;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < this.mouseAttractionDistance * scale && dist > 10) {
        const strength =
          this.mouseAttraction * (1 - dist / (this.mouseAttractionDistance * scale));
        this.vx += (dx / dist) * strength * this.walkSpeed;
        this.vy += (dy / dist) * strength * this.walkSpeed;

        // Clamp speed
        const speed = Math.sqrt(this.vx * this.vx + this.vy * this.vy);
        if (speed > this.walkSpeed * 1.5) {
          this.vx = (this.vx / speed) * this.walkSpeed * 1.5;
          this.vy = (this.vy / speed) * this.walkSpeed * 1.5;
        }
      }
    }

    // Move
    let newX = this.x + this.vx * dt;
    let newY = this.y + this.vy * dt;

    // Boundary collision
    if (this.bounds) {
      const scale = this.bounds.scale;
      const pad = this.edgePadding * scale;
      const winW = this.windowWidth * scale;
      const winH = this.windowHeight * scale;

      const minX = this.bounds.x + pad;
      const maxX = this.bounds.x + this.bounds.width - winW - pad;
      const minY = this.bounds.y + pad;
      const maxY = this.bounds.y + this.bounds.height - winH - pad;

      let bounced = false;

      if (newX < minX) {
        newX = minX;
        this.vx = Math.abs(this.vx);
        bounced = true;
      } else if (newX > maxX) {
        newX = maxX;
        this.vx = -Math.abs(this.vx);
        bounced = true;
      }

      if (newY < minY) {
        newY = minY;
        this.vy = Math.abs(this.vy);
        bounced = true;
      } else if (newY > maxY) {
        newY = maxY;
        this.vy = -Math.abs(this.vy);
        bounced = true;
      }

      if (bounced) {
        // Add some randomness to bounce direction
        this.vx += (Math.random() - 0.5) * this.walkSpeed * 0.3;
        this.vy += (Math.random() - 0.5) * this.walkSpeed * 0.3;
        this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
      }
    }

    this.x = newX;
    this.y = newY;

    // Only update window position if moved enough (>0.5 physical pixel)
    const dx = Math.abs(Math.round(this.x) - Math.round(this.prevX));
    const dy = Math.abs(Math.round(this.y) - Math.round(this.prevY));
    if (dx >= 1 || dy >= 1) {
      this.prevX = this.x;
      this.prevY = this.y;
      const win = getCurrentWindow();
      win.setPosition({
        type: "Physical",
        x: Math.round(this.x),
        y: Math.round(this.y),
      } as any).catch(() => {});
    }

    this.rafId = requestAnimationFrame(this.tick.bind(this));
  }
}

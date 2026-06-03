/**
 * PhysicsEngine — Desktop pet roaming physics with gravity & surface walking.
 *
 * Coordinate system: **logical pixels** (matches Tauri LogicalPosition).
 * This is critical for consistency with the drag handler.
 *
 * Surface model (simplified — no wall walking):
 *   - Pet walks horizontally on surfaces (screen ground, window tops)
 *   - Gravity pulls pet down after drag release
 *   - Landing on any surface → brief dizzy state
 *   - Anti-stuck: random kick when velocity hits zero at edge
 *   - Safety: every tick clamps position to visible screen area
 *
 * States:
 *   idle    — standing on surface, pausing
 *   walk    — walking horizontally on surface
 *   falling — in the air, gravity pulling down
 *   dizzy   — stunned after landing (brief)
 *   dragged — held by user (physics paused)
 */

import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type PetState = "idle" | "walk" | "falling" | "dizzy" | "dragged";
export type SurfaceSide = "top";

interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

export interface Platform {
  /** Left edge in logical px */
  x: number;
  /** Top edge — where pet window top sits in logical px */
  y: number;
  /** Width in logical px */
  width: number;
  /** Height in logical px (for future wall walk) */
  height: number;
  source: "screen" | "window";
  name?: string;
}

export interface PhysicsEngineOptions {
  windowWidth: number;
  windowHeight: number;
  walkSpeed?: number;
  directionChangeInterval?: number;
  idleDuration?: [number, number];
  idleProbability?: number;
  mouseAttraction?: number;
  mouseAttractionDistance?: number;
  edgePadding?: number;
  gravity?: number;
  dizzyDuration?: number;
  bounceFactor?: number;
  onStateChange?: (state: PetState) => void;
  onFacingChange?: (dir: 1 | -1) => void;
  onSurfaceChange?: (side: SurfaceSide) => void;
}

export class PhysicsEngine {
  // Position in logical screen coordinates
  private x = 0;
  private y = 0;
  private prevX = 0;
  private prevY = 0;

  // Velocity in logical px/sec
  private vx = 0;
  private vy = 0;

  // State
  private state: PetState = "idle";
  private running = false;
  private rafId = 0;
  private lastTime = 0;

  // Surface
  private bounds: ScreenBounds | null = null;
  /** Ground Y in logical px (top of window when pet is on screen floor) */
  private groundY = 0;
  /** Active extra platforms from window tops (logical px) */
  private platforms: Platform[] = [];

  // Timers
  private directionTimer = 0;
  private idleTimer = 0;
  private dizzyTimer = 0;

  // Mouse
  private mouseX = 0;
  private mouseY = 0;

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
  private gravity: number;
  private dizzyDuration: number;
  private bounceFactor: number;

  // Callbacks
  private onStateChange?: (state: PetState) => void;
  private onFacingChange?: (dir: 1 | -1) => void;
  private onSurfaceChange?: (side: SurfaceSide) => void;

  // Bound handler
  private boundMouseMove: (e: MouseEvent) => void;

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
    this.edgePadding = options.edgePadding ?? 2;
    this.gravity = options.gravity ?? 900;
    this.dizzyDuration = options.dizzyDuration ?? 1.5;
    this.bounceFactor = options.bounceFactor ?? 0.3;
    this.onStateChange = options.onStateChange;
    this.onFacingChange = options.onFacingChange;
    this.onSurfaceChange = options.onSurfaceChange;

    this.boundMouseMove = (e: MouseEvent) => {
      this.mouseX = e.screenX;
      this.mouseY = e.screenY;
    };
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Fetch screen bounds (physical px) → convert to logical
    try {
      const raw = await invoke<ScreenBounds>("get_screen_bounds");
      this.bounds = {
        x: raw.x / raw.scale,
        y: raw.y / raw.scale,
        width: raw.width / raw.scale,
        height: raw.height / raw.scale,
        scale: raw.scale,
      };
    } catch {
      this.bounds = { x: 0, y: 25, width: 1920, height: 990, scale: 1 };
    }

    this.recomputeGround();

    // Read current window position (logical)
    try {
      // outerPosition returns physical, convert to logical
      const pos = await getCurrentWindow().outerPosition();
      this.x = pos.x / (this.bounds?.scale ?? 1);
      this.y = pos.y / (this.bounds?.scale ?? 1);
    } catch {}

    // Snap to ground if close
    if (Math.abs(this.y - this.groundY) < 10) {
      this.y = this.groundY;
    }

    this.setHorizontalRandomDirection();
    this.setState("walk");

    document.addEventListener("mousemove", this.boundMouseMove);
    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.rafId = requestAnimationFrame(this.tick.bind(this));
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    document.removeEventListener("mousemove", this.boundMouseMove);
  }

  configure(opts: Partial<PhysicsEngineOptions>): void {
    if (opts.walkSpeed !== undefined) this.walkSpeed = opts.walkSpeed;
    if (opts.gravity !== undefined) this.gravity = opts.gravity;
    if (opts.idleProbability !== undefined) this.idleProbability = opts.idleProbability;
    if (opts.mouseAttraction !== undefined) this.mouseAttraction = opts.mouseAttraction;
  }

  // ── Platform API ──

  /** Set platforms (already in logical px). */
  setPlatforms(platforms: Platform[]): void {
    this.platforms = platforms;
  }

  /** Refresh platforms (already in logical px). If current platform gone, fall. */
  refreshPlatforms(newPlatforms: Platform[]): void {
    this.platforms = newPlatforms;
  }

  // ── Drag support ──

  onDragStart(): void {
    this.setState("dragged");
  }

  /**
   * Called on mouseup after drag.
   * vx/vy are release velocity in logical px/sec (from screen delta).
   * Window position is read fresh to get the actual post-drag position.
   */
  onDragEnd(vx: number, vy: number): void {
    this.vx = vx * 0.4;
    this.vy = vy * 0.3;

    // Read current window position (convert physical → logical)
    getCurrentWindow().outerPosition().then(pos => {
      const scale = this.bounds?.scale ?? 1;
      this.x = pos.x / scale;
      this.y = pos.y / scale;
      this.setState("falling");
    }).catch(() => {
      this.setState("falling");
    });
  }

  getState(): PetState { return this.state; }

  // ── Private ──

  private setState(s: PetState): void {
    if (s === this.state) return;
    this.state = s;
    this.onStateChange?.(s);
  }

  private recomputeGround(): void {
    if (!this.bounds) return;
    this.groundY = this.bounds.y + this.bounds.height - this.windowHeight - this.edgePadding;
  }

  private setHorizontalRandomDirection(): void {
    this.vx = (Math.random() > 0.5 ? 1 : -1) * this.walkSpeed;
    this.vy = 0;
    this.directionTimer = this.directionChangeInterval * (0.7 + Math.random() * 0.6);
    this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
  }

  private tick(nowMs: number): void {
    if (!this.running) return;

    const now = nowMs / 1000;
    const dt = Math.min(now - this.lastTime, 0.1);
    this.lastTime = now;

    switch (this.state) {
      case "dragged": break;
      case "dizzy":   this.tickDizzy(dt); break;
      case "falling": this.tickFalling(dt); break;
      case "idle":    this.tickIdle(dt); break;
      case "walk":    this.tickWalk(dt); break;
    }

    // SAFETY: clamp to visible screen every tick
    this.safetyClamp();

    this.rafId = requestAnimationFrame(this.tick.bind(this));
  }

  // ── State tick handlers ──

  private tickDizzy(dt: number): void {
    this.y = this.groundY;
    this.dizzyTimer -= dt;
    if (this.dizzyTimer <= 0) {
      this.setHorizontalRandomDirection();
      this.setState("walk");
    }
  }

  private tickIdle(dt: number): void {
    this.y = this.groundY;
    this.idleTimer -= dt;
    if (this.idleTimer <= 0) {
      this.setHorizontalRandomDirection();
      this.setState("walk");
    }
  }

  private tickWalk(dt: number): void {
    this.y = this.groundY;

    // Direction timer
    this.directionTimer -= dt;
    if (this.directionTimer <= 0) {
      if (Math.random() < this.idleProbability) {
        this.vx = 0;
        this.idleTimer = this.idleDurationMin +
          Math.random() * (this.idleDurationMax - this.idleDurationMin);
        this.setState("idle");
        return;
      }
      this.setHorizontalRandomDirection();
    }

    // Mouse attraction (horizontal)
    if (this.mouseAttraction > 0) {
      const petCenterX = this.x + this.windowWidth / 2;
      const dx = this.mouseX - petCenterX;
      const dist = Math.abs(dx);

      if (dist < this.mouseAttractionDistance && dist > 10) {
        const strength = this.mouseAttraction * (1 - dist / this.mouseAttractionDistance);
        this.vx += Math.sign(dx) * strength * this.walkSpeed;
        const max = this.walkSpeed * 1.5;
        if (Math.abs(this.vx) > max) this.vx = Math.sign(this.vx) * max;
      }
    }

    // Move horizontally
    let newX = this.x + this.vx * dt;

    // Wall bounce
    const clampedX = this.clampHorizontal(newX);
    if (clampedX !== newX) {
      this.vx = -this.vx;
      this.vx += (Math.random() - 0.5) * this.walkSpeed * 0.3;
      // Anti-stuck: if velocity too small, give a kick
      if (Math.abs(this.vx) < this.walkSpeed * 0.2) {
        this.vx = (Math.random() > 0.5 ? 1 : -1) * this.walkSpeed * 0.6;
      }
      this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
    }
    this.x = clampedX;

    this.moveWindow();
  }

  private tickFalling(dt: number): void {
    // Apply gravity
    this.vy += this.gravity * dt;

    // Air resistance
    this.vx *= 0.995;

    // Move
    let newX = this.x + this.vx * dt;
    let newY = this.y + this.vy * dt;

    // Check platform collision (window tops)
    let landY = this.groundY;
    for (const p of this.platforms) {
      if (p.y >= this.groundY) continue;
      const prevBottom = this.y + this.windowHeight;
      const newBottom = newY + this.windowHeight;
      if (prevBottom <= p.y + 4 && newBottom >= p.y - 4) {
        const cx = newX + this.windowWidth / 2;
        if (cx >= p.x - 20 && cx <= p.x + p.width + 20) {
          if (p.y < landY) landY = p.y;
        }
      }
    }

    // Ground collision
    if (newY >= landY) {
      newY = landY;

      if (this.vy > 50 && landY === this.groundY) {
        // Bounce
        this.vy = -this.vy * this.bounceFactor;
        this.vx *= 0.8;
      } else {
        // Landed
        this.vy = 0;
        this.y = landY;
        this.x = this.clampHorizontal(newX);
        this.dizzyTimer = this.dizzyDuration;
        this.vx = 0;
        this.setState("dizzy");
        return;
      }
    }

    this.x = this.clampHorizontal(newX);
    this.y = newY;
    this.moveWindow();
  }

  /** Clamp X to screen edges */
  private clampHorizontal(newX: number): number {
    if (!this.bounds) return newX;
    const pad = this.edgePadding;
    const minX = this.bounds.x + pad;
    const maxX = this.bounds.x + this.bounds.width - this.windowWidth - pad;
    return Math.max(minX, Math.min(maxX, newX));
  }

  /** Safety: if pet somehow escaped visible area, reset to ground center */
  private safetyClamp(): void {
    if (!this.bounds) return;
    const b = this.bounds;
    const margin = 50; // generous margin
    const minX = b.x - margin;
    const maxX = b.x + b.width + margin;
    const minY = b.y - margin;
    const maxY = b.y + b.height + margin;

    if (this.x < minX || this.x > maxX || this.y < minY || this.y > maxY) {
      console.warn("[Physics] Pet escaped screen! Resetting.", { x: this.x, y: this.y });
      this.x = b.x + b.width / 2 - this.windowWidth / 2;
      this.y = this.groundY;
      this.vx = 0;
      this.vy = 0;
      this.setState("falling");
      this.moveWindow();
    }
  }

  /** Move the Tauri window (using LogicalPosition) */
  private moveWindow(): void {
    const dx = Math.abs(Math.round(this.x) - Math.round(this.prevX));
    const dy = Math.abs(Math.round(this.y) - Math.round(this.prevY));
    if (dx >= 1 || dy >= 1) {
      this.prevX = this.x;
      this.prevY = this.y;
      // Import dynamically to avoid circular dependency issues

      getCurrentWindow().setPosition(
        new LogicalPosition(Math.round(this.x), Math.round(this.y))
      ).catch(() => {});
    }
  }
}

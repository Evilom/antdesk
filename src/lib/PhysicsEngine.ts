/**
 * PhysicsEngine — Desktop pet roaming physics with gravity & surface walking.
 *
 * Surface model:
 *   - Pet walks on screen bottom edge (ground level)
 *   - After drag release, gravity pulls pet down to ground
 *   - Landing triggers brief dizzy state
 *
 * States:
 *   idle    — standing on ground, pausing
 *   walk    — walking horizontally on ground
 *   falling — in the air, gravity pulling down
 *   dizzy   — stunned after landing (brief)
 *   dragged — held by user (physics paused)
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type PetState = "idle" | "walk" | "falling" | "dizzy" | "dragged";

interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
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
  /** Gravity in logical px/s² (default 900) */
  gravity?: number;
  /** Dizzy duration in seconds after landing (default 1.5) */
  dizzyDuration?: number;
  /** Bounce factor on landing 0-1 (default 0.3) */
  bounceFactor?: number;
  onStateChange?: (state: PetState) => void;
  onFacingChange?: (dir: 1 | -1) => void;
}

export class PhysicsEngine {
  // Position in physical screen coordinates
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
  /** Ground Y in physical pixels (top of window when pet is on floor) */
  private groundY = 0;

  // Timers
  private directionTimer = 0;
  private idleTimer = 0;
  private dizzyTimer = 0;

  // Mouse
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
  private gravity: number;
  private dizzyDuration: number;
  private bounceFactor: number;

  // Callbacks
  private onStateChange?: (state: PetState) => void;
  private onFacingChange?: (dir: 1 | -1) => void;

  // Bound handlers
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
    this.gravity = options.gravity ?? 900;
    this.dizzyDuration = options.dizzyDuration ?? 1.5;
    this.bounceFactor = options.bounceFactor ?? 0.3;
    this.onStateChange = options.onStateChange;
    this.onFacingChange = options.onFacingChange;

    this.boundMouseMove = (e: MouseEvent) => {
      this.mouseX = e.screenX;
      this.mouseY = e.screenY;
    };
    this.boundMouseEnter = () => { this.mouseInWindow = true; };
    this.boundMouseLeave = () => { this.mouseInWindow = false; };
  }

  async start(): Promise<void> {
    if (this.running) return;

    // Fetch screen bounds
    try {
      this.bounds = await invoke<ScreenBounds>("get_screen_bounds");
    } catch (e) {
      console.warn("[Physics] get_screen_bounds failed:", e);
      this.bounds = { x: 0, y: 25, width: 1920, height: 990, scale: 1 };
    }

    // Compute ground level
    this.recomputeGround();

    // Read current window position
    try {
      const pos = await getCurrentWindow().outerPosition();
      this.x = pos.x;
      this.y = pos.y;
    } catch {}

    // Snap to ground if close
    if (Math.abs(this.y - this.groundY) < 10 * (this.bounds?.scale ?? 1)) {
      this.y = this.groundY;
    }

    // Start walking on ground
    this.setHorizontalRandomDirection();
    this.setState("walk");

    document.addEventListener("mousemove", this.boundMouseMove);
    document.addEventListener("mouseenter", this.boundMouseEnter);
    document.addEventListener("mouseleave", this.boundMouseLeave);

    this.running = true;
    this.lastTime = performance.now() / 1000;
    this.rafId = requestAnimationFrame(this.tick.bind(this));
    console.log("[Physics] started, ground Y:", this.groundY);
  }

  stop(): void {
    this.running = false;
    if (this.rafId) { cancelAnimationFrame(this.rafId); this.rafId = 0; }
    document.removeEventListener("mousemove", this.boundMouseMove);
    document.removeEventListener("mouseenter", this.boundMouseEnter);
    document.removeEventListener("mouseleave", this.boundMouseLeave);
  }

  /** Call when drag starts — pause physics */
  onDragStart(): void {
    this.setState("dragged");
  }

  /** Call when drag ends — enter falling state with release velocity */
  onDragEnd(releaseVxLogical = 0, releaseVyLogical = 0): void {
    // Read current window position
    getCurrentWindow().outerPosition().then((pos) => {
      this.x = pos.x;
      this.y = pos.y;

      // Apply release velocity (dampened)
      this.vx = releaseVxLogical * 0.4;
      this.vy = releaseVyLogical * 0.3;

      // If above ground → fall; if on ground → idle
      if (this.y < this.groundY - 2) {
        this.setState("falling");
      } else {
        this.y = this.groundY;
        this.vy = 0;
        this.setHorizontalRandomDirection();
        this.setState("walk");
      }
    }).catch(() => {});
  }

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
    if (options.gravity !== undefined) this.gravity = options.gravity;
    if (options.dizzyDuration !== undefined) this.dizzyDuration = options.dizzyDuration;
  }

  getState(): PetState { return this.state; }

  // ── Internal ──

  private setState(state: PetState): void {
    if (this.state === state) return;
    this.state = state;
    this.onStateChange?.(state);
  }

  private recomputeGround(): void {
    if (!this.bounds) return;
    const scale = this.bounds.scale;
    const pad = this.edgePadding * scale;
    const winH = this.windowHeight * scale;
    this.groundY = this.bounds.y + this.bounds.height - winH - pad;
  }

  /** Set horizontal-only random direction (for ground walking) */
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
      case "dragged":
        // Physics paused
        break;

      case "dizzy":
        this.tickDizzy(dt);
        break;

      case "falling":
        this.tickFalling(dt);
        break;

      case "idle":
        this.tickIdle(dt);
        break;

      case "walk":
        this.tickWalk(dt);
        break;
    }

    this.rafId = requestAnimationFrame(this.tick.bind(this));
  }

  // ── State tick handlers ──

  private tickDizzy(dt: number): void {
    this.dizzyTimer -= dt;
    if (this.dizzyTimer <= 0) {
      this.setHorizontalRandomDirection();
      this.setState("walk");
    }
  }

  private tickFalling(dt: number): void {
    const scale = this.bounds?.scale ?? 1;
    const g = this.gravity * scale; // gravity in physical px/s²

    // Apply gravity to vertical velocity
    this.vy += g * dt;

    // Decay horizontal velocity (air resistance)
    this.vx *= 0.995;

    // Move
    let newX = this.x + this.vx * dt;
    let newY = this.y + this.vy * dt;

    // Check ground collision
    if (newY >= this.groundY) {
      newY = this.groundY;

      // Bounce if falling fast enough
      if (this.vy > 50 * scale) {
        this.vy = -this.vy * this.bounceFactor;
        this.vx *= 0.8;
        // Small bounce — will land next frame
      } else {
        // Landed
        this.vy = 0;
        this.y = this.groundY;

        // Wall bounce
        this.clampHorizontal(newX);

        // Enter dizzy state
        this.dizzyTimer = this.dizzyDuration;
        this.vx = 0;
        this.setState("dizzy");
        return;
      }
    }

    // Screen edge bounce (horizontal)
    this.x = this.clampHorizontal(newX);
    this.y = newY;

    this.moveWindow();
  }

  private tickIdle(dt: number): void {
    // Lock to ground
    this.y = this.groundY;
    this.idleTimer -= dt;
    if (this.idleTimer <= 0) {
      this.setHorizontalRandomDirection();
      this.setState("walk");
    }
  }

  private tickWalk(dt: number): void {
    // Lock to ground
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

    // Mouse attraction (horizontal only on ground)
    if (this.mouseAttraction > 0 && this.bounds) {
      const scale = this.bounds.scale;
      const petCenterX = this.x + (this.windowWidth * scale) / 2;
      const dx = this.mouseX - petCenterX;
      const dist = Math.abs(dx);

      if (dist < this.mouseAttractionDistance * scale && dist > 10) {
        const strength = this.mouseAttraction * (1 - dist / (this.mouseAttractionDistance * scale));
        this.vx += Math.sign(dx) * strength * this.walkSpeed;

        const maxSpeed = this.walkSpeed * 1.5;
        if (Math.abs(this.vx) > maxSpeed) {
          this.vx = Math.sign(this.vx) * maxSpeed;
        }
      }
    }

    // Move horizontally
    let newX = this.x + this.vx * dt;

    // Wall bounce
    const clampedX = this.clampHorizontal(newX);
    if (clampedX !== newX) {
      this.vx = -this.vx;
      this.vx += (Math.random() - 0.5) * this.walkSpeed * 0.3;
      this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
    }
    this.x = clampedX;

    this.moveWindow();
  }

  /** Clamp X to screen edges, return clamped value */
  private clampHorizontal(newX: number): number {
    if (!this.bounds) return newX;
    const scale = this.bounds.scale;
    const pad = this.edgePadding * scale;
    const winW = this.windowWidth * scale;
    const minX = this.bounds.x + pad;
    const maxX = this.bounds.x + this.bounds.width - winW - pad;
    return Math.max(minX, Math.min(maxX, newX));
  }

  /** Move the Tauri window if position changed enough */
  private moveWindow(): void {
    const dx = Math.abs(Math.round(this.x) - Math.round(this.prevX));
    const dy = Math.abs(Math.round(this.y) - Math.round(this.prevY));
    if (dx >= 1 || dy >= 1) {
      this.prevX = this.x;
      this.prevY = this.y;
      getCurrentWindow().setPosition({
        type: "Physical",
        x: Math.round(this.x),
        y: Math.round(this.y),
      } as any).catch(() => {});
    }
  }
}

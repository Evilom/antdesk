/**
 * PhysicsEngine — Desktop pet roaming physics with gravity & surface walking.
 *
 * Surface model:
 *   - Pet walks on screen edges AND optionally on top of application windows
 *   - After drag release, gravity pulls pet down to nearest surface
 *   - Landing triggers brief dizzy state
 *   - Walking off a window edge → falling to next surface below
 *
 * States:
 *   idle    — standing on surface, pausing
 *   walk    — walking horizontally on surface
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

/** A surface the pet can walk on (screen edge or window top). */
export interface Platform {
  x: number;      // Left edge (physical px)
  y: number;      // Top edge — where pet window top sits (physical px)
  width: number;  // Width (physical px)
  source: "screen" | "window";
  name?: string;  // Window name (for window platforms)
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
  /** Ground Y in physical pixels (top of window when pet is on screen floor) */
  private groundY = 0;
  /** Active extra platforms from window tops */
  private platforms: Platform[] = [];
  /** The platform the pet is currently standing on (null = screen ground) */
  private currentPlatform: Platform | null = null;
  /** Last known position of currentPlatform (to detect window movement) */
  private lastPlatformPos: { x: number; y: number; w: number } | null = null;

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

    // Fetch screen bounds (physical pixels)
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
  }

  stop(): void {
    this.running = false;
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    document.removeEventListener("mousemove", this.boundMouseMove);
    document.removeEventListener("mouseenter", this.boundMouseEnter);
    document.removeEventListener("mouseleave", this.boundMouseLeave);
  }

  configure(opts: Partial<PhysicsEngineOptions>): void {
    if (opts.walkSpeed !== undefined) this.walkSpeed = opts.walkSpeed;
    if (opts.gravity !== undefined) this.gravity = opts.gravity;
    if (opts.idleProbability !== undefined) this.idleProbability = opts.idleProbability;
    if (opts.mouseAttraction !== undefined) this.mouseAttraction = opts.mouseAttraction;
  }

  // ── Platform API ──

  /** Set active window-top platforms. Screen ground is always implicit. */
  setPlatforms(platforms: Platform[]): void {
    this.platforms = platforms;
  }

  /**
   * Refresh platforms after window positions change.
   * Handles: window moved (pet follows), window closed (pet falls).
   */
  refreshPlatforms(newPlatforms: Platform[]): void {
    this.platforms = newPlatforms;

    if (!this.currentPlatform || this.currentPlatform.source === "screen") return;

    // Find the same window in updated platforms
    const updated = newPlatforms.find(
      p => p.source === "window" && p.name === this.currentPlatform!.name
    );

    if (updated) {
      // Window still exists — check if it moved
      if (this.lastPlatformPos) {
        const dx = updated.x - this.lastPlatformPos.x;
        const dy = updated.y - this.lastPlatformPos.y;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
          // Window moved — shift pet with it
          this.x += dx;
          this.y += dy;
          this.clampToScreen();
          if (this.state !== "dragged") this.moveWindow();
        }
      }
      // Update tracked position
      this.currentPlatform = updated;
      this.lastPlatformPos = { x: updated.x, y: updated.y, w: updated.width };
    } else {
      // Window closed/moved off-screen — fall!
      this.currentPlatform = null;
      this.lastPlatformPos = null;
      if (this.state !== "dragged") {
        this.vx *= 0.3; // Lose momentum
        this.vy = 0;
        this.setState("falling");
      }
    }
  }

  // ── Drag support ──

  onDragStart(): void {
    this.setState("dragged");
  }

  onDragEnd(vx: number, vy: number): void {
    // Use release velocity (dampened)
    this.vx = vx * 0.4;
    this.vy = vy * 0.3;

    // Update position from actual window pos
    getCurrentWindow().outerPosition().then(pos => {
      this.x = pos.x;
      this.y = pos.y;
      // After drag, enter falling state — gravity pulls to nearest surface
      this.currentPlatform = null;
      this.lastPlatformPos = null;
      this.setState("falling");
    }).catch(() => {
      this.setState("falling");
    });
  }

  /** Get current state (for external reads) */
  getState(): PetState { return this.state; }

  // ── Private ──

  private setState(s: PetState): void {
    if (s === this.state) return;
    this.state = s;
    this.onStateChange?.(s);
  }

  /** Find the nearest platform surface at or below current position within X range. */
  private findLandingPlatform(physicalX: number, physicalBottom: number): Platform | null {
    let best: Platform | null = null;
    let bestDist = Infinity;

    for (const p of this.platforms) {
      const pBottom = p.y; // Platform surface Y (where pet top sits)
      if (pBottom < physicalBottom - 2) continue; // Platform must be below pet

      const petCenterX = physicalX + (this.windowWidth * (this.bounds?.scale ?? 1)) / 2;
      if (petCenterX < p.x - 20 || petCenterX > p.x + p.width + 20) continue;

      const dist = pBottom - physicalBottom;
      if (dist < bestDist) {
        bestDist = dist;
        best = p;
      }
    }
    return best;
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
    const winH = this.windowHeight * scale;
    const petBottom = newY + winH;

    // Check platform collision (window tops + screen ground)
    let landedOn: Platform | null = null;
    let landY = this.groundY;

    for (const p of this.platforms) {
      const platY = p.y;
      if (platY >= this.groundY) continue; // Skip if below screen ground

      const prevBottom = this.y + winH;
      if (prevBottom <= platY + 2 && petBottom >= platY - 2) {
        const petCenterX = newX + winH / 2;
        if (petCenterX >= p.x - 10 && petCenterX <= p.x + p.width + 10) {
          if (platY < landY) {
            landY = platY;
            landedOn = p;
          }
        }
      }
    }

    // Check screen ground collision
    if (newY >= this.groundY && !landedOn) {
      landedOn = { x: this.bounds?.x ?? 0, y: this.groundY, width: this.bounds?.width ?? 1920, source: "screen" };
      landY = this.groundY;
    }

    if (landedOn) {
      newY = landY;

      // Bounce if falling fast enough
      if (this.vy > 50 * scale && landedOn.source === "screen") {
        this.vy = -this.vy * this.bounceFactor;
        this.vx *= 0.8;
        // Small bounce — will land next frame
      } else {
        // Landed
        this.vy = 0;
        this.y = landY;

        // Record landing platform
        this.currentPlatform = landedOn;
        if (landedOn.source === "window") {
          this.lastPlatformPos = { x: landedOn.x, y: landedOn.y, w: landedOn.width };
        } else {
          this.lastPlatformPos = null;
        }

        // Wall bounce
        this.x = this.clampHorizontal(newX);

        // Enter dizzy state
        this.dizzyTimer = this.dizzyDuration;
        this.vx = 0;
        this.setState("dizzy");
        return;
      }
    }

    // Screen edge bounce (horizontal) while falling
    this.x = this.clampHorizontal(newX);
    this.y = newY;

    this.moveWindow();
  }

  private tickIdle(dt: number): void {
    // Lock to current surface
    const surfaceY = this.currentPlatform ? this.currentPlatform.y : this.groundY;
    this.y = surfaceY;

    this.idleTimer -= dt;
    if (this.idleTimer <= 0) {
      this.setHorizontalRandomDirection();
      this.setState("walk");
    }
  }

  private tickWalk(dt: number): void {
    // Lock to current surface
    const surfaceY = this.currentPlatform ? this.currentPlatform.y : this.groundY;
    this.y = surfaceY;

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

    // Mouse attraction (horizontal only on surface)
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

    // Edge detection for window platforms — pet walks off edge → falls
    if (this.currentPlatform && this.currentPlatform.source === "window") {
      const scale = this.bounds?.scale ?? 1;
      const winW = this.windowWidth * scale;
      const platLeft = this.currentPlatform.x;
      const platRight = this.currentPlatform.x + this.currentPlatform.width;

      if (newX + winW < platLeft || newX > platRight) {
        // Walked off the window edge — fall!
        this.currentPlatform = null;
        this.lastPlatformPos = null;
        this.setState("falling");
        return;
      }
    }

    // Clamp to surface bounds (screen edges for ground, platform edges for windows)
    const clampedX = this.clampHorizontal(newX);
    if (clampedX !== newX) {
      this.vx = -this.vx;
      this.vx += (Math.random() - 0.5) * this.walkSpeed * 0.3;
      this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
    }
    this.x = clampedX;

    this.moveWindow();
  }

  /** Clamp X to appropriate bounds. Screen edges for ground, platform edges for windows. */
  private clampHorizontal(newX: number): number {
    if (!this.bounds) return newX;
    const scale = this.bounds.scale;
    const pad = this.edgePadding * scale;
    const winW = this.windowWidth * scale;

    if (this.currentPlatform && this.currentPlatform.source === "window") {
      // On a window — clamp to window edges
      const minX = this.currentPlatform.x + pad;
      const maxX = this.currentPlatform.x + this.currentPlatform.width - winW - pad;
      return Math.max(minX, Math.min(maxX, newX));
    }

    // On screen ground — clamp to screen edges
    const minX = this.bounds.x + pad;
    const maxX = this.bounds.x + this.bounds.width - winW - pad;
    return Math.max(minX, Math.min(maxX, newX));
  }

  /** Clamp position to screen bounds (for after window moves pet off-screen). */
  private clampToScreen(): void {
    if (!this.bounds) return;
    const scale = this.bounds.scale;
    const winW = this.windowWidth * scale;
    const winH = this.windowHeight * scale;
    const minX = this.bounds.x;
    const maxX = this.bounds.x + this.bounds.width - winW;
    const minY = this.bounds.y;
    const maxY = this.bounds.y + this.bounds.height - winH;
    this.x = Math.max(minX, Math.min(maxX, this.x));
    this.y = Math.max(minY, Math.min(maxY, this.y));
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

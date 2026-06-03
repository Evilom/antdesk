/**
 * PhysicsEngine — Desktop pet roaming physics with gravity & surface walking.
 *
 * Coordinate system: **logical pixels** (matches Tauri LogicalPosition).
 *
 * States:
 *   idle    — standing on surface, pausing
 *   walk    — walking horizontally on surface
 *   run     — running toward mouse (faster walk when mouse nearby)
 *   jump    — brief hop animation at fall start
 *   falling — in the air, gravity pulling down
 *   landing — brief landing recovery after fall
 *   dizzy   — stunned after heavy landing
 *   hitWall — bumped into screen edge (brief)
 *   slide   — sliding along surface after landing with horizontal speed
 *   dragged — held by user (physics paused)
 */

import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type PetState =
  | "idle" | "walk" | "run"
  | "jump" | "falling" | "landing" | "dizzy"
  | "hitWall" | "slide"
  | "dragged";

interface ScreenBounds {
  x: number; y: number;
  width: number; height: number;
  scale: number;
}

export interface Platform {
  x: number; y: number;
  width: number; height: number;
  source: "screen" | "window";
  name?: string;
}

export interface PhysicsEngineOptions {
  windowWidth: number;
  windowHeight: number;
  walkSpeed?: number;
  runSpeed?: number;
  directionChangeInterval?: number;
  idleDuration?: [number, number];
  idleProbability?: number;
  mouseAttraction?: number;
  mouseAttractionDistance?: number;
  edgePadding?: number;
  gravity?: number;
  dizzyDuration?: number;
  bounceFactor?: number;
  jumpDuration?: number;
  landingDuration?: number;
  hitWallDuration?: number;
  slideFriction?: number;
  onStateChange?: (state: PetState) => void;
  onFacingChange?: (dir: 1 | -1) => void;
}

export class PhysicsEngine {
  private x = 0;  private y = 0;
  private prevX = 0;  private prevY = 0;
  private vx = 0;  private vy = 0;
  private prevFallY = 0;  // Tracks Y from previous falling frame

  private state: PetState = "idle";
  private running = false;
  private rafId = 0;
  private lastTime = 0;

  private bounds: ScreenBounds | null = null;
  private groundY = 0;
  private platforms: Platform[] = [];

  private directionTimer = 0;
  private idleTimer = 0;
  private dizzyTimer = 0;
  private jumpTimer = 0;
  private landingTimer = 0;
  private hitWallTimer = 0;

  private mouseX = 0;  private mouseY = 0;

  private windowWidth: number;
  private windowHeight: number;
  private walkSpeed: number;
  private runSpeed: number;
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
  private jumpDuration: number;
  private landingDuration: number;
  private hitWallDuration: number;
  private slideFriction: number;

  private onStateChange?: (state: PetState) => void;
  private onFacingChange?: (dir: 1 | -1) => void;
  private boundMouseMove: (e: MouseEvent) => void;

  constructor(options: PhysicsEngineOptions) {
    this.windowWidth = options.windowWidth;
    this.windowHeight = options.windowHeight;
    this.walkSpeed = options.walkSpeed ?? 40;
    this.runSpeed = options.runSpeed ?? 80;
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
    this.jumpDuration = options.jumpDuration ?? 0.3;
    this.landingDuration = options.landingDuration ?? 0.4;
    this.hitWallDuration = options.hitWallDuration ?? 0.5;
    this.slideFriction = options.slideFriction ?? 0.92;
    this.onStateChange = options.onStateChange;
    this.onFacingChange = options.onFacingChange;
    this.boundMouseMove = (e: MouseEvent) => {
      this.mouseX = e.screenX;
      this.mouseY = e.screenY;
    };
  }

  async start(): Promise<void> {
    if (this.running) return;
    try {
      const raw = await invoke<ScreenBounds>("get_screen_bounds");
      this.bounds = {
        x: raw.x / raw.scale, y: raw.y / raw.scale,
        width: raw.width / raw.scale, height: raw.height / raw.scale,
        scale: raw.scale,
      };
    } catch {
      this.bounds = { x: 0, y: 25, width: 1920, height: 990, scale: 1 };
    }
    this.recomputeGround();
    try {
      const pos = await getCurrentWindow().outerPosition();
      this.x = pos.x / (this.bounds?.scale ?? 1);
      this.y = pos.y / (this.bounds?.scale ?? 1);
    } catch {}
    if (Math.abs(this.y - this.groundY) < 10) this.y = this.groundY;
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

  setPlatforms(platforms: Platform[]): void { this.platforms = platforms; }
  refreshPlatforms(p: Platform[]): void { this.platforms = p; }
  getState(): PetState { return this.state; }

  onDragStart(): void {
    this.setState("dragged");
  }

  onDragEnd(vx: number, vy: number): void {
    this.vx = vx * 0.4;
    this.vy = vy * 0.3;
    getCurrentWindow().outerPosition().then(pos => {
      const scale = this.bounds?.scale ?? 1;
      this.x = pos.x / scale;
      this.y = pos.y / scale;
      this.prevFallY = this.y;  // CRITICAL: seed prevFallY
      this.setState("jump");
    }).catch(() => {
      this.prevFallY = this.y;
      this.setState("jump");
    });
  }

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
      case "idle":    this.tickIdle(dt); break;
      case "walk":    this.tickWalk(dt); break;
      case "run":     this.tickRun(dt); break;
      case "jump":    this.tickJump(dt); break;
      case "falling": this.tickFalling(dt); break;
      case "landing": this.tickLanding(dt); break;
      case "dizzy":   this.tickDizzy(dt); break;
      case "hitWall": this.tickHitWall(dt); break;
      case "slide":   this.tickSlide(dt); break;
    }
    this.safetyClamp();
    this.rafId = requestAnimationFrame(this.tick.bind(this));
  }

  // ── State handlers ──

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
    this.directionTimer -= dt;

    // Check if should run (mouse nearby)
    const petCenterX = this.x + this.windowWidth / 2;
    const dx = this.mouseX - petCenterX;
    const dist = Math.abs(dx);
    if (dist < this.mouseAttractionDistance * 0.5 && dist > 20) {
      this.vx = Math.sign(dx) * this.runSpeed;
      this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
      this.setState("run");
      return;
    }

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

    // Mouse attraction (gentle)
    if (this.mouseAttraction > 0) {
      const d = Math.abs(this.mouseX - petCenterX);
      if (d < this.mouseAttractionDistance && d > 10) {
        const str = this.mouseAttraction * (1 - d / this.mouseAttractionDistance);
        this.vx += Math.sign(this.mouseX - petCenterX) * str * this.walkSpeed;
        const max = this.walkSpeed * 1.3;
        if (Math.abs(this.vx) > max) this.vx = Math.sign(this.vx) * max;
      }
    }

    let newX = this.x + this.vx * dt;
    const clamped = this.clampHorizontal(newX);
    if (clamped !== newX) {
      // Hit wall!
      this.vx = 0;
      this.hitWallTimer = this.hitWallDuration;
      this.x = clamped;
      this.setState("hitWall");
      return;
    }
    this.x = clamped;
    this.moveWindow();
  }

  private tickRun(dt: number): void {
    this.y = this.groundY;
    const petCenterX = this.x + this.windowWidth / 2;
    const dx = this.mouseX - petCenterX;
    const dist = Math.abs(dx);

    // Stop running if mouse is far or reached it
    if (dist > this.mouseAttractionDistance * 0.7 || dist < 15) {
      this.vx *= 0.5;
      this.setState("walk");
      this.directionTimer = 1;
      return;
    }

    this.vx = Math.sign(dx) * this.runSpeed;
    this.onFacingChange?.(this.vx >= 0 ? 1 : -1);

    let newX = this.x + this.vx * dt;
    const clamped = this.clampHorizontal(newX);
    if (clamped !== newX) {
      this.vx = 0;
      this.hitWallTimer = this.hitWallDuration;
      this.x = clamped;
      this.setState("hitWall");
      return;
    }
    this.x = clamped;
    this.moveWindow();
  }

  private tickJump(dt: number): void {
    // Brief jump animation — apply small upward velocity then transition to falling
    this.jumpTimer += dt;
    this.y += this.vy * dt;
    this.vy += this.gravity * dt * 0.5;  // Gentle gravity during jump
    this.x += this.vx * dt * 0.3;
    this.x = this.clampHorizontal(this.x);

    if (this.jumpTimer >= this.jumpDuration) {
      this.jumpTimer = 0;
      this.prevFallY = this.y;
      this.setState("falling");
    }
    this.moveWindow();
  }

  private tickFalling(dt: number): void {
    // Store previous position BEFORE updating
    const oldY = this.y;

    // Apply gravity
    this.vy += this.gravity * dt;
    this.vx *= 0.995;

    let newX = this.x + this.vx * dt;
    let newY = this.y + this.vy * dt;

    // Check platform collision using PREVIOUS position vs NEW position
    let landY = this.groundY;
    const prevBottom = oldY + this.windowHeight;
    const newBottom = newY + this.windowHeight;

    for (const p of this.platforms) {
      if (p.y >= this.groundY) continue;
      if (prevBottom <= p.y + 4 && newBottom >= p.y - 4) {
        const cx = newX + this.windowWidth / 2;
        if (cx >= p.x - 20 && cx <= p.x + p.width + 20) {
          if (p.y < landY) landY = p.y;
        }
      }
    }

    // Ground collision: prev was above ground, new is at/below
    if (prevBottom <= landY + 4 && newBottom >= landY - 4) {
      newY = landY;
      const speed = Math.abs(this.vy);

      if (speed > 300) {
        // Hard landing → dizzy
        this.vy = 0;
        this.vx *= 0.3;
        this.y = landY;
        this.x = this.clampHorizontal(newX);
        this.dizzyTimer = this.dizzyDuration;
        this.setState("dizzy");
      } else if (Math.abs(this.vx) > 30) {
        // Has horizontal speed → slide
        this.vy = 0;
        this.y = landY;
        this.x = this.clampHorizontal(newX);
        this.setState("slide");
      } else if (speed > 30) {
        // Medium landing → brief landing recovery
        this.vy = 0;
        this.vx = 0;
        this.y = landY;
        this.x = this.clampHorizontal(newX);
        this.landingTimer = this.landingDuration;
        this.setState("landing");
      } else {
        // Soft landing → just walk
        this.vy = 0;
        this.vx = 0;
        this.y = landY;
        this.x = this.clampHorizontal(newX);
        this.setHorizontalRandomDirection();
        this.setState("walk");
      }
      return;
    }

    this.x = this.clampHorizontal(newX);
    this.y = newY;
    this.moveWindow();
  }

  private tickLanding(dt: number): void {
    this.y = this.groundY;
    this.landingTimer -= dt;
    if (this.landingTimer <= 0) {
      this.setHorizontalRandomDirection();
      this.setState("walk");
    }
  }

  private tickDizzy(dt: number): void {
    this.y = this.groundY;
    this.dizzyTimer -= dt;
    if (this.dizzyTimer <= 0) {
      this.setHorizontalRandomDirection();
      this.setState("walk");
    }
  }

  private tickHitWall(dt: number): void {
    this.y = this.groundY;
    this.hitWallTimer -= dt;
    if (this.hitWallTimer <= 0) {
      // Reverse direction and walk away
      this.setHorizontalRandomDirection();
      this.setState("walk");
    }
  }

  private tickSlide(dt: number): void {
    this.y = this.groundY;
    this.vx *= this.slideFriction;

    let newX = this.x + this.vx * dt;
    const clamped = this.clampHorizontal(newX);
    if (clamped !== newX) {
      // Hit wall while sliding → stop
      this.vx = 0;
      this.hitWallTimer = this.hitWallDuration * 0.5;
      this.x = clamped;
      this.setState("hitWall");
      return;
    }
    this.x = clamped;

    // Stop sliding when slow enough
    if (Math.abs(this.vx) < 5) {
      this.vx = 0;
      this.idleTimer = this.idleDurationMin + Math.random() * 2;
      this.setState("idle");
    }

    this.moveWindow();
  }

  private clampHorizontal(newX: number): number {
    if (!this.bounds) return newX;
    const pad = this.edgePadding;
    const minX = this.bounds.x + pad;
    const maxX = this.bounds.x + this.bounds.width - this.windowWidth - pad;
    return Math.max(minX, Math.min(maxX, newX));
  }

  private safetyClamp(): void {
    if (!this.bounds || this.state === "dragged") return;
    const b = this.bounds;
    const m = 100;
    if (this.x < b.x - m || this.x > b.x + b.width + m ||
        this.y < b.y - m || this.y > b.y + b.height + m) {
      console.warn("[Physics] Pet escaped! Resetting.", { x: this.x, y: this.y });
      this.x = b.x + b.width / 2 - this.windowWidth / 2;
      this.y = this.groundY;
      this.vx = 0; this.vy = 0;
      this.setState("idle");
      this.moveWindow();
    }
  }

  private moveWindow(): void {
    const dx = Math.abs(Math.round(this.x) - Math.round(this.prevX));
    const dy = Math.abs(Math.round(this.y) - Math.round(this.prevY));
    if (dx >= 1 || dy >= 1) {
      this.prevX = this.x;
      this.prevY = this.y;
      getCurrentWindow().setPosition(
        new LogicalPosition(Math.round(this.x), Math.round(this.y))
      ).catch(() => {});
    }
  }
}

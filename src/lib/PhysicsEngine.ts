/**
 * PhysicsEngine — Desktop pet physics with rich behavior.
 *
 * Coordinate system: **logical pixels** (matches Tauri LogicalPosition).
 *
 * BEHAVIOR SYSTEM:
 *   Instead of simple walk/idle ping-pong, the pet picks "behaviors":
 *   - stroll:  slow walk with occasional direction changes
 *   - sprint:  fast run across the screen
 *   - explore: walk to a random target point, pause, repeat
 *   - rest:    longer idle, maybe sit
 *   - jump:    spontaneous hop while walking
 *   - chase:   follow the mouse cursor
 *
 * PHYSICS STATES (mapped from behaviors + events):
 *   idle / walk / run / jump / falling / landing / dizzy / hitWall / slide / dragged
 */

import { invoke } from "@tauri-apps/api/core";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type PetState =
  | "idle" | "walk" | "run"
  | "jump" | "falling" | "landing" | "dizzy"
  | "hitWall" | "slide"
  | "dragged";

type Behavior = "stroll" | "sprint" | "explore" | "rest" | "chase";

export interface BehaviorWeights {
  stroll: number; sprint: number; explore: number; rest: number; chase: number;
}

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

  private state: PetState = "idle";
  private running = false;
  private rafId = 0;
  private lastTime = 0;

  private bounds: ScreenBounds | null = null;
  private groundY = 0;
  private platforms: Platform[] = [];
  private behaviorWeights: BehaviorWeights = { stroll: 0.35, sprint: 0.15, explore: 0.20, rest: 0.15, chase: 0.15 };

  // Behavior
  private behavior: Behavior = "stroll";
  private behaviorTimer = 0;
  private exploreTargetX = 0;
  private restCount = 0;  // How many rests taken (increases variety)

  // Timers
  private directionTimer = 0;
  private idleTimer = 0;
  private dizzyTimer = 0;
  private jumpTimer = 0;
  private landingTimer = 0;
  private hitWallTimer = 0;
  private spontaneousJumpTimer = 0;

  private mouseX = 0;  private mouseY = 0;

  // Config
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
    await this.refreshBounds();
    try {
      const pos = await getCurrentWindow().outerPosition();
      const s = this.bounds?.scale ?? 1;
      this.x = pos.x / s;
      this.y = pos.y / s;
    } catch {}
    if (Math.abs(this.y - this.groundY) < 10) this.y = this.groundY;
    this.pickBehavior();
    document.addEventListener("mousemove", this.boundMouseMove);
    this.running = true;
    this.spontaneousJumpTimer = 8 + Math.random() * 15;
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

  /** Set behavior weights from EmotionEngine. Normalizes internally. */
  setBehaviorWeights(w: BehaviorWeights): void {
    const total = w.stroll + w.sprint + w.explore + w.rest + w.chase;
    if (total > 0) {
      this.behaviorWeights = {
        stroll: w.stroll / total, sprint: w.sprint / total,
        explore: w.explore / total, rest: w.rest / total, chase: w.chase / total,
      };
    }
  }
  getState(): PetState { return this.state; }

  onDragStart(): void { this.setState("dragged"); }

  onDragEnd(vx: number, vy: number): void {
    this.vx = vx * 0.4;
    this.vy = vy * 0.3;
    getCurrentWindow().outerPosition().then(pos => {
      const s = this.bounds?.scale ?? 1;
      this.x = pos.x / s;
      this.y = pos.y / s;
      this.setState("jump");
    }).catch(() => this.setState("jump"));
  }

  // ── Bounds ──

  private async refreshBounds(): Promise<void> {
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
  }

  private recomputeGround(): void {
    if (!this.bounds) return;
    this.groundY = this.bounds.y + this.bounds.height - this.windowHeight - this.edgePadding;
  }

  // ── Behavior system ──

  private pickBehavior(): void {
    const b = this.bounds;
    if (!b) { this.startStroll(); return; }

    // Check if mouse is close → chase (overrides weights)
    const pcx = this.x + this.windowWidth / 2;
    const dx = this.mouseX - pcx;
    const dist = Math.abs(dx);
    if (dist < this.mouseAttractionDistance * 0.4 && dist > 30 && this.behaviorWeights.chase > 0.05) {
      this.behavior = "chase";
      this.behaviorTimer = 2 + Math.random() * 3;
      this.vx = Math.sign(dx) * this.runSpeed;
      this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
      this.setState("run");
      return;
    }

    // Weighted random behavior using emotion-driven weights
    const w = this.behaviorWeights;
    const r = Math.random();
    let cumulative = 0;

    cumulative += w.stroll;
    if (r < cumulative) { this.startStroll(); return; }

    cumulative += w.explore;
    if (r < cumulative) { this.startExplore(b); return; }

    cumulative += w.sprint;
    if (r < cumulative) { this.startSprint(b); return; }

    cumulative += w.rest;
    if (r < cumulative) { this.startRest(); return; }

    // Remaining → stroll with spontaneous jump
    this.startStroll();
    this.spontaneousJumpTimer = 2 + Math.random() * 5;
  }

  private startStroll(): void {
    this.behavior = "stroll";
    this.behaviorTimer = 4 + Math.random() * 6;
    this.vx = (Math.random() > 0.5 ? 1 : -1) * (this.walkSpeed * (0.6 + Math.random() * 0.4));
    this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
    this.setState("walk");
  }

  private startExplore(b: ScreenBounds): void {
    this.behavior = "explore";
    this.behaviorTimer = 8 + Math.random() * 8;
    // Pick a random X target on screen
    this.exploreTargetX = b.x + 50 + Math.random() * (b.width - this.windowWidth - 100);
    // Walk toward it
    const dir = this.exploreTargetX > this.x ? 1 : -1;
    this.vx = dir * this.walkSpeed * (0.7 + Math.random() * 0.3);
    this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
    this.setState("walk");
  }

  private startSprint(b: ScreenBounds): void {
    this.behavior = "sprint";
    this.behaviorTimer = 1.5 + Math.random() * 2;
    // Sprint to a random side
    const dir = Math.random() > 0.5 ? 1 : -1;
    this.vx = dir * this.runSpeed;
    this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
    this.setState("run");
  }

  private startRest(): void {
    this.behavior = "rest";
    this.restCount++;
    // Vary rest duration — sometimes short, sometimes long
    const long = this.restCount % 3 === 0;
    this.behaviorTimer = long ? (5 + Math.random() * 8) : (2 + Math.random() * 3);
    this.vx = 0;
    this.idleTimer = this.behaviorTimer;
    this.setState("idle");
  }

  // ── Private ──

  private setState(s: PetState): void {
    if (s === this.state) return;
    this.state = s;
    this.onStateChange?.(s);
  }

  private tick(nowMs: number): void {
    if (!this.running) return;
    const now = nowMs / 1000;
    const dt = Math.min(now - this.lastTime, 0.1);
    this.lastTime = now;

    // Periodic bounds refresh (in case monitors change)
    this._boundsTimer = (this._boundsTimer || 0) + dt;
    if (this._boundsTimer > 10) {
      this._boundsTimer = 0;
      this.refreshBounds();
    }

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
  private _boundsTimer = 0;

  // ── State handlers ──

  private tickIdle(dt: number): void {
    this.y = this.groundY;
    this.behaviorTimer -= dt;
    this.idleTimer -= dt;
    if (this.behaviorTimer <= 0 || this.idleTimer <= 0) {
      this.pickBehavior();
    }
  }

  private tickWalk(dt: number): void {
    this.y = this.groundY;
    this.behaviorTimer -= dt;
    this.directionTimer -= dt;

    // Spontaneous jump timer
    this.spontaneousJumpTimer -= dt;
    if (this.spontaneousJumpTimer <= 0 && Math.random() < 0.4) {
      this.vy = -300; // upward impulse
      this.spontaneousJumpTimer = 10 + Math.random() * 20;
      this.setState("jump");
      return;
    }

    // Behavior-specific logic
    if (this.behavior === "explore") {
      // Walk toward explore target
      const dx = this.exploreTargetX - this.x;
      if (Math.abs(dx) < 20) {
        // Reached target → pause then pick new behavior
        this.vx = 0;
        this.idleTimer = 1 + Math.random() * 2;
        this.setState("idle");
        this.behaviorTimer = this.idleTimer;
        return;
      }
      this.vx = Math.sign(dx) * this.walkSpeed * 0.8;
      this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
    }

    // Mouse attraction (gentle nudge toward cursor)
    if (this.mouseAttraction > 0 && this.behavior !== "explore") {
      const pcx = this.x + this.windowWidth / 2;
      const d = Math.abs(this.mouseX - pcx);
      if (d < this.mouseAttractionDistance && d > 15) {
        const str = this.mouseAttraction * (1 - d / this.mouseAttractionDistance) * 0.5;
        this.vx += Math.sign(this.mouseX - pcx) * str * this.walkSpeed;
        const max = this.walkSpeed * 1.2;
        if (Math.abs(this.vx) > max) this.vx = Math.sign(this.vx) * max;
      }
    }

    if (this.directionTimer <= 0 && this.behavior === "stroll") {
      if (Math.random() < this.idleProbability * 0.5) {
        this.vx = 0;
        this.idleTimer = 1 + Math.random() * 3;
        this.setState("idle");
        return;
      }
      this.vx = (Math.random() > 0.5 ? 1 : -1) * this.walkSpeed * (0.5 + Math.random() * 0.5);
      this.directionTimer = this.directionChangeInterval * (0.7 + Math.random() * 0.8);
      this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
    }

    // Move
    let newX = this.x + this.vx * dt;
    const clamped = this.clampX(newX);
    if (clamped !== newX) {
      this.vx = 0;
      this.hitWallTimer = this.hitWallDuration;
      this.x = clamped;
      this.setState("hitWall");
      return;
    }
    this.x = clamped;

    // End behavior timer
    if (this.behaviorTimer <= 0) this.pickBehavior();

    this.moveWindow();
  }

  private tickRun(dt: number): void {
    this.y = this.groundY;
    this.behaviorTimer -= dt;

    if (this.behavior === "chase") {
      const pcx = this.x + this.windowWidth / 2;
      const dx = this.mouseX - pcx;
      const dist = Math.abs(dx);
      if (dist > this.mouseAttractionDistance * 0.7 || dist < 15) {
        this.vx *= 0.5;
        this.pickBehavior();
        return;
      }
      this.vx = Math.sign(dx) * this.runSpeed;
      this.onFacingChange?.(this.vx >= 0 ? 1 : -1);
    }

    let newX = this.x + this.vx * dt;
    const clamped = this.clampX(newX);
    if (clamped !== newX) {
      this.vx = 0;
      this.hitWallTimer = this.hitWallDuration;
      this.x = clamped;
      this.setState("hitWall");
      return;
    }
    this.x = clamped;

    if (this.behaviorTimer <= 0) this.pickBehavior();
    this.moveWindow();
  }

  private tickJump(dt: number): void {
    this.jumpTimer += dt;
    this.vy += this.gravity * dt * 0.5;
    this.y += this.vy * dt;
    this.x += this.vx * dt * 0.3;
    this.x = this.clampX(this.x);

    // If jumped high enough or timer expired → falling
    if (this.jumpTimer >= this.jumpDuration || this.vy > 0) {
      this.jumpTimer = 0;
      this.setState("falling");
    }
    this.moveWindow();
  }

  private tickFalling(dt: number): void {
    const oldY = this.y;

    this.vy += this.gravity * dt;
    this.vx *= 0.995;

    let newX = this.x + this.vx * dt;
    let newY = this.y + this.vy * dt;

    // Y clamp: don't go above screen top
    if (this.bounds && newY < this.bounds.y) {
      newY = this.bounds.y;
      this.vy = Math.abs(this.vy) * 0.2; // bounce downward gently
    }

    // Platform collision
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

    // Ground collision
    if (prevBottom <= landY + 4 && newBottom >= landY - 4) {
      const speed = Math.abs(this.vy);

      if (speed > 300) {
        this.vy = 0; this.vx *= 0.3;
        this.y = landY; this.x = this.clampX(newX);
        this.dizzyTimer = this.dizzyDuration;
        this.setState("dizzy");
      } else if (Math.abs(this.vx) > 30) {
        this.vy = 0;
        this.y = landY; this.x = this.clampX(newX);
        this.setState("slide");
      } else if (speed > 30) {
        this.vy = 0; this.vx = 0;
        this.y = landY; this.x = this.clampX(newX);
        this.landingTimer = this.landingDuration;
        this.setState("landing");
      } else {
        this.vy = 0; this.vx = 0;
        this.y = landY; this.x = this.clampX(newX);
        this.pickBehavior();
      }
      return;
    }

    this.x = this.clampX(newX);
    this.y = newY;
    this.moveWindow();
  }

  private tickLanding(dt: number): void {
    this.y = this.groundY;
    this.landingTimer -= dt;
    if (this.landingTimer <= 0) this.pickBehavior();
  }

  private tickDizzy(dt: number): void {
    this.y = this.groundY;
    this.dizzyTimer -= dt;
    if (this.dizzyTimer <= 0) this.pickBehavior();
  }

  private tickHitWall(dt: number): void {
    this.y = this.groundY;
    this.hitWallTimer -= dt;
    if (this.hitWallTimer <= 0) this.pickBehavior();
  }

  private tickSlide(dt: number): void {
    this.y = this.groundY;
    this.vx *= this.slideFriction;

    let newX = this.x + this.vx * dt;
    const clamped = this.clampX(newX);
    if (clamped !== newX) {
      this.vx = 0;
      this.hitWallTimer = this.hitWallDuration * 0.5;
      this.x = clamped;
      this.setState("hitWall");
      return;
    }
    this.x = clamped;

    if (Math.abs(this.vx) < 5) {
      this.vx = 0;
      this.pickBehavior();
    }
    this.moveWindow();
  }

  // ── Helpers ──

  /** Clamp X to screen edges */
  private clampX(newX: number): number {
    if (!this.bounds) return newX;
    const minX = this.bounds.x + this.edgePadding;
    const maxX = this.bounds.x + this.bounds.width - this.windowWidth - this.edgePadding;
    return Math.max(minX, Math.min(maxX, newX));
  }

  /** Safety: catch any escape and reset */
  private safetyClamp(): void {
    if (!this.bounds || this.state === "dragged") return;
    const b = this.bounds;
    const safe = 50; // tight margin

    let needsReset = false;
    if (this.x < b.x - safe || this.x > b.x + b.width + safe) needsReset = true;
    if (this.y < b.y - safe || this.y > b.y + b.height + safe) needsReset = true;

    // Also: if on ground but Y drifted
    if (["idle", "walk", "run", "hitWall", "slide", "landing", "dizzy"].includes(this.state)) {
      if (Math.abs(this.y - this.groundY) > 5) needsReset = true;
    }

    if (needsReset) {
      console.warn("[Physics] Pet out of bounds, resetting.", { x: this.x, y: this.y, state: this.state });
      this.x = b.x + b.width / 2 - this.windowWidth / 2;
      this.y = this.groundY;
      this.vx = 0; this.vy = 0;
      this.pickBehavior();
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

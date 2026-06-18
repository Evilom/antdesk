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
  | "perch" | "bumped" | "pushed"
  | "dragged";

type Behavior = "stroll" | "sprint" | "explore" | "rest" | "chase";
export type PhysicsInteractionMode = "standard" | "enhanced";
export type PetContactState = "desktop" | "window" | "pushed" | "avoiding";

export interface BehaviorWeights {
  stroll: number; sprint: number; explore: number; rest: number; chase: number;
}

interface ScreenBounds {
  x: number; y: number;
  width: number; height: number;
  scale: number;
}

export interface Platform {
  id?: string;
  x: number; y: number;
  width: number; height: number;
  source: "screen" | "window";
  name?: string;
  title?: string;
  kind?: "external-window" | "antdesk-window";
  focused?: boolean;
  vx?: number;
  vy?: number;
  moving?: boolean;
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
  interactionMode?: PhysicsInteractionMode;
  onStateChange?: (state: PetState) => void;
  onFacingChange?: (dir: 1 | -1) => void;
  onContactChange?: (state: PetContactState) => void;
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
  private floorY = 0;
  private platforms: Platform[] = [];
  private currentSupport: Platform | null = null;
  private contactState: PetContactState = "desktop";
  private lastImpulseAt = 0;
  private lastSupportVx = 0;
  private lastSupportVy = 0;
  private pushTimer = 0;
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
  private interactionMode: PhysicsInteractionMode;

  private onStateChange?: (state: PetState) => void;
  private onFacingChange?: (dir: 1 | -1) => void;
  private onContactChange?: (state: PetContactState) => void;
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
    this.interactionMode = options.interactionMode ?? "standard";
    this.onStateChange = options.onStateChange;
    this.onFacingChange = options.onFacingChange;
    this.onContactChange = options.onContactChange;
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
    if (opts.interactionMode !== undefined) this.interactionMode = opts.interactionMode;
  }

  setPlatforms(platforms: Platform[]): void {
    this.platforms = this.normalizePlatforms(platforms);
    if (this.platforms.length === 0) this.setContact("desktop");
  }
  refreshPlatforms(p: Platform[]): void { this.setPlatforms(p); }

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
    this.floorY = this.groundY;
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

  private setContact(s: PetContactState): void {
    if (s === this.contactState) return;
    this.contactState = s;
    this.onContactChange?.(s);
  }

  private normalizePlatforms(platforms: Platform[]): Platform[] {
    return platforms
      .filter((p) => p.width >= 120 && p.height >= 80)
      .sort((a, b) => (a.focused === b.focused ? 0 : a.focused ? -1 : 1))
      .slice(0, 24);
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
      case "perch":   this.tickPerch(dt); break;
      case "bumped":  this.tickBumped(dt); break;
      case "pushed":  this.tickPushed(dt); break;
    }

    this.applyMovingWindowImpulses();
    this.safetyClamp();
    this.rafId = requestAnimationFrame(this.tick.bind(this));
  }
  private _boundsTimer = 0;

  // ── State handlers ──

  private tickIdle(dt: number): void {
    this.floorY = this.resolveFloorY(this.x, this.y);
    this.carryWithSupport(dt, this.interactionMode === "enhanced" ? 0.72 : 0.56);
    this.y = this.floorY;
    if (this.currentSupport?.source === "window" && this.currentSupport.kind !== "antdesk-window") {
      this.setState("perch");
      return;
    }
    this.applyWorkAreaAvoidance();
    if (this.contactState === "avoiding" && Math.abs(this.vx) > 8) {
      this.setState("walk");
      return;
    }
    this.behaviorTimer -= dt;
    this.idleTimer -= dt;
    if (this.behaviorTimer <= 0 || this.idleTimer <= 0) {
      this.pickBehavior();
    }
  }

  private tickWalk(dt: number): void {
    this.floorY = this.resolveFloorY(this.x, this.y);
    this.carryWithSupport(dt, this.interactionMode === "enhanced" ? 0.58 : 0.36);
    this.y = this.floorY;
    this.behaviorTimer -= dt;
    this.directionTimer -= dt;
    this.applyWorkAreaAvoidance();

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
    this.floorY = this.resolveFloorY(this.x, this.y);
    this.y = this.floorY;

    // End behavior timer
    if (this.behaviorTimer <= 0) this.pickBehavior();

    this.moveWindow();
  }

  private tickRun(dt: number): void {
    this.floorY = this.resolveFloorY(this.x, this.y);
    this.carryWithSupport(dt, this.interactionMode === "enhanced" ? 0.42 : 0.24);
    this.y = this.floorY;
    this.behaviorTimer -= dt;
    this.applyWorkAreaAvoidance();

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
    this.floorY = this.resolveFloorY(this.x, this.y);
    this.y = this.floorY;

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
      if (!this.isUsablePlatform(p)) continue;
      if (p.y >= this.groundY + this.windowHeight) continue;
      if (prevBottom <= p.y + 4 && newBottom >= p.y - 4) {
        const cx = newX + this.windowWidth / 2;
        if (cx >= p.x - 20 && cx <= p.x + p.width + 20) {
          const platformFloor = p.y - this.windowHeight;
          if (platformFloor < landY) landY = platformFloor;
        }
      }
    }

    // Ground collision
    if (prevBottom <= landY + this.windowHeight + 4 && newBottom >= landY + this.windowHeight - 4) {
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
    this.floorY = this.resolveFloorY(this.x, this.y);
    this.carryWithSupport(dt, this.interactionMode === "enhanced" ? 0.58 : 0.4);
    this.y = this.floorY;
    this.landingTimer -= dt;
    if (this.landingTimer <= 0) this.pickBehavior();
  }

  private tickDizzy(dt: number): void {
    this.floorY = this.resolveFloorY(this.x, this.y);
    this.carryWithSupport(dt, 0.24);
    this.y = this.floorY;
    this.dizzyTimer -= dt;
    if (this.dizzyTimer <= 0) this.pickBehavior();
  }

  private tickHitWall(dt: number): void {
    this.floorY = this.resolveFloorY(this.x, this.y);
    this.carryWithSupport(dt, 0.26);
    this.y = this.floorY;
    this.hitWallTimer -= dt;
    if (this.hitWallTimer <= 0) this.pickBehavior();
  }

  private tickSlide(dt: number): void {
    this.floorY = this.resolveFloorY(this.x, this.y);
    this.carryWithSupport(dt, this.interactionMode === "enhanced" ? 0.32 : 0.18);
    this.y = this.floorY;
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

  private tickPerch(dt: number): void {
    this.floorY = this.resolveFloorY(this.x, this.y);
    if (!this.currentSupport || this.currentSupport.source !== "window") {
      this.vx += this.clampImpulse(this.lastSupportVx * (this.interactionMode === "enhanced" ? 0.62 : 0.42), this.interactionMode === "enhanced" ? 260 : 150);
      this.vy = Math.max(80, Math.abs(this.lastSupportVy) * 0.35);
      this.setState("falling");
      return;
    }
    this.carryWithSupport(dt, this.interactionMode === "enhanced" ? 0.92 : 0.72);
    this.y = this.floorY;
    this.vx *= this.interactionMode === "enhanced" ? 0.96 : 0.93;
    this.behaviorTimer -= dt;
    this.idleTimer -= dt;
    this.setContact("window");
    if (this.behaviorTimer <= 0 || this.idleTimer <= 0) this.pickBehavior();
    this.moveWindow();
  }

  private tickBumped(dt: number): void {
    this.vy += this.gravity * dt * 0.45;
    this.x = this.clampX(this.x + this.vx * dt);
    this.y += this.vy * dt;
    this.floorY = this.resolveFloorY(this.x, this.y);
    if (this.y >= this.floorY) {
      this.y = this.floorY;
      this.vy = 0;
      this.setState(Math.abs(this.vx) > 45 ? "slide" : "landing");
      return;
    }
    this.moveWindow();
  }

  private tickPushed(dt: number): void {
    this.floorY = this.resolveFloorY(this.x, this.y);
    this.y = this.floorY;
    this.pushTimer -= dt;
    this.vx *= this.interactionMode === "enhanced" ? 0.96 : 0.91;
    this.x = this.clampX(this.x + this.vx * dt);
    this.setContact("pushed");
    if (Math.abs(this.vx) < 12 || this.pushTimer <= 0) this.pickBehavior();
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

  private isUsablePlatform(p: Platform): boolean {
    if (!this.bounds) return false;
    if (p.width < 120 || p.height < 80) return false;
    if (p.y < this.bounds.y || p.y > this.bounds.y + this.bounds.height) return false;
    return true;
  }

  private resolveFloorY(x: number, currentY: number): number {
    let floor = this.groundY;
    let support: Platform | null = null;
    const cx = x + this.windowWidth / 2;
    const currentBottom = currentY + this.windowHeight;

    for (const p of this.platforms) {
      if (!this.isUsablePlatform(p)) continue;
      const movingPad = p.moving ? (this.interactionMode === "enhanced" ? 34 : 24) : 14;
      if (cx < p.x - movingPad || cx > p.x + p.width + movingPad) continue;
      const platformFloor = p.y - this.windowHeight;
      if (platformFloor < (this.bounds?.y ?? 0)) continue;
      const platformTop = p.y;
      const verticalPad = p.moving ? (this.interactionMode === "enhanced" ? 42 : 32) : 24;
      const closeEnough = Math.abs(currentBottom - platformTop) < verticalPad;
      const belowOrOn = currentBottom <= platformTop + verticalPad;
      if ((closeEnough || belowOrOn) && platformFloor < floor) {
        floor = platformFloor;
        support = p;
      }
    }
    this.currentSupport = support;
    this.setContact(support?.source === "window" ? "window" : "desktop");
    return floor;
  }

  private carryWithSupport(dt: number, factor: number): void {
    if (!this.currentSupport || this.currentSupport.source !== "window") return;
    const vx = this.clampImpulse(this.currentSupport.vx ?? 0, this.interactionMode === "enhanced" ? 340 : 210);
    const vy = this.clampImpulse(this.currentSupport.vy ?? 0, this.interactionMode === "enhanced" ? 180 : 96);
    this.lastSupportVx = vx;
    this.lastSupportVy = vy;
    this.x = this.clampX(this.x + vx * factor * dt);
    if (Math.abs(vy) > 8) this.y += vy * factor * 0.25 * dt;
  }

  private applyWorkAreaAvoidance(): void {
    const petCx = this.x + this.windowWidth / 2;
    const petCy = this.y + this.windowHeight / 2;
    const focused = this.platforms.find((p) => p.focused && p.kind !== "antdesk-window");
    const antDesk = this.platforms.find((p) => p.kind === "antdesk-window" && this.intersects(p, 24));
    const target = antDesk ?? focused;
    if (!target) return;

    const inset = antDesk ? 18 : 70;
    const insideX = petCx > target.x + inset && petCx < target.x + target.width - inset;
    const insideY = petCy > target.y + inset && petCy < target.y + target.height - inset;
    if (!insideX || !insideY) return;

    const toLeft = Math.abs(petCx - target.x);
    const toRight = Math.abs(target.x + target.width - petCx);
    const dir = toLeft < toRight ? -1 : 1;
    const speed = antDesk ? this.runSpeed : this.walkSpeed;
    this.vx = dir * Math.max(Math.abs(this.vx), speed * (antDesk ? 1.15 : 0.75));
    this.onFacingChange?.(dir as 1 | -1);
    this.setContact("avoiding");
  }

  private applyMovingWindowImpulses(): void {
    if (this.state === "dragged" || this.state === "dizzy") return;
    const now = performance.now();
    const cooldown = this.interactionMode === "enhanced" ? 58 : 76;
    if (now - this.lastImpulseAt < cooldown) return;

    for (const p of this.platforms) {
      if (p.source !== "window" || !p.moving) continue;
      if (this.currentSupport?.id === p.id) {
        this.lastSupportVx = this.clampImpulse(p.vx ?? 0, this.interactionMode === "enhanced" ? 340 : 210);
        this.lastSupportVy = this.clampImpulse(p.vy ?? 0, this.interactionMode === "enhanced" ? 180 : 96);
        continue;
      }

      if (this.tryCatchPlatform(p)) return;

      const pressure = this.getWindowEdgePressure(p);
      if (!pressure) continue;

      const sx = p.vx ?? 0;
      const sy = p.vy ?? 0;
      const speed = Math.hypot(sx, sy);
      if (speed < 18) continue;

      const limit = this.interactionMode === "enhanced" ? 420 : 240;
      const shove = pressure.dir * Math.min(pressure.strength, limit);
      this.vx = this.clampImpulse(this.vx * 0.35 + shove, limit);
      if (pressure.bump) this.vy = this.interactionMode === "enhanced" ? -150 : -82;
      this.lastImpulseAt = now;
      this.pushTimer = pressure.bump ? 0.52 : 0.38;
      this.setContact("pushed");
      this.setState(pressure.bump || speed > (this.interactionMode === "enhanced" ? 300 : 220) ? "bumped" : "pushed");
      this.onFacingChange?.(pressure.dir as 1 | -1);
      return;
    }
  }

  private tryCatchPlatform(p: Platform): boolean {
    if (!this.bounds || p.kind === "antdesk-window") return false;
    if (this.state === "pushed" || this.state === "bumped") return false;

    const petBottom = this.y + this.windowHeight;
    const footGap = p.y - petBottom;
    const catchBand = this.interactionMode === "enhanced" ? 42 : 30;
    if (footGap < -8 || footGap > catchBand) return false;

    const cx = this.x + this.windowWidth / 2;
    const horizontalPad = this.interactionMode === "enhanced" ? 34 : 24;
    if (cx < p.x - horizontalPad || cx > p.x + p.width + horizontalPad) return false;
    if (this.vy < -30) return false;

    this.currentSupport = p;
    this.floorY = p.y - this.windowHeight;
    this.y = this.floorY;
    this.vy = 0;
    this.vx = this.clampImpulse(this.vx + (p.vx ?? 0) * 0.18, this.interactionMode === "enhanced" ? 260 : 150);
    this.lastSupportVx = p.vx ?? 0;
    this.lastSupportVy = p.vy ?? 0;
    this.setContact("window");
    this.setState("perch");
    this.moveWindow();
    return true;
  }

  private getWindowEdgePressure(p: Platform): { dir: 1 | -1; strength: number; bump: boolean } | null {
    const vx = p.vx ?? 0;
    const vy = p.vy ?? 0;
    const speed = Math.hypot(vx, vy);
    if (speed < 18) return null;

    const petLeft = this.x;
    const petRight = this.x + this.windowWidth;
    const petTop = this.y;
    const petBottom = this.y + this.windowHeight;
    const surfaceLeft = p.x;
    const surfaceRight = p.x + p.width;
    const surfaceTop = p.y;
    const surfaceBottom = p.y + p.height;

    const verticalOverlap = Math.min(petBottom, surfaceBottom) - Math.max(petTop, surfaceTop);
    if (verticalOverlap < 32) return null;

    const influence = this.interactionMode === "enhanced" ? 72 : 52;
    const overlapAllowance = this.interactionMode === "enhanced" ? -34 : -22;
    const leftGap = petLeft - surfaceRight;
    const rightGap = surfaceLeft - petRight;

    let dir: 1 | -1 | null = null;
    let gap = Number.POSITIVE_INFINITY;
    if (vx > 12 && leftGap >= overlapAllowance && leftGap <= influence) {
      dir = 1;
      gap = leftGap;
    } else if (vx < -12 && rightGap >= overlapAllowance && rightGap <= influence) {
      dir = -1;
      gap = rightGap;
    } else if (this.intersects(p, 10)) {
      dir = this.x + this.windowWidth / 2 < p.x + p.width / 2 ? -1 : 1;
      gap = overlapAllowance;
    }
    if (!dir) return null;

    const closeness = Math.max(0.18, 1 - Math.max(0, gap) / influence);
    const base = this.interactionMode === "enhanced" ? 86 : 54;
    const velocityPush = Math.min(speed * (this.interactionMode === "enhanced" ? 0.52 : 0.38), this.interactionMode === "enhanced" ? 360 : 210);
    const verticalKick = Math.min(Math.abs(vy) * 0.12, this.interactionMode === "enhanced" ? 40 : 22);
    return {
      dir,
      strength: (base + velocityPush + verticalKick) * closeness,
      bump: closeness > 0.62 || speed > (this.interactionMode === "enhanced" ? 280 : 210),
    };
  }

  private intersects(p: Platform, pad: number): boolean {
    return !(
      this.x + this.windowWidth < p.x - pad ||
      this.x > p.x + p.width + pad ||
      this.y + this.windowHeight < p.y - pad ||
      this.y > p.y + p.height + pad
    );
  }

  private clampImpulse(value: number, max: number): number {
    if (Math.abs(value) <= max) return value;
    return Math.sign(value) * max;
  }

  /** Safety: catch any escape and reset */
  private safetyClamp(): void {
    if (!this.bounds || this.state === "dragged") return;
    const b = this.bounds;
    const safe = 50; // tight margin

    let needsReset = false;
    if (this.x < b.x - safe || this.x > b.x + b.width + safe) needsReset = true;
    if (this.y < b.y - safe || this.y > b.y + b.height + safe) needsReset = true;

    // Also: if on a support surface but Y drifted
    if (["idle", "walk", "run", "hitWall", "slide", "landing", "dizzy", "perch", "pushed"].includes(this.state)) {
      const floor = this.resolveFloorY(this.x, this.y);
      if (Math.abs(this.y - floor) > 18) needsReset = true;
    }

    if (needsReset) {
      console.warn("[Physics] Pet out of bounds, resetting.", { x: this.x, y: this.y, state: this.state });
      this.x = b.x + b.width / 2 - this.windowWidth / 2;
      this.y = this.groundY;
      this.floorY = this.groundY;
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

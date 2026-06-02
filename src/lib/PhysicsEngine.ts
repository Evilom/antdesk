/**
 * PhysicsEngine — Desktop pet surface-walking physics.
 *
 * Surface model:
 *   - Pet walks on the PERIMETER of screen and window rectangles
 *   - "top" surface = floor (pet stands on it, gravity pulls down)
 *   - "right" surface = right wall (pet stands on it, gravity pulls left)
 *   - "left" surface = left wall (pet stands on it, gravity pulls right)
 *   - At corners, pet transitions between adjacent surfaces
 *   - Walking off any edge → falling → lands on next surface below
 *   - Anti-stuck: small random nudge when velocity is zero at edge
 *
 * States:
 *   idle    — standing on surface, pausing
 *   walk    — walking along surface
 *   falling — in the air, gravity pulling down
 *   dizzy   — stunned after landing (brief)
 *   dragged — held by user (physics paused)
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type PetState = "idle" | "walk" | "falling" | "dizzy" | "dragged";
export type SurfaceSide = "top" | "right" | "left" | "bottom";

interface ScreenBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
}

/**
 * A walkable surface — one edge of a rectangle.
 * - "top"    = horizontal, pet stands on it (floor)
 * - "right"  = vertical, pet clings to right wall
 * - "left"   = vertical, pet clings to left wall
 * - "bottom" = ceiling (not typically walkable)
 */
export interface Platform {
  x: number;
  y: number;
  width: number;
  height: number;
  source: "screen" | "window";
  name?: string;
}

interface Surface {
  side: SurfaceSide;
  x: number;
  y: number;
  length: number;
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
  /** Enable wall walking (perimeter mode). Default true. */
  wallWalk?: boolean;
  onStateChange?: (state: PetState) => void;
  onFacingChange?: (dir: 1 | -1) => void;
  onSurfaceChange?: (side: SurfaceSide) => void;
}

export class PhysicsEngine {
  // World position (physical screen pixels)
  private worldX = 0;
  private worldY = 0;
  private prevWorldX = 0;
  private prevWorldY = 0;

  // Velocity in surface-local coords (logical px/sec)
  private localV = 0;
  private fallVx = 0;
  private fallVy = 0;

  // State
  private state: PetState = "idle";
  private running = false;
  private rafId = 0;
  private lastTime = 0;

  // Surface
  private bounds: ScreenBounds | null = null;
  private groundY = 0;
  private platforms: Platform[] = [];
  private surfaces: Surface[] = [];
  private currentSurface: Surface = { side: "top", x: 0, y: 0, length: 1920, source: "screen" };
  private lockedToSurface = false;
  private positionLocked = false;

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
  private wallWalk: boolean;

  // Callbacks
  private onStateChange?: (state: PetState) => void;
  private onFacingChange?: (dir: 1 | -1) => void;
  private onSurfaceChange?: (side: SurfaceSide) => void;

  // Bound handlers
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
    this.edgePadding = options.edgePadding ?? 16;
    this.gravity = options.gravity ?? 900;
    this.dizzyDuration = options.dizzyDuration ?? 1.5;
    this.bounceFactor = options.bounceFactor ?? 0.3;
    this.wallWalk = options.wallWalk ?? true;
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

    try {
      this.bounds = await invoke<ScreenBounds>("get_screen_bounds");
    } catch {
      this.bounds = { x: 0, y: 25, width: 1920, height: 990, scale: 1 };
    }

    this.recomputeGround();
    this.rebuildSurfaces();

    try {
      const pos = await getCurrentWindow().outerPosition();
      this.worldX = pos.x;
      this.worldY = pos.y;
    } catch {}

    if (Math.abs(this.worldY - this.groundY) < 10 * (this.bounds?.scale ?? 1)) {
      this.worldY = this.groundY;
    }

    this.currentSurface = this.surfaces.find(s => s.side === "top" && s.source === "screen")
      ?? { side: "top", x: 0, y: this.groundY, length: 1920, source: "screen" };
    this.lockedToSurface = true;
    this.positionLocked = true;
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

  setPlatforms(platforms: Platform[]): void {
    this.platforms = platforms;
    this.rebuildSurfaces();
  }

  refreshPlatforms(newPlatforms: Platform[]): void {
    this.platforms = newPlatforms;
    this.rebuildSurfaces();

    // Check if current surface still exists
    const stillExists = this.surfaces.some(s =>
      s.side === this.currentSurface.side &&
      s.source === this.currentSurface.source &&
      s.name === this.currentSurface.name &&
      Math.abs(s.x - this.currentSurface.x) < 5 &&
      Math.abs(s.y - this.currentSurface.y) < 5
    );

    if (!stillExists && this.state !== "dragged") {
      this.lockedToSurface = false;
      this.fallVx = this.localV * 0.3;
      this.fallVy = 0;
      this.localV = 0;
      this.setState("falling");
    }
  }

  // ── Drag support ──

  onDragStart(): void {
    this.setState("dragged");
    this.lockedToSurface = false;
  }

  onDragEnd(vx: number, vy: number): void {
    this.fallVx = vx * 0.4;
    this.fallVy = vy * 0.3;

    getCurrentWindow().outerPosition().then(pos => {
      this.worldX = pos.x;
      this.worldY = pos.y;
      this.lockedToSurface = false;
      this.setState("falling");
    }).catch(() => {
      this.lockedToSurface = false;
      this.setState("falling");
    });
  }

  getState(): PetState { return this.state; }
  getSurfaceSide(): SurfaceSide { return this.currentSurface.side; }

  // ── Private ──

  private setState(s: PetState): void {
    if (s === this.state) return;
    this.state = s;
    this.onStateChange?.(s);
  }

  private setSurface(s: Surface): void {
    const changed = s.side !== this.currentSurface.side ||
      s.source !== this.currentSurface.source ||
      s.name !== this.currentSurface.name;
    this.currentSurface = s;
    if (changed) this.onSurfaceChange?.(s.side);
  }

  private get petW(): number {
    return this.windowWidth * (this.bounds?.scale ?? 1);
  }

  private get petH(): number {
    return this.windowHeight * (this.bounds?.scale ?? 1);
  }

  /** Rebuild surfaces from screen bounds + window platforms. */
  private rebuildSurfaces(): void {
    if (!this.bounds) return;
    const b = this.bounds;
    const pad = this.edgePadding * b.scale;

    const surfaces: Surface[] = [
      // Screen edges
      { side: "top", x: b.x + pad, y: this.groundY, length: b.width - pad * 2, source: "screen" },
    ];

    if (this.wallWalk) {
      surfaces.push(
        { side: "right", x: b.x + b.width - pad, y: b.y + pad, length: b.height - pad * 2, source: "screen" },
        { side: "left", x: b.x + pad, y: b.y + pad, length: b.height - pad * 2, source: "screen" },
      );
    }

    // Window platforms → top surface (and optionally perimeter)
    for (const p of this.platforms) {
      if (p.y >= this.groundY) continue;
      surfaces.push({
        side: "top",
        x: p.x + pad,
        y: p.y,
        length: p.width - pad * 2,
        source: "window",
        name: p.name,
      });
      if (this.wallWalk) {
        surfaces.push(
          { side: "right", x: p.x + p.width - pad, y: p.y + pad, length: p.height - pad * 2, source: "window", name: p.name },
          { side: "left", x: p.x + pad, y: p.y + pad, length: p.height - pad * 2, source: "window", name: p.name },
        );
      }
    }

    this.surfaces = surfaces;
  }

  private recomputeGround(): void {
    if (!this.bounds) return;
    const scale = this.bounds.scale;
    const pad = this.edgePadding * scale;
    this.groundY = this.bounds.y + this.bounds.height - this.windowHeight * scale - pad;
  }

  private setHorizontalRandomDirection(): void {
    this.localV = (Math.random() > 0.5 ? 1 : -1) * this.walkSpeed;
    this.directionTimer = this.directionChangeInterval * (0.7 + Math.random() * 0.6);
    this.onFacingChange?.(this.localV >= 0 ? 1 : -1);
  }

  private tick(nowMs: number): void {
    if (!this.running) return;
    const now = nowMs / 1000;
    const dt = Math.min(now - this.lastTime, 0.1);
    this.lastTime = now;

    switch (this.state) {
      case "dragged": break;
      case "dizzy": this.tickDizzy(dt); break;
      case "falling": this.tickFalling(dt); break;
      case "idle": this.tickIdle(dt); break;
      case "walk": this.tickWalk(dt); break;
    }

    this.rafId = requestAnimationFrame(this.tick.bind(this));
  }

  // ── State handlers ──

  private tickDizzy(dt: number): void {
    this.lockSurfacePosition();
    this.dizzyTimer -= dt;
    if (this.dizzyTimer <= 0) {
      this.setHorizontalRandomDirection();
      this.setState("walk");
    }
  }

  private tickIdle(dt: number): void {
    this.lockSurfacePosition();
    this.idleTimer -= dt;
    if (this.idleTimer <= 0) {
      this.setHorizontalRandomDirection();
      this.setState("walk");
    }
  }

  private tickWalk(dt: number): void {
    this.lockSurfacePosition();

    this.directionTimer -= dt;
    if (this.directionTimer <= 0) {
      if (Math.random() < this.idleProbability) {
        this.localV = 0;
        this.idleTimer = this.idleDurationMin + Math.random() * (this.idleDurationMax - this.idleDurationMin);
        this.setState("idle");
        return;
      }
      this.setHorizontalRandomDirection();
    }

    // Mouse attraction
    if (this.mouseAttraction > 0 && this.bounds) {
      const s = this.currentSurface;
      const scale = this.bounds.scale;
      const petCenterX = this.worldX + this.petW / 2;
      const petCenterY = this.worldY + this.petH / 2;
      let localMouseOffset = 0;
      const maxDist = this.mouseAttractionDistance * scale;

      if (s.side === "top") {
        const dx = this.mouseX - petCenterX;
        if (Math.abs(dx) < maxDist && Math.abs(dx) > 10) {
          localMouseOffset = dx;
        }
      } else if (s.side === "right") {
        const dy = this.mouseY - petCenterY;
        if (Math.abs(dy) < maxDist && Math.abs(dy) > 10) {
          localMouseOffset = -dy;
        }
      } else if (s.side === "left") {
        const dy = this.mouseY - petCenterY;
        if (Math.abs(dy) < maxDist && Math.abs(dy) > 10) {
          localMouseOffset = dy;
        }
      }

      if (localMouseOffset !== 0) {
        const str = this.mouseAttraction * (1 - Math.abs(localMouseOffset) / maxDist);
        this.localV += Math.sign(localMouseOffset) * str * this.walkSpeed;
        const max = this.walkSpeed * 1.5;
        if (Math.abs(this.localV) > max) this.localV = Math.sign(this.localV) * max;
      }
    }

    // Advance along surface
    const newT = this.surfaceT() + this.localV * dt;
    const maxT = this.currentSurface.length;

    // Corner check (only for screen surfaces, forward direction)
    if (this.wallWalk && this.currentSurface.source === "screen") {
      if (newT > maxT - 5 && this.localV > 0) {
        if (this.tryCornerTransition("end")) return;
      } else if (newT < 5 && this.localV < 0) {
        if (this.tryCornerTransition("start")) return;
      }
    }

    // Edge bounce
    if (newT < 0 || newT > maxT) {
      this.localV = -this.localV;
      this.localV += (Math.random() - 0.5) * this.walkSpeed * 0.3;
      this.onFacingChange?.(this.localV >= 0 ? 1 : -1);

      // Anti-stuck: if velocity is very small, give a kick
      if (Math.abs(this.localV) < this.walkSpeed * 0.2) {
        this.localV = (Math.random() > 0.5 ? 1 : -1) * this.walkSpeed * 0.6;
      }
      return;
    }

    this.setSurfaceT(newT);
    this.positionLocked = false;
    this.moveWindow();
  }

  private tickFalling(dt: number): void {
    const scale = this.bounds?.scale ?? 1;
    const g = this.gravity * scale;

    this.fallVy += g * dt;
    this.fallVx *= 0.995;

    let nx = this.worldX + this.fallVx * dt;
    let ny = this.worldY + this.fallVy * dt;
    const bottom = ny + this.petH;

    // Check all "top" surfaces for landing
    let bestSurface: Surface | null = null;
    let bestDist = Infinity;

    for (const s of this.surfaces) {
      if (s.side !== "top") continue;
      if (s.y >= this.groundY && bestSurface) continue;

      const prevBottom = this.worldY + this.petH;
      if (prevBottom <= s.y + 4 && bottom >= s.y - 4) {
        const cx = nx + this.petW / 2;
        const sx = s.x;
        const sw = s.length;
        if (cx >= sx - 20 && cx <= sx + sw + 20) {
          const dist = s.y - prevBottom;
          if (dist < bestDist) {
            bestDist = dist;
            bestSurface = s;
          }
        }
      }
    }

    // Check screen ground
    if (ny >= this.groundY && !bestSurface) {
      bestSurface = this.surfaces.find(s => s.side === "top" && s.source === "screen")
        ?? { side: "top", x: 0, y: this.groundY, length: 1920, source: "screen" };
    }

    if (bestSurface) {
      ny = bestSurface.y;
      if (this.fallVy > 50 * scale && bestSurface.source === "screen") {
        this.fallVy = -this.fallVy * this.bounceFactor;
        this.fallVx *= 0.8;
      } else {
        this.fallVy = 0;
        this.fallVx = 0;
        this.worldY = ny;
        this.setSurface(bestSurface);
        this.lockedToSurface = true;
        this.positionLocked = true;

        // Compute surface T from world X
        const t = this.worldX - bestSurface.x;
        this.clampSurfaceT(t);

        this.dizzyTimer = this.dizzyDuration;
        this.localV = 0;
        this.setState("dizzy");
        return;
      }
    }

    // Horizontal clamp
    if (this.bounds) {
      const minX = this.bounds.x;
      const maxX = this.bounds.x + this.bounds.width - this.petW;
      nx = Math.max(minX, Math.min(maxX, nx));
    }

    this.worldX = nx;
    this.worldY = ny;
    this.moveWindow();
  }

  // ── Surface coordinate helpers ──

  /** Get current position as parameter t along the surface (0 = start, length = end). */
  private surfaceT(): number {
    const s = this.currentSurface;
    switch (s.side) {
      case "top": return this.worldX - s.x;
      case "right": return s.y + s.length - (this.worldY + this.petH);
      case "left": return this.worldY - s.y;
      default: return 0;
    }
  }

  /** Set position along surface from parameter t. */
  private setSurfaceT(t: number): void {
    const s = this.currentSurface;
    switch (s.side) {
      case "top":
        this.worldX = s.x + t;
        break;
      case "right":
        this.worldY = s.y + s.length - t - this.petH;
        this.worldX = s.x - this.petW;
        break;
      case "left":
        this.worldY = s.y + t;
        this.worldX = s.x - this.petW;
        break;
    }
  }

  /** Clamp t to valid range and update world position. */
  private clampSurfaceT(t: number): void {
    const s = this.currentSurface;
    const clamped = Math.max(0, Math.min(s.length, t));
    this.setSurfaceT(clamped);
  }

  /** Lock pet to current surface position (for idle/dizzy). */
  private lockSurfacePosition(): void {
    if (!this.positionLocked && this.lockedToSurface) {
      const t = this.surfaceT();
      this.clampSurfaceT(t);
      this.positionLocked = true;
    }
  }

  /** Try to transition around a corner. Returns true if transitioned. */
  private tryCornerTransition(end: "start" | "end"): boolean {
    const s = this.currentSurface;
    if (s.source !== "screen" || !this.bounds) return false;

    const b = this.bounds;
    const pad = this.edgePadding * b.scale;
    const t = end === "end" ? s.length : 0;
    let target: Surface | null = null;

    if (s.side === "top" && end === "end") {
      // Ground → Right wall
      target = this.surfaces.find(sc => sc.side === "right" && sc.source === "screen") ?? null;
      if (target) {
        const newT = Math.max(0, Math.min(target.length, b.height - pad - this.petH));
        this.setSurface(target);
        this.setSurfaceT(newT);
        this.localV = -Math.abs(this.localV);
      }
    } else if (s.side === "top" && end === "start") {
      // Ground → Left wall
      target = this.surfaces.find(sc => sc.side === "left" && sc.source === "screen") ?? null;
      if (target) {
        const newT = Math.max(0, Math.min(target.length, b.height - pad - this.petH));
        this.setSurface(target);
        this.setSurfaceT(newT);
        this.localV = Math.abs(this.localV);
      }
    } else if (s.side === "right" && end === "start") {
      // Right wall bottom → Ground
      target = this.surfaces.find(sc => sc.side === "top" && sc.source === "screen") ?? null;
      if (target) {
        const newT = Math.max(0, Math.min(target.length, target.length - this.petW));
        this.setSurface(target);
        this.setSurfaceT(newT);
        this.localV = -Math.abs(this.localV);
      }
    } else if (s.side === "right" && end === "end") {
      // Right wall top → (ceiling, skip)
      return false;
    } else if (s.side === "left" && end === "end") {
      // Left wall bottom → Ground
      target = this.surfaces.find(sc => sc.side === "top" && sc.source === "screen") ?? null;
      if (target) {
        const newT = Math.max(0, Math.min(target.length, this.petW));
        this.setSurface(target);
        this.setSurfaceT(newT);
        this.localV = Math.abs(this.localV);
      }
    } else if (s.side === "left" && end === "start") {
      // Left wall top → (ceiling, skip)
      return false;
    }

    if (target) {
      this.lockedToSurface = true;
      this.positionLocked = false;
      this.directionTimer = this.directionChangeInterval;
      this.onFacingChange?.(this.localV >= 0 ? 1 : -1);
      this.moveWindow();
      return true;
    }
    return false;
  }

  private moveWindow(): void {
    const dx = Math.abs(Math.round(this.worldX) - Math.round(this.prevWorldX));
    const dy = Math.abs(Math.round(this.worldY) - Math.round(this.prevWorldY));
    if (dx >= 1 || dy >= 1) {
      this.prevWorldX = this.worldX;
      this.prevWorldY = this.worldY;
      getCurrentWindow().setPosition({
        type: "Physical",
        x: Math.round(this.worldX),
        y: Math.round(this.worldY),
      } as any).catch(() => {});
    }
  }
}

/**
 * StateArbiter — Priority-based state resolution system.
 *
 * Multiple sources (physics, brain, notifications, user) request states.
 * The arbiter resolves to the HIGHEST priority active state.
 *
 * Inspired by clawd-on-desk's state-priority.js
 *
 * Priority levels:
 *   8  — error (critical)
 *   7  — notification (urgent alert)
 *   6  — celebrate (task completed)
 *   5  — anxious (overdue tasks)
 *   4  — interact (user clicked)
 *   3  — working (notion awareness)
 *   2  — explore (curious behavior)
 *   1  — idle/walk/run (default locomotion)
 *   0  — sleep (deepest rest)
 *
 * Oneshot states: play once, then auto-expire back to lower priority.
 * Continuous states: stay active until explicitly removed.
 */

export type StateSource = "physics" | "brain" | "notification" | "user" | "emotion";

export interface StateRequest {
  state: string;
  source: StateSource;
  /** If true, auto-removes after durationMs */
  oneshot?: boolean;
  /** Duration in ms for oneshot states */
  durationMs?: number;
  /** Priority override (otherwise uses default) */
  priority?: number;
}

const DEFAULT_PRIORITY: Record<string, number> = {
  // High priority
  error:        8,
  notification: 7,
  celebrate:    6,
  // Medium priority
  anxious:      5,
  interact:     4,
  working:      3,
  // Low priority
  explore:      2,
  idle:         1,
  walk:         1,
  run:          1,
  jump:         2,
  falling:      2,
  landing:      2,
  dizzy:        2,
  hitWall:      2,
  slide:        2,
  perch:        2,
  bumped:       2,
  pushed:       2,
  dragged:      1,
  // Deepest
  sleep:        0,
  dozing:       0,
  yawn:         0,
};

const ONESHOT_STATES = new Set(["error", "notification", "celebrate", "interact", "yawn"]);

export class StateArbiter {
  private activeRequests = new Map<string, StateRequest>();
  private resolvedState: string = "idle";
  private oneshotTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private onResolved?: (state: string, prev: string) => void;
  private defaultPriority: Record<string, number>;

  constructor(options?: {
    onResolved?: (state: string, prev: string) => void;
    priorityMap?: Record<string, number>;
  }) {
    this.onResolved = options?.onResolved;
    this.defaultPriority = { ...DEFAULT_PRIORITY, ...options?.priorityMap };
  }

  /**
   * Request a state from a source.
   * If the key already exists, updates it.
   */
  request(req: StateRequest): void {
    const key = `${req.source}:${req.state}`;

    // Continuous sources represent one current state at a time.
    // Without this, equal-priority physics states can get stuck behind older entries.
    if (!req.oneshot) {
      for (const existingKey of Array.from(this.activeRequests.keys())) {
        if (existingKey.startsWith(`${req.source}:`) && existingKey !== key) {
          this.activeRequests.delete(existingKey);
          if (this.oneshotTimers.has(existingKey)) {
            clearTimeout(this.oneshotTimers.get(existingKey)!);
            this.oneshotTimers.delete(existingKey);
          }
        }
      }
    }

    // Clear existing oneshot timer for this key
    if (this.oneshotTimers.has(key)) {
      clearTimeout(this.oneshotTimers.get(key)!);
      this.oneshotTimers.delete(key);
    }

    this.activeRequests.set(key, req);

    // Auto-expire oneshot states
    const isOneshot = req.oneshot ?? ONESHOT_STATES.has(req.state);
    if (isOneshot) {
      const duration = req.durationMs ?? this.getDefaultDuration(req.state);
      const timer = setTimeout(() => {
        this.activeRequests.delete(key);
        this.oneshotTimers.delete(key);
        this.resolve();
      }, duration);
      this.oneshotTimers.set(key, timer);
    }

    this.resolve();
  }

  /**
   * Remove a specific state request.
   */
  revoke(source: StateSource, state: string): void {
    const key = `${source}:${state}`;
    if (this.activeRequests.has(key)) {
      this.activeRequests.delete(key);
      if (this.oneshotTimers.has(key)) {
        clearTimeout(this.oneshotTimers.get(key)!);
        this.oneshotTimers.delete(key);
      }
      this.resolve();
    }
  }

  /**
   * Remove all requests from a source.
   */
  revokeSource(source: StateSource): void {
    let changed = false;
    for (const [key, req] of this.activeRequests) {
      if (req.source === source) {
        this.activeRequests.delete(key);
        if (this.oneshotTimers.has(key)) {
          clearTimeout(this.oneshotTimers.get(key)!);
          this.oneshotTimers.delete(key);
        }
        changed = true;
      }
    }
    if (changed) this.resolve();
  }

  /**
   * Get the current resolved state.
   */
  getState(): string {
    return this.resolvedState;
  }

  /**
   * Get the priority of the current resolved state.
   */
  getPriority(): number {
    return this.getEffectivePriority(this.resolvedState);
  }

  /**
   * Check if a state of at least the given priority is active.
   */
  isAtLeast(priority: number): boolean {
    return this.getPriority() >= priority;
  }

  /**
   * Clean up all timers.
   */
  dispose(): void {
    for (const timer of this.oneshotTimers.values()) {
      clearTimeout(timer);
    }
    this.oneshotTimers.clear();
    this.activeRequests.clear();
  }

  // ── Private ──

  private resolve(): void {
    let bestState = "idle";
    let bestPriority = -1;

    for (const req of this.activeRequests.values()) {
      const priority = req.priority ?? this.getEffectivePriority(req.state);
      if (priority > bestPriority) {
        bestPriority = priority;
        bestState = req.state;
      }
    }

    if (bestState !== this.resolvedState) {
      const prev = this.resolvedState;
      this.resolvedState = bestState;
      this.onResolved?.(bestState, prev);
    }
  }

  private getEffectivePriority(state: string): number {
    return this.defaultPriority[state] ?? 1;
  }

  private getDefaultDuration(state: string): number {
    switch (state) {
      case "notification": return 6000;
      case "celebrate":    return 4000;
      case "error":        return 8000;
      case "interact":     return 2000;
      case "yawn":         return 3000;
      default:             return 5000;
    }
  }
}

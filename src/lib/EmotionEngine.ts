/**
 * EmotionEngine — Multi-dimensional emotion system for the desktop pet.
 *
 * Three axes, each 0–100:
 *   happiness  — affected by task completion, user interaction, overdue tasks
 *   energy     — consumed by activity, restored by rest and sleep
 *   curiosity  — drives exploration, decays with repetition
 *
 * Emotion affects behavior selection probability:
 *   high happiness → more explore/sprint, less rest
 *   low energy     → more rest, slower walk
 *   high curiosity → more explore, approach mouse
 *
 * Inspired by Agentic-Desktop-Pet's emotion system.
 */

export interface EmotionState {
  happiness: number;  // 0-100
  energy: number;     // 0-100
  curiosity: number;  // 0-100
}

/** Behavior weights derived from emotion */
export interface BehaviorWeights {
  stroll: number;
  sprint: number;
  explore: number;
  rest: number;
  chase: number;
}

export type EmotionEvent =
  | "task_completed"     // +20 happiness, +5 energy
  | "task_overdue"       // -15 happiness, -5 energy
  | "task_created"       // +5 curiosity
  | "user_interaction"   // +8 happiness, +5 curiosity
  | "notification"       // +3 curiosity
  | "long_idle"          // -3 curiosity, +2 energy
  | "exploring"          // +1 curiosity, -1 energy
  | "sprinting"          // -2 energy
  | "sleeping"           // +8 energy, +1 happiness
  | "report_written"     // +15 happiness
  | "morning_start"      // +10 energy, +5 curiosity
  | "evening"            // -5 energy, -3 curiosity
  ;

const DECAY_INTERVAL_MS = 60000; // Decay every 60s
const CLAMP = (v: number) => Math.max(0, Math.min(100, v));

export class EmotionEngine {
  private state: EmotionState = { happiness: 50, energy: 80, curiosity: 60 };
  private decayTimer: ReturnType<typeof setInterval> | null = null;
  private onChange?: (state: EmotionState) => void;

  constructor(options?: {
    onChange?: (state: EmotionState) => void;
    initial?: Partial<EmotionState>;
  }) {
    this.onChange = options?.onChange;
    if (options?.initial) {
      this.state = { ...this.state, ...options.initial };
    }
  }

  start(): void {
    if (this.decayTimer) return;
    this.decayTimer = setInterval(() => this.decay(), DECAY_INTERVAL_MS);
  }

  stop(): void {
    if (this.decayTimer) { clearInterval(this.decayTimer); this.decayTimer = null; }
  }

  getState(): Readonly<EmotionState> { return this.state; }

  /**
   * Trigger an emotion event.
   */
  emit(event: EmotionEvent): void {
    switch (event) {
      case "task_completed":
        this.adjust({ happiness: 20, energy: 5 });
        break;
      case "task_overdue":
        this.adjust({ happiness: -15, energy: -5 });
        break;
      case "task_created":
        this.adjust({ curiosity: 5 });
        break;
      case "user_interaction":
        this.adjust({ happiness: 8, curiosity: 5 });
        break;
      case "notification":
        this.adjust({ curiosity: 3 });
        break;
      case "long_idle":
        this.adjust({ curiosity: -3, energy: 2 });
        break;
      case "exploring":
        this.adjust({ curiosity: 1, energy: -1 });
        break;
      case "sprinting":
        this.adjust({ energy: -2 });
        break;
      case "sleeping":
        this.adjust({ energy: 8, happiness: 1 });
        break;
      case "report_written":
        this.adjust({ happiness: 15 });
        break;
      case "morning_start":
        this.adjust({ energy: 10, curiosity: 5 });
        break;
      case "evening":
        this.adjust({ energy: -5, curiosity: -3 });
        break;
    }
  }

  /**
   * Get behavior weights based on current emotion.
   * Weights are normalized to sum to 1.
   */
  getBehaviorWeights(): BehaviorWeights {
    const { happiness, energy, curiosity } = this.state;

    // Base weights
    let stroll = 35;
    let sprint = 15;
    let explore = 20;
    let rest = 15;
    let chase = 15;

    // Happiness: high → more active behaviors
    const happyFactor = (happiness - 50) / 50; // -1 to 1
    stroll -= happyFactor * 5;
    sprint += happyFactor * 8;
    explore += happyFactor * 5;
    rest -= happyFactor * 8;

    // Energy: low → more rest, slower
    const energyFactor = (energy - 50) / 50; // -1 to 1
    stroll += energyFactor * 3;
    sprint += energyFactor * 10;
    rest -= energyFactor * 15;
    if (energy < 20) {
      rest += 25; // Very tired → mostly rest
      sprint = Math.max(0, sprint - 10);
    }

    // Curiosity: high → more explore and chase
    const curiousFactor = (curiosity - 50) / 50; // -1 to 1
    explore += curiousFactor * 10;
    chase += curiousFactor * 8;
    rest -= curiousFactor * 5;

    // Clamp all to >= 0
    stroll = Math.max(0, stroll);
    sprint = Math.max(0, sprint);
    explore = Math.max(0, explore);
    rest = Math.max(0, rest);
    chase = Math.max(0, chase);

    // Normalize
    const total = stroll + sprint + explore + rest + chase;
    if (total <= 0) return { stroll: 0.5, sprint: 0, explore: 0, rest: 0.5, chase: 0 };

    return {
      stroll: stroll / total,
      sprint: sprint / total,
      explore: explore / total,
      rest: rest / total,
      chase: chase / total,
    };
  }

  /**
   * Get a mood string for display (used by thought bubble).
   */
  getMoodText(): { emoji: string; text: string } {
    const { happiness, energy, curiosity } = this.state;

    if (energy < 15) return { emoji: "😴", text: "好累..." };
    if (happiness > 80) return { emoji: "😄", text: "心情超好!" };
    if (happiness < 20) return { emoji: "😢", text: "有点难过" };
    if (curiosity > 80) return { emoji: "🧐", text: "好想去探索!" };
    if (energy > 80 && curiosity > 60) return { emoji: "⚡", text: "精力充沛!" };
    if (happiness > 60 && energy > 60) return { emoji: "😊", text: "状态不错~" };
    if (energy < 40) return { emoji: "😪", text: "有点困" };
    if (curiosity < 20) return { emoji: "😑", text: "无聊..." };

    return { emoji: "😊", text: "~" };
  }

  dispose(): void {
    this.stop();
  }

  // ── Private ──

  private adjust(delta: Partial<EmotionState>): void {
    const prev = { ...this.state };
    if (delta.happiness !== undefined) this.state.happiness = CLAMP(this.state.happiness + delta.happiness);
    if (delta.energy !== undefined) this.state.energy = CLAMP(this.state.energy + delta.energy);
    if (delta.curiosity !== undefined) this.state.curiosity = CLAMP(this.state.curiosity + delta.curiosity);

    // Notify if changed
    if (this.state.happiness !== prev.happiness ||
        this.state.energy !== prev.energy ||
        this.state.curiosity !== prev.curiosity) {
      this.onChange?.(this.state);
    }
  }

  /** Natural decay every interval */
  private decay(): void {
    // Happiness: slow natural decay toward 50
    if (this.state.happiness > 55) this.state.happiness -= 1;
    if (this.state.happiness < 45) this.state.happiness += 1;

    // Energy: slow decay when active
    this.state.energy = CLAMP(this.state.energy - 0.5);

    // Curiosity: moderate decay
    this.state.curiosity = CLAMP(this.state.curiosity - 1);

    this.onChange?.(this.state);
  }
}

/**
 * PetBrain v2 — 桌面宠物行为状态机 + 双源感知 (Notion + Hermes Kanban)
 *
 * 双层架构:
 * - BehaviorState (idle/walk/interact/sleep) — 行为状态机，驱动动画
 * - PetMode (leisure/busy/anxious/alert/celebrate) — 待办感知模式，调节转换权重
 *
 * v2: 新增 Hermes Kanban 感知，融合 Notion todos + agentmemory actions
 */

import type { KanbanData } from "../types/kanban";

// ========== 类型定义 ==========

export type BehaviorState = "idle" | "walk" | "interact" | "sleep";
export type PetMode = "leisure" | "busy" | "anxious" | "alert" | "celebrate";

export interface PetBrainCallbacks {
  /** 行为状态变化 → (state, animName) */
  onBehaviorChange: (state: BehaviorState, anim: string) => void;
  /** 待办模式变化 → PhysicsEngine 参数调整 */
  onModeChange: (mode: PetMode) => void;
  /** 心情文字变化 */
  onMoodChange: (mood: string) => void;
  /** 逾期通知 */
  onNotify: (message: string) => void;
  /** 看板事件通知 (新任务/完成/阻塞) */
  onKanbanEvent?: (event: string, detail: string) => void;
}

interface TodoStatus {
  total: number;
  completed: number;
  overdue: number;
  dueToday: number;
}

interface KanbanStatus {
  pending: number;
  active: number;
  blocked: number;
  highPriority: number;
  completedToday: number;
}

interface BehaviorConfig {
  anims: string[];
  duration: [number, number];
  loop: boolean;
  mood: string;
  transitions: Partial<Record<BehaviorState, number>>;
}

// ========== 行为状态配置 ==========

const BEHAVIOR_CONFIG: Record<BehaviorState, BehaviorConfig> = {
  idle: {
    anims: ["stand", "idle"],
    duration: [3000, 8000],
    loop: true,
    mood: "😊",
    transitions: { walk: 40, interact: 20, sleep: 10 },
  },
  walk: {
    anims: ["move", "walk", "run"],
    duration: [5000, 15000],
    loop: true,
    mood: "🚶",
    transitions: { idle: 60, interact: 20 },
  },
  interact: {
    anims: ["touch", "play", "dance", "talk"],
    duration: [2000, 5000],
    loop: false,
    mood: "😄",
    transitions: { idle: 70, walk: 20 },
  },
  sleep: {
    anims: ["sleep", "sit", "stand"],
    duration: [15000, 30000],
    loop: true,
    mood: "😴",
    transitions: { idle: 100 },
  },
};

// ========== 待办模式对行为权重的影响 ==========

const MODE_WEIGHT_MODS: Record<
  PetMode,
  Partial<Record<BehaviorState, number>>
> = {
  leisure: { idle: 1.5, walk: 0.8, interact: 1.2, sleep: 1.0 },
  busy: { walk: 1.3, idle: 0.8, interact: 0.9, sleep: 0.8 },
  anxious: { walk: 1.8, idle: 0.5, interact: 0.7, sleep: 0.6 },
  alert: { walk: 2.0, idle: 0.3, interact: 0.5, sleep: 0.4 },
  celebrate: { interact: 2.0, idle: 1.2, walk: 0.6, sleep: 1.0 },
};

// ========== 待办模式心情 ==========

const MODE_MOODS: Record<PetMode, string[]> = {
  leisure: ["(^・ω・^)", "(=^・ω・^=)", "٩(◕‿◕)۶", "(｡♥‿♥｡)"],
  busy: ["(´・ω・`)", "(・_・;)", "m(_ _)m"],
  anxious: ["(;;ω;;)", "(´;ω;`)", "Σ(°△°|||)"],
  alert: ["(╯°□°)╯", "⚠️ ᕙ(⇀‸↼‶)ᕗ", "‼️ (ﾉꐦ ⊱ ꐦ)ﾉ"],
  celebrate: ["(*≧ω≦)", "(ﾉ◕ヮ◕)ﾉ*:・ﾟ✧", "✨ ╰(*°▽°*)╯ ✨"],
};

// ========== 待办模式对应的 PhysicsEngine 参数 ==========

export const MODE_PHYSICS: Record<
  PetMode,
  { walkSpeed: number; idleProbability: number }
> = {
  leisure: { walkSpeed: 40, idleProbability: 0.3 },
  busy: { walkSpeed: 50, idleProbability: 0.2 },
  anxious: { walkSpeed: 70, idleProbability: 0.1 },
  alert: { walkSpeed: 80, idleProbability: 0.05 },
  celebrate: { walkSpeed: 35, idleProbability: 0.35 },
};

// ========== 常量 ==========

const SLEEP_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_OVER_60S_SLEEP_BONUS = 40;

// ========== PetBrain 类 ==========

export class PetBrain {
  private behavior: BehaviorState = "idle";
  private behaviorTimer: ReturnType<typeof setTimeout> | null = null;

  private mode: PetMode = "leisure";
  private mood = "(^・ω・^)";
  private prevMode: PetMode = "leisure";

  private lastInteraction = Date.now();
  private sleepCheckTimer: ReturnType<typeof setInterval> | null = null;

  private todoPollTimer: ReturnType<typeof setInterval> | null = null;
  private todoStatus: TodoStatus = {
    total: 0, completed: 0, overdue: 0, dueToday: 0,
  };

  // v2: Kanban status
  private kanbanStatus: KanbanStatus = {
    pending: 0, active: 0, blocked: 0, highPriority: 0, completedToday: 0,
  };
  private prevKanbanStats = { pending: 0, active: 0, blocked: 0, completedToday: 0 };

  private idleSeconds = 0;
  private idleCounterInterval: ReturnType<typeof setInterval> | null = null;

  private hasAnimation: ((name: string) => boolean) | null = null;

  private cb: PetBrainCallbacks;
  private disposed = false;

  constructor(callbacks: PetBrainCallbacks) {
    this.cb = callbacks;
  }

  setAnimationChecker(checker: (name: string) => boolean) {
    this.hasAnimation = checker;
  }

  // ── Lifecycle ──

  start() {
    this.scheduleSleepCheck();
    this.scheduleTodoPoll();
    this.startIdleCounter();
    this.enterBehavior("idle");
  }

  dispose() {
    this.disposed = true;
    if (this.behaviorTimer) clearTimeout(this.behaviorTimer);
    if (this.sleepCheckTimer) clearInterval(this.sleepCheckTimer);
    if (this.todoPollTimer) clearInterval(this.todoPollTimer);
    if (this.idleCounterInterval) clearInterval(this.idleCounterInterval);
  }

  /** Manual interaction — resets sleep timer, may trigger interact */
  interact() {
    this.lastInteraction = Date.now();
    this.idleSeconds = 0;
    if (this.behavior === "sleep") {
      this.enterBehavior("interact");
    }
  }

  getBehavior(): BehaviorState {
    return this.behavior;
  }

  getMode(): PetMode {
    return this.mode;
  }

  // v2: Accept kanban data from external source
  updateKanban(data: KanbanData) {
    const prev = this.prevKanbanStats;

    this.kanbanStatus = {
      pending: data.stats.pending,
      active: data.stats.active,
      blocked: data.stats.blocked,
      highPriority: data.actions.filter((a) => a.priority >= 7 && a.status !== "done").length,
      completedToday: data.stats.completedToday,
    };

    // Detect kanban events → notify
    if (data.stats.completedToday > prev.completedToday) {
      const diff = data.stats.completedToday - prev.completedToday;
      this.cb.onKanbanEvent?.("completed", `${diff} 个任务完成了！`);
      // Brief celebration
      if (this.behavior !== "sleep") {
        this.enterBehavior("interact");
      }
    }

    if (data.stats.blocked > prev.blocked) {
      this.cb.onKanbanEvent?.("blocked", `有 ${data.stats.blocked} 个任务被阻塞了`);
    }

    if (data.stats.active > prev.active) {
      const newActions = data.actions
        .filter((a) => a.status === "active")
        .slice(0, 2)
        .map((a) => a.title)
        .join(", ");
      if (newActions) {
        this.cb.onKanbanEvent?.("new", `新任务: ${newActions}`);
      }
    }

    this.prevKanbanStats = { ...data.stats };
    this.updateMode();
  }

  // ── Behavior State Machine ──

  private enterBehavior(state: BehaviorState) {
    if (this.disposed) return;
    if (this.behaviorTimer) clearTimeout(this.behaviorTimer);

    this.behavior = state;
    const config = BEHAVIOR_CONFIG[state];
    const anim = this.resolveAnim(config.anims);
    this.cb.onBehaviorChange(state, anim);

    this.mood = config.mood;
    this.cb.onMoodChange(this.mood);

    if (config.duration[1] !== Infinity) {
      const adjustedTransitions = this.adjustTransitions(state, config);
      const dur =
        config.duration[0] +
        Math.random() * (config.duration[1] - config.duration[0]);

      this.behaviorTimer = setTimeout(() => {
        if (!this.disposed) {
          this.transitionNext(adjustedTransitions);
        }
      }, dur);
    }
  }

  private adjustTransitions(
    state: BehaviorState,
    config: BehaviorConfig
  ): Partial<Record<BehaviorState, number>> {
    const transitions = { ...config.transitions };
    const mods = MODE_WEIGHT_MODS[this.mode];

    for (const [key, mod] of Object.entries(mods)) {
      const k = key as BehaviorState;
      if (transitions[k] !== undefined) {
        transitions[k] = (transitions[k] ?? 0) * mod;
      }
    }

    if (this.idleSeconds > 60 && transitions.sleep !== undefined) {
      transitions.sleep = (transitions.sleep ?? 0) + IDLE_OVER_60S_SLEEP_BONUS;
    }

    return transitions;
  }

  private transitionNext(
    transitions: Partial<Record<BehaviorState, number>>
  ) {
    const entries = Object.entries(transitions).filter(
      ([_, w]) => (w ?? 0) > 0
    ) as [BehaviorState, number][];

    if (entries.length === 0) {
      this.enterBehavior("idle");
      return;
    }

    const total = entries.reduce((sum, [_, w]) => sum + w, 0);
    let r = Math.random() * total;
    for (const [state, weight] of entries) {
      r -= weight;
      if (r <= 0) {
        this.enterBehavior(state);
        return;
      }
    }
    this.enterBehavior(entries[0][0]);
  }

  private resolveAnim(candidates: string[]): string {
    if (this.hasAnimation) {
      for (const name of candidates) {
        if (this.hasAnimation(name)) return name;
      }
    }
    return candidates[0];
  }

  // ========== 空闲计时 ==========

  private startIdleCounter() {
    this.idleCounterInterval = setInterval(() => {
      if (this.disposed) return;
      this.idleSeconds++;
    }, 1000);
  }

  // ========== 睡眠检测 ==========

  private scheduleSleepCheck() {
    this.sleepCheckTimer = setInterval(() => {
      if (this.disposed) return;
      const elapsed = Date.now() - this.lastInteraction;
      if (elapsed >= SLEEP_TIMEOUT_MS && this.behavior !== "sleep") {
        this.enterBehavior("sleep");
      }
    }, 30_000);
  }

  // ========== 待办轮询 (Notion) ==========

  private scheduleTodoPoll() {
    this.pollTodoStatus();
    this.todoPollTimer = setInterval(() => {
      if (this.disposed) return;
      this.pollTodoStatus();
    }, 30_000);
  }

  private pollTodoStatus() {
    try {
      const raw = localStorage.getItem("antdesk_todos");
      if (!raw) {
        this.setTodoStatus({ total: 0, completed: 0, overdue: 0, dueToday: 0 });
        return;
      }

      const todos: Array<{ status: boolean; dueDate?: string }> = JSON.parse(raw);
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);

      let overdue = 0;
      let dueToday = 0;

      for (const t of todos) {
        if (t.status) continue;
        if (t.dueDate) {
          const due = t.dueDate.slice(0, 10);
          if (due < todayStr) overdue++;
          else if (due === todayStr) dueToday++;
        }
      }

      this.setTodoStatus({
        total: todos.length,
        completed: todos.filter((t) => t.status).length,
        overdue,
        dueToday,
      });
    } catch (e) {
      console.warn("[PetBrain] todo poll failed:", e);
    }
  }

  private setTodoStatus(status: TodoStatus) {
    this.todoStatus = status;
    this.updateMode();
  }

  // ========== 双源模式更新 (Notion + Kanban) ==========

  private updateMode() {
    if (this.behavior === "sleep") return;

    const { overdue, dueToday, total, completed } = this.todoStatus;
    const kanban = this.kanbanStatus;

    let newMode: PetMode;

    // Kanban blocked → highest alert
    if (kanban.blocked > 0) {
      newMode = "alert";
    }
    // Notion overdue → alert
    else if (overdue > 0) {
      newMode = "alert";
    }
    // Kanban high priority tasks → anxious
    else if (kanban.highPriority > 2) {
      newMode = "anxious";
    }
    // Notion due today → anxious
    else if (dueToday > 0) {
      newMode = "anxious";
    }
    // All done (both sources) → celebrate
    else if (
      kanban.completedToday > 0 &&
      kanban.active === 0 &&
      kanban.blocked === 0 &&
      (total === 0 || completed >= total)
    ) {
      newMode = "celebrate";
    }
    // Active work → busy
    else if (kanban.active > 0 || total > 0) {
      newMode = "busy";
    }
    // Nothing to do → leisure
    else {
      newMode = "leisure";
    }

    if (newMode !== this.prevMode) {
      this.prevMode = this.mode;
      this.mode = newMode;
      this.cb.onModeChange(newMode);

      const moods = MODE_MOODS[newMode];
      this.mood = moods[Math.floor(Math.random() * moods.length)];
      this.cb.onMoodChange(this.mood);

      if (newMode === "alert" && kanban.blocked > 0) {
        this.cb.onNotify(`有 ${kanban.blocked} 个任务被阻塞了！`);
      } else if (newMode === "alert" && overdue > 0) {
        this.cb.onNotify(`有 ${overdue} 个任务逾期了！`);
      }
    }
  }
}

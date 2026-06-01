/**
 * PetBrain — 桌面宠物行为状态机 + 待办感知
 *
 * 双层架构:
 * - BehaviorState (idle/walk/interact/sleep) — 行为状态机，驱动动画
 * - PetMode (leisure/busy/anxious/alert/celebrate) — 待办感知模式，调节转换权重
 *
 * 设计参考 DesktopAnt PetBrain.js，简化为 4 核心状态
 */

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
}

interface TodoStatus {
  total: number;
  completed: number;
  overdue: number;
  dueToday: number;
}

interface BehaviorConfig {
  /** Spine 动画候选（按优先级） */
  anims: string[];
  /** 状态持续时间 [min, max] ms */
  duration: [number, number];
  /** 动画是否循环 */
  loop: boolean;
  /** 默认心情 emoji */
  mood: string;
  /** 转移到其他状态的权重 */
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

const SLEEP_TIMEOUT_MS = 30 * 60 * 1000; // 30 分钟无交互 → 睡眠
const IDLE_OVER_60S_SLEEP_BONUS = 40; // 空闲超过 60s，增加 sleep 权重

// ========== PetBrain 类 ==========

export class PetBrain {
  // ── 行为状态 ──
  private behavior: BehaviorState = "idle";
  private behaviorTimer: ReturnType<typeof setTimeout> | null = null;

  // ── 待办模式 ──
  private mode: PetMode = "leisure";
  private mood = "(^・ω・^)";
  private prevMode: PetMode = "leisure";

  // ── 睡眠检测 ──
  private lastInteraction = Date.now();
  private sleepCheckTimer: ReturnType<typeof setInterval> | null = null;

  // ── 待办轮询 ──
  private todoPollTimer: ReturnType<typeof setInterval> | null = null;
  private todoStatus: TodoStatus = {
    total: 0,
    completed: 0,
    overdue: 0,
    dueToday: 0,
  };

  // ── 空闲计时 ──
  private idleSeconds = 0;
  private idleCounterInterval: ReturnType<typeof setInterval> | null = null;

  // ── 动画查询 ──
  private hasAnimation: ((name: string) => boolean) | null = null;

  private cb: PetBrainCallbacks;
  private disposed = false;

  constructor(callbacks: PetBrainCallbacks) {
    this.cb = callbacks;
  }

  /** 注入 Spine 动画查询函数（用于动画降级） */
  setAnimationChecker(checker: (name: string) => boolean) {
    this.hasAnimation = checker;
  }

  // ── Lifecycle ──

  start() {
    this.scheduleSleepCheck();
    this.scheduleTodoPoll();
    this.startIdleCounter();
    this.enterBehavior("idle");
    this.cb.onMoodChange(this.mood);
    this.cb.onModeChange(this.mode);
  }

  dispose() {
    this.disposed = true;
    if (this.behaviorTimer) clearTimeout(this.behaviorTimer);
    if (this.sleepCheckTimer) clearInterval(this.sleepCheckTimer);
    if (this.todoPollTimer) clearInterval(this.todoPollTimer);
    if (this.idleCounterInterval) clearInterval(this.idleCounterInterval);
  }

  // ── Public API ──

  /** 用户交互（hover/click/drag）— 重置空闲计时，触发 interact 状态 */
  notifyInteraction(type?: string) {
    this.lastInteraction = Date.now();
    this.idleSeconds = 0;

    // 如果在睡眠，唤醒
    if (this.behavior === "sleep") {
      this.enterBehavior("idle");
      return;
    }

    // 用户交互 → 进入 interact 状态（短暂）
    if (type === "click" || type === "hover") {
      if (this.behavior !== "interact") {
        this.enterBehavior("interact");
      }
    }
  }

  isSleeping() {
    return this.behavior === "sleep";
  }
  getBehavior() {
    return this.behavior;
  }
  getMode() {
    return this.mode;
  }
  getMood() {
    return this.mood;
  }

  // ========== 行为状态机 ==========

  private enterBehavior(state: BehaviorState) {
    const config = BEHAVIOR_CONFIG[state];
    if (!config) return;

    this.behavior = state;

    // 清除旧计时器
    if (this.behaviorTimer) clearTimeout(this.behaviorTimer);

    // 选择可用动画（降级）
    const anim = this.resolveAnim(config.anims);

    // 通知外部
    this.cb.onBehaviorChange(state, anim);

    // 更新心情
    this.mood = config.mood;
    this.cb.onMoodChange(this.mood);

    // 定时状态转换
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

  /** 根据待办模式和空闲时间调整转换权重 */
  private adjustTransitions(
    state: BehaviorState,
    config: BehaviorConfig
  ): Partial<Record<BehaviorState, number>> {
    const transitions = { ...config.transitions };
    const mods = MODE_WEIGHT_MODS[this.mode];

    // 应用模式权重修正
    for (const [key, mod] of Object.entries(mods)) {
      const k = key as BehaviorState;
      if (transitions[k] !== undefined) {
        transitions[k] = (transitions[k] ?? 0) * mod;
      }
    }

    // 空闲超过 60s → 增加 sleep 倾向
    if (this.idleSeconds > 60 && transitions.sleep !== undefined) {
      transitions.sleep = (transitions.sleep ?? 0) + IDLE_OVER_60S_SLEEP_BONUS;
    }

    return transitions;
  }

  /** 加权随机选择下一个状态 */
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

  /** 根据 Spine 资产挑选可用动画名 */
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

  // ========== 待办轮询 ==========

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
        this.setTodoStatus({
          total: 0,
          completed: 0,
          overdue: 0,
          dueToday: 0,
        });
        return;
      }

      const todos: Array<{ status: boolean; dueDate?: string }> =
        JSON.parse(raw);
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

  // ========== 待办模式更新 ==========

  private updateMode() {
    if (this.behavior === "sleep") return;

    const { overdue, dueToday, total, completed } = this.todoStatus;
    let newMode: PetMode;

    if (total > 0 && completed >= total) {
      newMode = "celebrate";
    } else if (overdue > 0) {
      newMode = "alert";
    } else if (dueToday > 0) {
      newMode = "anxious";
    } else if (total > 0) {
      newMode = "busy";
    } else {
      newMode = "leisure";
    }

    if (newMode !== this.prevMode) {
      this.prevMode = this.mode;
      this.mode = newMode;
      this.cb.onModeChange(newMode);

      const moods = MODE_MOODS[newMode];
      this.mood = moods[Math.floor(Math.random() * moods.length)];
      this.cb.onMoodChange(this.mood);

      if (newMode === "alert") {
        const { overdue } = this.todoStatus;
        this.cb.onNotify(`有 ${overdue} 个任务逾期了！快去看看吧~`);
      }
    }
  }
}

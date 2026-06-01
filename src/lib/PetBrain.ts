/**
 * PetBrain — 桌面宠物行为顾问（无运动逻辑）
 *
 * 负责:
 * - Todo 感知模式 (leisure/busy/anxious/alert/celebrate)
 * - 心情文字 (mood emoji)
 * - 睡眠检测 (30分钟无交互)
 * - 逾期提醒通知
 *
 * 不负责: 窗口移动（由 PhysicsEngine 处理）
 */

export type PetMode = "leisure" | "busy" | "anxious" | "alert" | "celebrate";

export interface PetBrainCallbacks {
  onModeChange: (mode: PetMode) => void;
  onMoodChange: (mood: string) => void;
  onNotify: (message: string) => void;
  onSleepChange: (sleeping: boolean) => void;
}

interface TodoStatus {
  total: number;
  completed: number;
  overdue: number;
  dueToday: number;
}

const SLEEP_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

const MOODS: Record<PetMode, string[]> = {
  leisure: ["(^・ω・^)", "(=^・ω・^=)", "٩(◕‿◕)۶", "(｡♥‿♥｡)"],
  busy: ["(´・ω・`)", "(・_・;)", "m(_ _)m"],
  anxious: ["(;;ω;;)", "(´;ω;`)", "Σ(°△°|||)"],
  alert: ["(╯°□°)╯", "⚠️ ᕙ(⇀‸↼‶)ᕗ", "‼️ (ﾉꐦ ⊱ ꐦ)ﾉ"],
  celebrate: ["(*≧ω≦)", "(ﾉ◕ヮ◕)ﾉ*:・ﾟ✧", "✨ ╰(*°▽°*)╯ ✨"],
};

/** Mode-based PhysicsEngine parameters */
export const MODE_PHYSICS: Record<PetMode, { walkSpeed: number; idleProbability: number }> = {
  leisure:   { walkSpeed: 40, idleProbability: 0.3 },
  busy:      { walkSpeed: 50, idleProbability: 0.2 },
  anxious:   { walkSpeed: 70, idleProbability: 0.1 },
  alert:     { walkSpeed: 80, idleProbability: 0.05 },
  celebrate: { walkSpeed: 35, idleProbability: 0.35 },
};

export class PetBrain {
  private mode: PetMode = "leisure";
  private mood = "(^・ω・^)";
  private sleeping = false;

  private lastInteraction = Date.now();
  private sleepCheckTimer: ReturnType<typeof setInterval> | null = null;
  private todoPollTimer: ReturnType<typeof setInterval> | null = null;

  private todoStatus: TodoStatus = { total: 0, completed: 0, overdue: 0, dueToday: 0 };
  private prevMode: PetMode = "leisure";

  private cb: PetBrainCallbacks;
  private disposed = false;

  constructor(callbacks: PetBrainCallbacks) {
    this.cb = callbacks;
  }

  // ── Lifecycle ──

  start() {
    this.scheduleSleepCheck();
    this.scheduleTodoPoll();
    this.cb.onMoodChange(this.mood);
    this.cb.onModeChange(this.mode);
    this.cb.onSleepChange(false);
  }

  dispose() {
    this.disposed = true;
    if (this.sleepCheckTimer) clearInterval(this.sleepCheckTimer);
    if (this.todoPollTimer) clearInterval(this.todoPollTimer);
  }

  // ── Public API ──

  /** Call when user interacts with pet (hover/click/drag) — resets sleep timer */
  notifyInteraction() {
    this.lastInteraction = Date.now();
    if (this.sleeping) {
      this.sleeping = false;
      this.cb.onSleepChange(false);
      this.updateMode();
    }
  }

  isSleeping() { return this.sleeping; }
  getMode() { return this.mode; }
  getMood() { return this.mood; }

  // ── Mode / Mood ──

  private updateMode() {
    if (this.sleeping) return;

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

      const moods = MOODS[newMode];
      this.mood = moods[Math.floor(Math.random() * moods.length)];
      this.cb.onMoodChange(this.mood);

      if (newMode === "alert") {
        const { overdue } = this.todoStatus;
        this.cb.onNotify(`有 ${overdue} 个任务逾期了！快去看看吧~`);
      }
    }
  }

  // ── Sleep ──

  private scheduleSleepCheck() {
    this.sleepCheckTimer = setInterval(() => {
      if (this.disposed) return;
      const elapsed = Date.now() - this.lastInteraction;
      if (elapsed >= SLEEP_TIMEOUT_MS && !this.sleeping) {
        this.sleeping = true;
        this.cb.onSleepChange(true);
      }
    }, 30_000);
  }

  // ── Todo Polling ──

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
}

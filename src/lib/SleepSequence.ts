/**
 * SleepSequence — Manages the sleep lifecycle of the desktop pet.
 *
 * Sequence: idle → yawn → dozing → sleeping → waking → idle
 *
 * Triggered by mouse inactivity (60s default).
 * Woken by: mouse movement, notification, user interaction.
 *
 * Inspired by clawd-on-desk's sleep sequence system.
 */

import type { StateArbiter } from "./StateArbiter";

export interface SleepSequenceOptions {
  /** Mouse idle time before yawn starts (ms). Default 60000 */
  yawnDelayMs?: number;
  /** Yawn duration (ms). Default 3000 */
  yawnDurationMs?: number;
  /** Dozing duration before deep sleep (ms). Default 10000 */
  dozeDurationMs?: number;
  /** Arbiter to request states from */
  arbiter: StateArbiter;
  /** Called when sleep state changes */
  onSleepChange?: (phase: SleepPhase) => void;
}

export type SleepPhase = "awake" | "yawn" | "dozing" | "sleeping" | "waking";

export class SleepSequence {
  private phase: SleepPhase = "awake";
  private mouseIdleTimer = 0;
  private phaseTimer = 0;
  private lastMouseX = 0;
  private lastMouseY = 0;
  private mouseStill = true;
  private running = false;
  private tickId: ReturnType<typeof setInterval> | null = null;

  private yawnDelayMs: number;
  private yawnDurationMs: number;
  private dozeDurationMs: number;
  private arbiter: StateArbiter;
  private onSleepChange?: (phase: SleepPhase) => void;

  constructor(options: SleepSequenceOptions) {
    this.arbiter = options.arbiter;
    this.yawnDelayMs = options.yawnDelayMs ?? 60000;
    this.yawnDurationMs = options.yawnDurationMs ?? 3000;
    this.dozeDurationMs = options.dozeDurationMs ?? 10000;
    this.onSleepChange = options.onSleepChange;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.tickId = setInterval(() => this.tick(), 1000);
  }

  stop(): void {
    this.running = false;
    if (this.tickId) { clearInterval(this.tickId); this.tickId = null; }
  }

  /** Call this with current mouse position to detect activity */
  updateMouse(x: number, y: number): void {
    const dx = Math.abs(x - this.lastMouseX);
    const dy = Math.abs(y - this.lastMouseY);
    if (dx > 5 || dy > 5) {
      this.lastMouseX = x;
      this.lastMouseY = y;
      this.mouseStill = false;
      this.mouseIdleTimer = 0;
      // If sleeping, wake up
      if (this.phase !== "awake") {
        this.wake();
      }
    }
  }

  /** Force wake (e.g., from notification) */
  wake(): void {
    if (this.phase === "awake") return;
    const prev = this.phase;
    this.phase = "awake";
    this.mouseIdleTimer = 0;
    this.phaseTimer = 0;
    this.arbiter.revoke("emotion", "yawn");
    this.arbiter.revoke("emotion", "dozing");
    this.arbiter.revoke("emotion", "sleep");
    this.onSleepChange?.("awake");
  }

  getPhase(): SleepPhase { return this.phase; }

  private tick(): void {
    if (!this.running) return;

    switch (this.phase) {
      case "awake":
        this.mouseIdleTimer += 1000;
        if (this.mouseIdleTimer >= this.yawnDelayMs) {
          this.transition("yawn");
        }
        break;

      case "yawn":
        this.phaseTimer += 1000;
        if (this.phaseTimer >= this.yawnDurationMs) {
          this.transition("dozing");
        }
        break;

      case "dozing":
        this.phaseTimer += 1000;
        if (this.phaseTimer >= this.dozeDurationMs) {
          this.transition("sleeping");
        }
        break;

      case "sleeping":
        // Stay sleeping until woken
        break;

      case "waking":
        this.phaseTimer += 1000;
        if (this.phaseTimer >= 2000) {
          this.transition("awake");
        }
        break;
    }
  }

  private transition(phase: SleepPhase): void {
    this.phase = phase;
    this.phaseTimer = 0;
    this.onSleepChange?.(phase);

    // Clean up previous emotion states
    this.arbiter.revoke("emotion", "yawn");
    this.arbiter.revoke("emotion", "dozing");
    this.arbiter.revoke("emotion", "sleep");

    switch (phase) {
      case "yawn":
        this.arbiter.request({
          state: "yawn", source: "emotion",
          oneshot: true, durationMs: this.yawnDurationMs,
        });
        break;
      case "dozing":
        this.arbiter.request({
          state: "dozing", source: "emotion",
        });
        break;
      case "sleeping":
        this.arbiter.request({
          state: "sleep", source: "emotion",
        });
        break;
      case "waking":
        // Brief waking state, then back to awake
        this.arbiter.request({
          state: "idle", source: "emotion",
        });
        break;
    }
  }

  dispose(): void {
    this.stop();
  }
}

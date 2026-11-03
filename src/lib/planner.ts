import {invoke, isTauri} from '@tauri-apps/api/core';
import {listen} from '@tauri-apps/api/event';
import {normalizePlanner, type PlannerPayload} from './planner-model.mjs';

export interface PlannerSnapshot {revision: number; payload: PlannerPayload}
const STORAGE_KEY = 'antdesk_planner_v1';

function snapshot(value: unknown): PlannerSnapshot {
  const raw = value as {revision?: unknown; payload?: unknown} | null;
  if (!raw || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 0) {
    throw new Error('事项存储返回了无效版本，请重试。');
  }
  return {revision: Number(raw.revision), payload: normalizePlanner(raw.payload)};
}

export async function loadPlannerSnapshot(): Promise<PlannerSnapshot> {
  if (isTauri()) return snapshot(await invoke('task_hub_load'));
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved ? snapshot(JSON.parse(saved)) : {revision: 0, payload: normalizePlanner(null)};
}

export async function subscribePlanner(listener: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  return listen('planner:changed', listener);
}

export async function savePlannerSnapshot(expectedRevision: number, payload: PlannerPayload): Promise<PlannerSnapshot> {
  if (isTauri()) return snapshot(await invoke('task_hub_save', {expectedRevision, payload}));
  const save = () => {
    const saved = localStorage.getItem(STORAGE_KEY);
    const current = saved ? snapshot(JSON.parse(saved)) : {revision: 0, payload: normalizePlanner(null)};
    if (current.revision !== expectedRevision) throw new Error('TASK_HUB_CONFLICT: 事项版本已变化，请重试以合并安排。');
    const next = {revision: current.revision + 1, payload: normalizePlanner(payload)};
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    return next;
  };
  // Browser preview uses a same-origin lock when available; native persistence is
  // transactionally versioned by the Rust task hub.
  if (typeof navigator !== 'undefined' && navigator.locks) return navigator.locks.request(STORAGE_KEY, save);
  return save();
}

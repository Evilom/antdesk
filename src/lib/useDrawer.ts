import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';

export type DrawerMode = 'collapsed' | 'peek' | 'expanded';
export type DrawerEdge = 'left' | 'right' | 'top' | 'bottom';
export interface DrawerState { mode: DrawerMode; edge: DrawerEdge }

export function useDrawer(keepOpen = false) {
  const [state, setState] = useState<DrawerState>({ mode: isTauri() ? 'collapsed' : 'expanded', edge: 'left' });
  const [closing, setClosing] = useState(false);
  const [docking, setDocking] = useState(false);
  const [error, setError] = useState('');
  const [shortcut, setShortcut] = useState<string | null>(null);
  const latest = useRef(state);
  const pinned = useRef(keepOpen);
  const pointerInside = useRef(false);
  const dockingRef = useRef(false);
  const closingRef = useRef(false);
  const mounted = useRef(true);
  const sequence = useRef(0);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  latest.current = state;
  pinned.current = keepOpen;

  const change = useCallback(async (mode: DrawerMode, edge?: DrawerEdge) => {
    // The native move loop owns geometry until release. A hover/focus event
    // must not resize the window under the user's drag handle.
    if (dockingRef.current) return;
    clearTimeout(hoverTimer.current);
    clearTimeout(exitTimer.current);
    const request = ++sequence.current;
    const next = { mode, edge: edge || latest.current.edge };
    if (mode === 'collapsed' && latest.current.mode !== 'collapsed') {
      closingRef.current = true;
      setClosing(true);
      await new Promise(resolve => setTimeout(resolve, 150));
      if (sequence.current !== request) return;
    } else { closingRef.current = false; setClosing(false); }
    try {
      const value = isTauri() ? await invoke<DrawerState>('drawer_set_state', next) : next;
      if (sequence.current !== request) return;
      latest.current = { mode: value.mode, edge: value.edge };
      setState(latest.current);
      setError('');
    } catch {
      if (sequence.current !== request) return;
      setError('窗口未能调整，请重试。');
    } finally { if (sequence.current === request) { closingRef.current = false; setClosing(false); } }
  }, []);

  const startDrag = useCallback(async () => {
    if (dockingRef.current) return;
    clearTimeout(hoverTimer.current);
    clearTimeout(exitTimer.current);
    sequence.current++;
    closingRef.current = false;
    setClosing(false);
    if (!isTauri()) { setError('请在桌面应用中拖动调整位置。'); return; }
    dockingRef.current = true;
    setDocking(true);
    try {
      const value = await invoke<DrawerState>('drawer_start_drag');
      if (!mounted.current) return;
      latest.current = value;
      setState(value);
      setError('');
    } catch {
      if (mounted.current) setError('未能移动抽屉，请再拖一次，或在位置设置中选择屏幕边缘。');
    } finally {
      dockingRef.current = false;
      if (mounted.current) setDocking(false);
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    const cleanups: (() => void)[] = [];
    const accept = (value: DrawerState) => {
      if (disposed || !['collapsed', 'peek', 'expanded'].includes(value.mode)
        || !['left', 'right', 'top', 'bottom'].includes(value.edge)) return;
      sequence.current++;
      clearTimeout(hoverTimer.current);
      clearTimeout(exitTimer.current);
      latest.current = { mode: value.mode, edge: value.edge };
      setState(latest.current);
      closingRef.current = false;
      setClosing(false);
    };
    void invoke<DrawerState>('drawer_get_state').then(accept).catch(() => setError('窗口连接暂不可用。'));
    void invoke<string | null>('drawer_get_shortcut').then(value => { if (!disposed) setShortcut(value); }).catch(() => {});
    void listen<DrawerState>('drawer:state-changed', event => accept(event.payload)).then(fn => disposed ? fn() : cleanups.push(fn));
    void getCurrentWindow().onFocusChanged(({ payload: focused }) => {
      if (focused) clearTimeout(exitTimer.current);
      else if (!pinned.current && !dockingRef.current && latest.current.mode === 'expanded') {
        exitTimer.current = setTimeout(() => { if (!pinned.current && !dockingRef.current) void change('collapsed'); }, 460);
      }
    }).then(fn => disposed ? fn() : cleanups.push(fn));
    return () => { disposed = true; cleanups.forEach(fn => fn()); };
  }, [change]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current++; clearTimeout(hoverTimer.current); clearTimeout(exitTimer.current); };
  }, []);

  // A drag may finish outside the rail, after its pointerleave already fired.
  // Release the larger hover bounds then, without interrupting an active hold.
  useEffect(() => {
    if (!keepOpen && !docking && !pointerInside.current && latest.current.mode === 'peek') {
      clearTimeout(exitTimer.current);
      exitTimer.current = setTimeout(() => {
        if (!pinned.current && !dockingRef.current && !pointerInside.current) void change('collapsed');
      }, 460);
    }
  }, [keepOpen, docking, state.mode, change]);

  const enter = useCallback(() => {
    pointerInside.current = true;
    clearTimeout(exitTimer.current);
    if (dockingRef.current) return;
    if (closingRef.current) {
      sequence.current++;
      closingRef.current = false;
      setClosing(false);
    }
    if (latest.current.mode === 'collapsed') {
      clearTimeout(hoverTimer.current);
      // A short dwell leaves time to grab the edge tab without expanding it.
      hoverTimer.current = setTimeout(() => { if (!dockingRef.current) void change('peek'); }, 180);
    }
  }, [change]);
  const leave = useCallback(() => {
    pointerInside.current = false;
    clearTimeout(hoverTimer.current);
    if (latest.current.mode === 'peek' && !pinned.current && !dockingRef.current) {
      exitTimer.current = setTimeout(() => { if (!pinned.current && !dockingRef.current) void change('collapsed'); }, 460);
    }
  }, [change]);

  return { ...state, shortcut, closing, docking, error, change, startDrag, enter, leave };
}

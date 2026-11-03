import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';

const PRESS_MS = 320;

/** Slot plus gap. Horizontal numbers match the top/bottom rail in pianoRail.css. */
export const pianoMetrics = {
  y: { slot: 56, gap: 6, pad: 10, radius: 148, scroll: 600 },
  x: { slot: 156, gap: 6, pad: 0, radius: 310, scroll: 740 },
} as const;
export type PianoAxis = keyof typeof pianoMetrics;

const pitchOf = (axis: PianoAxis) => pianoMetrics[axis].slot + pianoMetrics[axis].gap;

type Press = {
  id: string; pointerId: number; pointerType: string; index: number; order: string;
  startX: number; startY: number; x: number; y: number; lastX: number; lastY: number; offsetX: number; offsetY: number;
  element: HTMLButtonElement; phase: 'press' | 'drag' | 'scroll' | 'cancelled';
};
type Heat = { value: number; velocity: number };

/** Pointer movement stays in the DOM animation loop; only a changed insertion slot
 * updates React. The persistent reorder callback runs once, after a valid drop. */
export function usePianoInteraction({ ids, panel, axis, onOpen, onReorder, onInteractionChange }: {
  ids: string[]; panel: boolean; axis: PianoAxis; onOpen: (id: string) => void;
  onReorder: (id: string, beforeId: string | null) => void;
  onInteractionChange: (active: boolean) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const latest = useRef({ ids, panel, axis, onOpen, onReorder, onInteractionChange });
  latest.current = { ids, panel, axis, onOpen, onReorder, onInteractionChange };
  const order = JSON.stringify(ids);
  const press = useRef<Press | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const raf = useRef<number | undefined>(undefined);
  const lastFrame = useRef(0);
  const heat = useRef(new Map<string, Heat>());
  const hoverPrimary = useRef<number | null>(null);
  const focused = useRef<string | null>(null);
  const insertion = useRef(-1);
  const [pressId, setPressId] = useState('');
  const [drag, setDrag] = useState<{ id: string; from: number; to: number } | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!announcement) return;
    const timeout = setTimeout(() => setAnnouncement(''), 3500);
    return () => clearTimeout(timeout);
  }, [announcement]);

  const updateDrop = () => {
    const active = press.current, viewport = viewportRef.current;
    if (!active || active.phase !== 'drag' || !viewport) return;
    const axis = latest.current.axis;
    const horizontal = axis === 'x';
    const metric = pianoMetrics[axis];
    const pitch = pitchOf(axis);
    const bounds = viewport.getBoundingClientRect();
    const coord = horizontal ? active.x : active.y;
    const offset = horizontal ? active.offsetX : active.offsetY;
    const origin = horizontal ? bounds.left : bounds.top;
    const scroll = horizontal ? viewport.scrollLeft : viewport.scrollTop;
    const content = coord - offset + metric.slot / 2 - origin + scroll - metric.pad;
    const next = Math.max(0, Math.min(latest.current.ids.length - 1, Math.floor((content + 3) / pitch)));
    if (next !== insertion.current) {
      insertion.current = next;
      setDrag({ id: active.id, from: active.index, to: next });
    }
    const floating = floatingRef.current;
    if (floating) {
      const source = active.element.getBoundingClientRect();
      if (horizontal) {
        floating.style.top = `${source.top}px`;
        floating.style.height = `${source.height}px`;
        floating.style.left = `${active.x - active.offsetX}px`;
        floating.style.width = `${source.width}px`;
      } else {
        floating.style.left = `${source.left}px`;
        floating.style.width = `${source.width}px`;
        floating.style.height = '';
        floating.style.top = `${active.y - active.offsetY}px`;
      }
    }
  };

  const frame = (time: number) => {
    raf.current = undefined;
    const viewport = viewportRef.current;
    if (!viewport) return;
    const dt = Math.min(.032, Math.max(.001, (time - (lastFrame.current || time - 16)) / 1000));
    lastFrame.current = time;
    const active = press.current;
    const axis = latest.current.axis;
    const horizontal = axis === 'x';
    const metric = pianoMetrics[axis];
    const pitch = pitchOf(axis);
    let moving = false;
    if (active?.phase === 'drag') {
      const bounds = viewport.getBoundingClientRect();
      const edge = 42;
      const coord = horizontal ? active.x : active.y;
      const start = horizontal ? bounds.left : bounds.top;
      const end = horizontal ? bounds.right : bounds.bottom;
      const speed = coord < start + edge ? -Math.min(1, (start + edge - coord) / edge)
        : coord > end - edge ? Math.min(1, (coord - end + edge) / edge) : 0;
      if (speed) {
        if (horizontal) viewport.scrollLeft += speed * metric.scroll * dt;
        else viewport.scrollTop += speed * metric.scroll * dt;
      }
      updateDrop();
      moving = true;
    }
    const rect = viewport.getBoundingClientRect();
    const origin = (horizontal ? rect.left : rect.top) + metric.pad - (horizontal ? viewport.scrollLeft : viewport.scrollTop);
    const half = metric.slot / 2;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches
      || Boolean(viewport.closest('[data-reduce-motion="true"]'));
    const focusedIndex = focused.current ? latest.current.ids.indexOf(focused.current) : -1;
    const pointer = focusedIndex >= 0 && hoverPrimary.current === null ? origin + focusedIndex * pitch + half : hoverPrimary.current;
    latest.current.ids.forEach((id, index) => {
      const node = buttons.current.get(id);
      if (!node) return;
      const distance = pointer === null || active?.phase === 'drag' ? metric.radius : Math.abs(pointer - (origin + index * pitch + half));
      const target = distance < metric.radius ? (1 + Math.cos(Math.PI * distance / metric.radius)) / 2 : 0;
      const state = heat.current.get(id) || { value: 0, velocity: 0 };
      const previousValue = state.value;
      const initialized = heat.current.has(id);
      if (reduced) { state.value = target; state.velocity = 0; }
      else {
        state.velocity += ((target - state.value) * 350 - state.velocity * 32) * dt;
        state.value = Math.max(0, Math.min(1, state.value + state.velocity * dt));
      }
      if (Math.abs(state.value - target) < .001 && Math.abs(state.velocity) < .01) {
        state.value = target; state.velocity = 0;
      } else moving = true;
      heat.current.set(id, state);
      if (!initialized || Math.abs(previousValue - state.value) > .00005) {
        const heat = state.value.toFixed(4);
        node.style.setProperty('--pp-heat', heat);
        // The card sizes the key. A variable set on the button does not
        // affect its parent, so the hover reach otherwise stays at zero.
        const card = node.parentElement;
        if (card?.classList.contains('pp-card')) card.style.setProperty('--pp-heat', heat);
      }
    });
    if (moving) raf.current = requestAnimationFrame(frame);
    else lastFrame.current = 0;
  };
  const animate = () => { if (raf.current === undefined) raf.current = requestAnimationFrame(frame); };

  const finish = (commit: boolean) => {
    clearTimeout(timer.current);
    const active = press.current;
    press.current = null;
    setPressId(''); setDrag(null);
    if (active) {
      // Clear the press before releasing capture: lostpointercapture may fire synchronously.
      if (active.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
      latest.current.onInteractionChange(false);
      if (commit && active.phase === 'drag' && active.order === JSON.stringify(latest.current.ids)) {
        const target = insertion.current;
        if (target !== active.index) {
          const remaining = latest.current.ids.filter(id => id !== active.id);
          latest.current.onReorder(active.id, remaining[target] || null);
          setAnnouncement(`已移到第 ${target + 1} 位，${latest.current.axis === 'x' ? '越靠左优先级越高' : '越靠上优先级越高'}`);
        } else setAnnouncement('顺序未改变');
      } else if (active.phase === 'drag') setAnnouncement('已取消排序');
    }
    insertion.current = -1;
    animate();
  };

  useEffect(() => {
    // Removing, completing or externally reordering a task invalidates the gesture.
    if (press.current && press.current.order !== order) finish(false);
    for (const id of heat.current.keys()) if (!ids.includes(id)) heat.current.delete(id);
    animate();
  }, [order]);
  useEffect(() => { if (press.current) finish(false); }, [panel, axis]);
  useEffect(() => {
    const node = viewportRef.current;
    if (!node) return;
    // The rail is horizontal, but a mouse wheel reports vertical delta. A passive
    // listener cannot cancel that, so the notch never moves the row.
    const onWheel = (event: WheelEvent) => {
      if (press.current?.phase === 'press') finish(false);
      if (latest.current.axis !== 'x') return;
      const scale = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 48
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? node.clientWidth : 1;
      const delta = (Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY) * scale;
      if (!delta || node.scrollWidth <= node.clientWidth + 1) return;
      event.preventDefault();
      node.scrollLeft += delta;
      animate();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, []);
  useEffect(() => {
    const cancel = () => { hoverPrimary.current = null; focused.current = null; finish(false); };
    const key = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && press.current) { event.preventDefault(); event.stopImmediatePropagation(); finish(false); }
    };
    const hidden = () => { if (document.hidden) cancel(); };
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      document.removeEventListener('visibilitychange', hidden);
      clearTimeout(timer.current);
      timer.current = undefined;
      if (raf.current !== undefined) cancelAnimationFrame(raf.current);
      // StrictMode replays effect setup after cleanup while retaining refs. A
      // cancelled frame id must not look like a live scheduled frame to animate().
      raf.current = undefined;
      lastFrame.current = 0;
      const active = press.current; press.current = null;
      if (active?.element.hasPointerCapture(active.pointerId)) active.element.releasePointerCapture(active.pointerId);
      if (active) latest.current.onInteractionChange(false);
    };
  }, []);

  const pointerDown = (event: PointerEvent<HTMLButtonElement>, id: string, index: number) => {
    if (event.button !== 0 || !event.isPrimary || press.current) return;
    const element = event.currentTarget;
    const bounds = element.getBoundingClientRect();
    const horizontal = latest.current.axis === 'x';
    const active: Press = { id, pointerId: event.pointerId, pointerType: event.pointerType, index,
      order: JSON.stringify(latest.current.ids), startX: event.clientX, startY: event.clientY,
      x: event.clientX, y: event.clientY, lastX: event.clientX, lastY: event.clientY,
      offsetX: Math.min(bounds.width, Math.max(0, event.clientX - bounds.left)),
      offsetY: Math.min(horizontal ? bounds.height : 56, Math.max(0, event.clientY - bounds.top)), element, phase: 'press' };
    press.current = active; setPressId(id);
    latest.current.onInteractionChange(true);
    element.setPointerCapture(event.pointerId);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      if (press.current !== active || active.phase !== 'press') return;
      active.phase = 'drag'; insertion.current = index;
      setPressId(''); setDrag({ id, from: index, to: index });
      setAnnouncement(latest.current.axis === 'x' ? '已提起事项，左右拖动调整优先级，Esc 取消' : '已提起事项，上下拖动调整优先级，Esc 取消');
      animate();
    }, PRESS_MS);
    hoverPrimary.current = latest.current.axis === 'x' ? event.clientX : event.clientY; animate();
  };
  const pointerMove = (event: PointerEvent) => {
    const active = press.current;
    if (active && active.pointerId === event.pointerId) {
      active.x = event.clientX; active.y = event.clientY;
      if (active.phase === 'press' && Math.hypot(event.clientX - active.startX, event.clientY - active.startY) > 8) {
        clearTimeout(timer.current); setPressId('');
        active.phase = active.pointerType === 'touch' ? 'scroll' : 'cancelled';
        latest.current.onInteractionChange(false);
      }
      if (active.phase === 'scroll' && viewportRef.current) {
        if (latest.current.axis === 'x') viewportRef.current.scrollLeft += active.lastX - event.clientX;
        else viewportRef.current.scrollTop += active.lastY - event.clientY;
      }
      if (active.phase === 'drag') { event.preventDefault(); updateDrop(); }
      active.lastX = event.clientX;
      active.lastY = event.clientY;
    }
    hoverPrimary.current = event.pointerType === 'touch' && active?.phase !== 'press' ? null
      : (latest.current.axis === 'x' ? event.clientX : event.clientY);
    animate();
  };
  const pointerUp = (event: PointerEvent) => {
    const active = press.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    active.x = event.clientX; active.y = event.clientY;
    if (active.phase === 'drag') updateDrop();
    const bounds = viewportRef.current?.getBoundingClientRect();
    const horizontal = latest.current.axis === 'x';
    const xSlack = horizontal ? 80 : 40;
    const ySlack = horizontal ? 40 : 80;
    const canDrop = Boolean(bounds && event.clientX >= bounds.left - xSlack && event.clientX <= bounds.right + xSlack
      && event.clientY >= bounds.top - ySlack && event.clientY <= bounds.bottom + ySlack);
    const clicked = active.phase === 'press';
    const buttonBounds = active.element.getBoundingClientRect();
    const inside = event.clientX >= buttonBounds.left && event.clientX <= buttonBounds.right
      && event.clientY >= buttonBounds.top && event.clientY <= buttonBounds.bottom;
    finish(canDrop);
    if (clicked && inside) latest.current.onOpen(active.id);
  };
  const keyboard = (event: KeyboardEvent<HTMLButtonElement>, id: string) => {
    const horizontal = latest.current.axis === 'x';
    const delta = event.key === 'ArrowUp' || (horizontal && event.key === 'ArrowLeft') ? -1
      : event.key === 'ArrowDown' || (horizontal && event.key === 'ArrowRight') ? 1 : 0;
    if (!event.altKey || !delta) return;
    event.preventDefault(); event.stopPropagation();
    const list = latest.current.ids, from = list.indexOf(id), to = from + delta;
    if (from < 0 || to < 0 || to >= list.length) return;
    const remaining = list.filter(value => value !== id);
    latest.current.onReorder(id, remaining[to] || null);
    setAnnouncement(`已移到第 ${to + 1} 位`);
    requestAnimationFrame(() => buttons.current.get(id)?.focus({ preventScroll: true }));
  };

  return {
    viewportRef, floatingRef, pressId, drag, announcement,
    bind: (id: string, element: HTMLButtonElement | null) => { if (element) buttons.current.set(id, element); else buttons.current.delete(id); },
    pointerDown, pointerMove, pointerUp, keyboard,
    pointerLeave: () => { hoverPrimary.current = null; animate(); },
    cancel: (event: PointerEvent) => { if (press.current?.pointerId === event.pointerId) finish(false); },
    focus: (id: string, element: HTMLButtonElement) => { if (element.matches(':focus-visible')) { focused.current = id; animate(); } },
    blur: () => { focused.current = null; animate(); },
    scroll: () => { if (press.current?.phase === 'drag') updateDrop(); animate(); },
  };
}

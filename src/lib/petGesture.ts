export interface PetGestureOptions {
  startX: number;
  startY: number;
  target: EventTarget;
  startDragging: () => Promise<void>;
  primaryButtonDown: () => Promise<boolean>;
  /** With native positioning, start on mousedown; the OS may consume all moves. */
  readPosition?: () => Promise<{ x: number; y: number }>;
  onDragStart: () => void;
  onRelease: (dragged: boolean) => void;
  onError: (error: unknown) => void;
}

/** One press owns the native drag. Clicks are resolved only after release. */
export function beginPetGesture(options: PetGestureOptions): () => void {
  let active = true;
  let releasing = false;
  let dragging = false;
  let nativeStarted = false;
  let poll: ReturnType<typeof setTimeout> | undefined;
  // Queue the position read before native dragging, without waiting on IPC.
  const origin = options.readPosition?.().catch(() => null);
  const markDragged = () => {
    if (dragging || !active) return;
    dragging = true;
    options.onDragStart();
  };
  const detach = () => {
    clearTimeout(poll);
    options.target.removeEventListener("mousemove", move);
    options.target.removeEventListener("mouseup", release);
    options.target.removeEventListener("pointercancel", cancel);
  };
  const cleanup = () => { active = false; detach(); };
  const finish = async (cancelled: boolean) => {
    if (!active || releasing) return;
    releasing = true;
    detach();
    if (origin && options.readPosition) {
      const [from, to] = await Promise.all([origin, options.readPosition().catch(() => null)]);
      if (!active) return;
      if (from && to && Math.hypot(to.x - from.x, to.y - from.y) >= 4) markDragged();
    }
    if (cancelled) dragging = true; // A cancelled gesture must never open a panel.
    cleanup();
    options.onRelease(dragging);
  };
  const release = () => { void finish(false); };
  const cancel = () => { void finish(true); };
  const checkRelease = async () => {
    if (!active || releasing) return;
    try {
      const down = await options.primaryButtonDown();
      if (!active || releasing) return;
      if (!down) { release(); return; }
      poll = setTimeout(() => void checkRelease(), 120);
    } catch {
      // On compositors without global button state, local mouseup remains active.
    }
  };
  const startNative = () => {
    if (nativeStarted) return;
    nativeStarted = true;
    void options.startDragging().then(() => {
      if (!active || releasing) return;
      // Give the OS the first event turn to enter its native drag loop. The IPC
      // call only queues dragging; an immediate button query can race activation.
      if (options.readPosition) poll = setTimeout(() => void checkRelease(), 160);
      else void checkRelease();
    }).catch(error => {
      if (!active || releasing) return;
      options.onError(error);
      cancel();
    });
  };
  const move = (event: Event) => {
    const mouse = event as MouseEvent;
    // WKWebView may report buttons=0 during a valid press. The press lifecycle
    // and native release check own this gesture instead of that field.
    if (Math.hypot(mouse.screenX - options.startX, mouse.screenY - options.startY) < 5) return;
    markDragged();
    startNative();
  };
  options.target.addEventListener("mousemove", move);
  options.target.addEventListener("mouseup", release);
  options.target.addEventListener("pointercancel", cancel);
  if (options.readPosition) startNative();
  return cleanup;
}

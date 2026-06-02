/**
 * use-device-interaction — pointer + keyboard handling for the interactive
 * device mirror. Classifies a pointer interaction as tap / long-press / swipe,
 * normalizes coordinates against the rendered canvas rect, and forwards
 * gestures to the UI server via the WebSocket `send`.
 */

import { useRef, useCallback, useEffect } from 'preact/hooks';
import type { ClientMessage } from '../ui-protocol.js';

export const TAP_MOVE_THRESHOLD = 10; // CSS px
export const LONG_PRESS_MS = 500;

export type GestureKind = 'tap' | 'long-press' | 'swipe';

export function classifyGesture(g: { dx: number; dy: number; durationMs: number }): GestureKind {
  const dist = Math.hypot(g.dx, g.dy);
  if (dist >= TAP_MOVE_THRESHOLD) return 'swipe';
  if (g.durationMs >= LONG_PRESS_MS) return 'long-press';
  return 'tap';
}

export function normalizePoint(clientX: number, clientY: number, rect: DOMRect): { x: number; y: number } {
  // Guard a zero-size rect (e.g. canvas not yet laid out) so we never divide by
  // zero and send NaN coordinates to the server.
  if (rect.width === 0 || rect.height === 0) return { x: 0, y: 0 };
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return {
    x: clamp((clientX - rect.left) / rect.width),
    y: clamp((clientY - rect.top) / rect.height),
  };
}

// Matches any single Unicode code point (incl. space and emoji from the OS
// picker); excludes named keys like 'Enter'/'Tab'/'ArrowLeft' which are longer.
const PRINTABLE = /^.$/u;

export interface DeviceInteractionOptions {
  send: (msg: ClientMessage) => void;
  /** Whether interaction is currently allowed (unlocked). */
  enabled: boolean;
  /** True when interacting overrides an engaged lock during a run. */
  force?: boolean;
  /** Target worker id (multi-worker). */
  workerId?: number;
}

export function useDeviceInteraction(opts: DeviceInteractionOptions) {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  // `rect` is cached at pointerdown and reused for the whole gesture so we don't
  // call getBoundingClientRect() on every move (forced synchronous layout).
  const start = useRef<{ x: number; y: number; nx: number; ny: number; t: number; rect: DOMRect } | null>(null);
  const dragging = useRef(false);
  const pendingMove = useRef<{ x: number; y: number; tMs: number } | null>(null);
  const rafId = useRef<number | null>(null);

  const onPointerDown = useCallback((e: PointerEvent) => {
    const o = optsRef.current;
    if (!o.enabled) return;
    const canvas = e.currentTarget as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const n = normalizePoint(e.clientX, e.clientY, rect);
    start.current = { x: e.clientX, y: e.clientY, nx: n.x, ny: n.y, t: performance.now(), rect };
    dragging.current = false;
    canvas.setPointerCapture(e.pointerId);
    // Focus the canvas so it receives keydown events for text input.
    canvas.focus();
  }, []);

  const flushMove = useCallback(() => {
    rafId.current = null;
    const o = optsRef.current;
    const m = pendingMove.current;
    pendingMove.current = null;
    if (!dragging.current || !m) return;
    o.send({ type: 'mirror-touch-move', x: m.x, y: m.y, tMs: m.tMs, workerId: o.workerId, force: o.force });
  }, []);

  const onPointerMove = useCallback((e: PointerEvent) => {
    const o = optsRef.current;
    const s = start.current;
    if (!o.enabled || !s) return;
    const n = normalizePoint(e.clientX, e.clientY, s.rect);
    const tMs = Math.round(performance.now() - s.t);
    if (!dragging.current) {
      const dist = Math.hypot(e.clientX - s.x, e.clientY - s.y);
      if (dist < TAP_MOVE_THRESHOLD) return;
      dragging.current = true;
      o.send({ type: 'mirror-touch-start', x: s.nx, y: s.ny, workerId: o.workerId, force: o.force });
    }
    pendingMove.current = { x: n.x, y: n.y, tMs };
    if (rafId.current == null) rafId.current = requestAnimationFrame(flushMove);
  }, [flushMove]);

  const onPointerUp = useCallback((e: PointerEvent) => {
    const o = optsRef.current;
    const s = start.current;
    start.current = null;
    if (!o.enabled || !s) { dragging.current = false; return; }
    const end = normalizePoint(e.clientX, e.clientY, s.rect);
    const tMs = Math.round(performance.now() - s.t);

    if (dragging.current) {
      dragging.current = false;
      if (rafId.current != null) { cancelAnimationFrame(rafId.current); rafId.current = null; }
      pendingMove.current = null;
      o.send({ type: 'mirror-touch-end', x: end.x, y: end.y, tMs, workerId: o.workerId, force: o.force });
      return;
    }

    const kind = classifyGesture({ dx: e.clientX - s.x, dy: e.clientY - s.y, durationMs: tMs });
    const force = o.force;
    const workerId = o.workerId;
    if (kind === 'tap') {
      o.send({ type: 'mirror-tap', x: s.nx, y: s.ny, workerId, force });
    } else if (kind === 'long-press') {
      o.send({ type: 'mirror-long-press', x: s.nx, y: s.ny, durationMs: tMs, workerId, force });
    } else {
      o.send({ type: 'mirror-touch-start', x: s.nx, y: s.ny, workerId, force });
      o.send({ type: 'mirror-touch-end', x: end.x, y: end.y, tMs, workerId, force });
    }
  }, []);

  // If the OS takes over the gesture (e.g. a second touch, parent scroll, or
  // sleep), pointerup never fires — clear start so a stale point can't be
  // misclassified as a long-press on the next pointerup.
  const onPointerCancel = useCallback(() => {
    const o = optsRef.current;
    if (dragging.current) {
      o.send({ type: 'mirror-touch-cancel', workerId: o.workerId, force: o.force });
    }
    dragging.current = false;
    if (rafId.current != null) { cancelAnimationFrame(rafId.current); rafId.current = null; }
    pendingMove.current = null;
    start.current = null;
  }, []);

  const onKeyDown = useCallback((e: KeyboardEvent) => {
    const o = optsRef.current;
    if (!o.enabled) return;
    const force = o.force;
    const workerId = o.workerId;
    // Key names are lowercased by both agents; 'Enter'/'Backspace' match their
    // pressKey maps ('enter'/'return', 'delete'/'backspace'). 'DEL' would NOT.
    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      o.send({ type: 'mirror-press-key', key: 'Enter', workerId, force });
      e.preventDefault();
    } else if (e.key === 'Backspace' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      o.send({ type: 'mirror-press-key', key: 'Backspace', workerId, force });
      e.preventDefault();
    } else if (PRINTABLE.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
      o.send({ type: 'mirror-input-text', text: e.key, workerId, force });
      e.preventDefault();
    }
  }, []);

  // If interaction is disabled mid-drag (e.g. a run starts while dragging), the
  // captured pointer's up/cancel handlers are detached — cancel the in-flight
  // touch so the device isn't left with a finger held down.
  useEffect(() => {
    if (!opts.enabled && dragging.current) {
      opts.send({ type: 'mirror-touch-cancel', workerId: opts.workerId, force: opts.force });
      dragging.current = false;
      if (rafId.current != null) { cancelAnimationFrame(rafId.current); rafId.current = null; }
      pendingMove.current = null;
      start.current = null;
    }
  }, [opts.enabled, opts.send, opts.workerId, opts.force]);

  // Cancel any pending coalesced-move frame on unmount.
  useEffect(() => () => {
    if (rafId.current != null) cancelAnimationFrame(rafId.current);
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onKeyDown };
}

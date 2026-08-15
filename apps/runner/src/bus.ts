import { EventEmitter } from 'node:events';
import type { RunEvent } from '@mimic/schema';

/**
 * In-process pub/sub for live run events.
 *
 * Late subscribers matter here: the web app opens its socket a beat after the
 * run starts, so every event is replayed from a per-run buffer on subscribe.
 * Nothing in the console is ever missing just because of timing.
 */

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

const buffers = new Map<string, RunEvent[]>();
const finished = new Set<string>();
const MAX_BUFFERED = 2000;

export function publish(event: RunEvent): void {
  const buf = buffers.get(event.runId) ?? [];
  buf.push(event);
  if (buf.length > MAX_BUFFERED) buf.splice(0, buf.length - MAX_BUFFERED);
  buffers.set(event.runId, buf);
  emitter.emit(event.runId, event);
}

export function markFinished(runId: string): void {
  finished.add(runId);
  emitter.emit(`${runId}:end`);
  // Keep the buffer around briefly so a reconnecting client still gets history.
  setTimeout(
    () => {
      buffers.delete(runId);
      finished.delete(runId);
    },
    10 * 60 * 1000,
  ).unref?.();
}

export function isFinished(runId: string): boolean {
  return finished.has(runId);
}

export interface Subscription {
  unsubscribe: () => void;
}

export function subscribe(
  runId: string,
  onEvent: (e: RunEvent) => void,
  onEnd?: () => void,
): Subscription {
  // Replay history first so the client's console is complete.
  for (const e of buffers.get(runId) ?? []) onEvent(e);
  if (finished.has(runId)) {
    onEnd?.();
    return { unsubscribe: () => {} };
  }

  const handler = (e: RunEvent) => onEvent(e);
  const endHandler = () => onEnd?.();
  emitter.on(runId, handler);
  emitter.once(`${runId}:end`, endHandler);

  return {
    unsubscribe: () => {
      emitter.off(runId, handler);
      emitter.off(`${runId}:end`, endHandler);
    },
  };
}

import { config } from './config';

/**
 * Tiny concurrency gate. Each replay owns a whole Chromium instance, so a
 * handful of simultaneous runs will happily exhaust a laptop's memory —
 * everything past the limit waits its turn instead of thrashing.
 */

let active = 0;
const waiting: (() => void)[] = [];

export function queueDepth(): number {
  return waiting.length;
}

export function activeRuns(): number {
  return active;
}

async function acquire(): Promise<void> {
  if (active < config.browser.maxConcurrency) {
    active += 1;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
}

function release(): void {
  active = Math.max(0, active - 1);
  const next = waiting.shift();
  next?.();
}

export async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}

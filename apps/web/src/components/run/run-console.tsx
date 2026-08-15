'use client';

import { useEffect, useRef } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { RunEvent, RunPhase, RunStatus } from '@mimic/schema';
import { cn } from '@/lib/utils';

/**
 * The live run console.
 *
 * Every line is a real event from the runner — what it's looking for, what it
 * matched, what it filled. Watching a headless browser work is the difference
 * between "it's loading" and "it found your flight".
 */

const PHASE_LABEL: Record<RunPhase, string> = {
  boot: 'Starting',
  navigate: 'Navigating',
  resolve: 'Resolving',
  fill: 'Filling',
  act: 'Acting',
  wait: 'Waiting',
  extract: 'Reading',
  render: 'Rendering',
  done: 'Done',
  error: 'Failed',
};

const PHASE_COLOR: Record<RunPhase, string> = {
  boot: 'bg-sand-400',
  navigate: 'bg-sky-400',
  resolve: 'bg-violet-400',
  fill: 'bg-ember-400',
  act: 'bg-ember-500',
  wait: 'bg-sand-400',
  extract: 'bg-lime-500',
  render: 'bg-lime-500',
  done: 'bg-lime-600',
  error: 'bg-rust-500',
};

interface Props {
  events: RunEvent[];
  status: RunStatus;
  progress: number;
  /** Shown while the first event is still in flight. */
  startedAt?: number;
}

export function RunConsole({ events, status, progress }: Props) {
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the tail, but stop fighting the user if they scroll up to read.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !pinned.current) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };

  const running = status === 'running' || status === 'starting' || status === 'queued';
  const visible = events.filter((e) => e.level !== 'debug');
  const last = visible[visible.length - 1];

  return (
    <div className="w-full min-w-0 overflow-hidden rounded-[18px] border border-sand-200 bg-white/70">
      {/* header + progress */}
      <div className="border-b border-sand-200 px-4 py-3">
        <div className="flex items-center gap-2.5">
          <StatusDot status={status} />
          <span className="text-[13px] font-medium text-ink-900">
            {running ? PHASE_LABEL[last?.phase ?? 'boot'] : STATUS_TEXT[status]}
          </span>
          <span className="tabular ml-auto text-[12px] text-ink-400">{Math.round(progress)}%</span>
        </div>

        <div className="mt-2.5 h-1 overflow-hidden rounded-full bg-sand-200">
          <motion.div
            className={cn('h-full rounded-full', status === 'failed' ? 'bg-rust-500' : 'bg-ember-500')}
            animate={{ width: `${Math.max(2, progress)}%` }}
            transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          />
        </div>
      </div>

      {/* stream */}
      <div ref={scroller} onScroll={onScroll} className="max-h-80 overflow-y-auto px-4 py-3">
        <AnimatePresence initial={false}>
          {visible.map((event) => (
            <motion.div
              key={`${event.seq}-${event.ts}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="group flex items-start gap-2.5 py-1"
            >
              <span
                className={cn(
                  'mt-[7px] size-1.5 shrink-0 rounded-full',
                  PHASE_COLOR[event.phase],
                  event.level === 'warn' && 'bg-amber-400',
                  event.level === 'error' && 'bg-rust-500',
                )}
              />
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    'text-[13px] leading-snug',
                    event.level === 'error'
                      ? 'text-rust-500'
                      : event.level === 'warn'
                        ? 'text-amber-700'
                        : 'text-ink-700',
                  )}
                >
                  {event.message}
                </p>
                {event.detail && (
                  // Tracking URLs and Playwright call logs have no spaces to
                  // wrap at, so they must be broken anywhere and clipped.
                  <p className="mt-0.5 line-clamp-3 break-all font-mono text-[11px] leading-snug text-ink-400">
                    {event.detail}
                  </p>
                )}
              </div>
            </motion.div>
          ))}
        </AnimatePresence>

        {running && (
          <div className="flex items-center gap-2.5 py-1">
            <span className="mt-[7px] size-1.5 shrink-0 rounded-full bg-ember-400" />
            <ThinkingDots />
          </div>
        )}

        {!visible.length && !running && (
          <p className="py-6 text-center text-[13px] text-ink-400">No events yet.</p>
        )}
      </div>
    </div>
  );
}

const STATUS_TEXT: Record<RunStatus, string> = {
  queued: 'Queued',
  starting: 'Starting',
  running: 'Running',
  needs_attention: 'Needs your attention',
  succeeded: 'Finished',
  partial: 'Finished with nothing to show',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

function StatusDot({ status }: { status: RunStatus }) {
  const running = ['queued', 'starting', 'running'].includes(status);
  const tone =
    status === 'failed'
      ? 'bg-rust-500'
      : status === 'succeeded'
        ? 'bg-lime-600'
        : status === 'needs_attention'
          ? 'bg-amber-500'
          : status === 'partial'
            ? 'bg-sand-500'
            : 'bg-ember-500';

  return (
    <span className="relative flex size-2">
      {running && (
        <span className={cn('absolute inline-flex size-full animate-ping rounded-full opacity-70', tone)} />
      )}
      <span className={cn('relative inline-flex size-2 rounded-full', tone)} />
    </span>
  );
}

/** The "still working" cue — three dots, breathing. */
function ThinkingDots() {
  return (
    <span className="flex items-center gap-1 py-1" aria-label="Working">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block size-1 rounded-full bg-ink-400"
          animate={{ opacity: [0.25, 1, 0.25] }}
          transition={{ duration: 1.2, repeat: Infinity, delay: i * 0.18 }}
        />
      ))}
    </span>
  );
}

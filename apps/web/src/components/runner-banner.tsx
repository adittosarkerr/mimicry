'use client';

import { useEffect, useState } from 'react';
import { RUNNER_URL, runnerUnreachable } from '@/lib/api';

/**
 * Says the backend is missing, once, at the top of the page.
 *
 * Without this, a deployed site looks entirely healthy until you press
 * something, and then reports "Failed to fetch" — a message that names neither
 * what failed nor what to do. Every feature here goes through the runner, so
 * when it is unreachable that is the only fact worth showing.
 */
export function RunnerBanner() {
  const [down, setDown] = useState(false);

  useEffect(() => {
    let cancelled = false;

    /* One check, and only a real network failure counts. A 4xx or 5xx means
       the runner answered — it is there, and whatever went wrong belongs in
       the error of the thing that asked, not in a banner across every page. */
    const check = () =>
      fetch(`${RUNNER_URL}/health`, { cache: 'no-store' })
        .then(() => {
          if (!cancelled) setDown(false);
        })
        .catch(() => {
          if (!cancelled) setDown(true);
        });

    void check();

    /* A container host that sleeps takes a while to wake, so this looks again
       rather than leaving a stale warning up once it recovers. */
    const timer = setInterval(check, 20_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!down) return null;

  return (
    <div
      role="status"
      className="border-b border-red-200 bg-rust-100 px-5 py-2.5 text-center text-[13px] leading-relaxed text-rust-500"
    >
      <span className="font-semibold">The Mimic runner isn’t reachable.</span>{' '}
      {runnerUnreachable()}
    </div>
  );
}

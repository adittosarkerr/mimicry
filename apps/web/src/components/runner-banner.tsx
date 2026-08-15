'use client';

import { useEffect, useState } from 'react';
import { RUNNER_URL, runnerUnreachable } from '@/lib/api';

/**
 * Says what is unavailable, once, at the top of the page.
 *
 * Without this, a deployed site looks entirely healthy until you press
 * something, and then reports "Failed to fetch" — a message that names neither
 * what failed nor what to do.
 *
 * Deliberately narrow now that the site answers for itself when there is no
 * runner: the library, the marketplace, the account and the payment sandbox
 * all work, and a banner saying everything is broken would be a lie that sends
 * people looking for a fault that isn't there. Only recording, running and
 * voice actually need the browser the runner has.
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
      className="border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-center text-[13px] leading-relaxed text-amber-900"
    >
      <span className="font-semibold">Recording, running and voice are unavailable.</span>{' '}
      {runnerUnreachable()}
    </div>
  );
}

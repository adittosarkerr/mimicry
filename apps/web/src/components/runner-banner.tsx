'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/**
 * Says what is missing, once, at the top of the page.
 *
 * Without it, a site looks entirely healthy until you press something and then
 * reports "Failed to fetch" — a message naming neither what failed nor what to
 * do.
 *
 * It asks whichever backend is answering rather than the runner specifically.
 * That distinction is the whole point now: a deployed site with no runner can
 * still record, run and plan, so a banner announcing those as unavailable
 * would send someone hunting for a fault that isn't there. What it reports is
 * only what nothing available can do.
 */
export function RunnerBanner() {
  const [missing, setMissing] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    const check = () =>
      api
        .capabilities()
        .then((it) => {
          if (cancelled) return;

          /* Nowhere to keep anything. Everything else is downstream of this,
             so it is the only one worth a banner — the rest each say their own
             piece where they are used. */
          if (it.store === 'none') {
            setMissing(
              'This site has no database connected, so nothing can be saved — no accounts, no automations, no history. Set the three Supabase variables (see DEPLOYING.md) and redeploy.',
            );
            return;
          }
          setMissing(null);
        })
        .catch(() => {
          if (!cancelled) {
            setMissing(
              'Nothing is answering — neither this site nor a runner. If this is your own machine, start the runner with `npm run dev:runner`.',
            );
          }
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

  if (!missing) return null;

  return (
    <div
      role="status"
      className="border-b border-amber-200 bg-amber-50 px-5 py-2.5 text-center text-[13px] leading-relaxed text-amber-900"
    >
      {missing}
    </div>
  );
}

import { nanoid } from 'nanoid';
import type { Run } from '@mimic/schema';
import { library, quota, store, unavailableReason, userIdFrom } from '@/lib/server/backend';
import { OVER_BUDGET, runAutomation, runBudgetMs } from '@/lib/server/runner';

/**
 * Running an automation, here, with a real browser.
 *
 * The engine is the runner's own — same code, same extractor, same site
 * profiles — driving a Chromium built for serverless instead of the one
 * Playwright installs. What is different is that a function has a deadline and
 * no socket, so this runs to completion and hands back the finished run rather
 * than a id to follow live.
 */

export const dynamic = 'force-dynamic';
/* Vercel's own ceiling is 60s on Hobby and 300s on Pro. Asking for 300 is
   harmless on a plan that caps lower — it is clamped, not rejected. */
export const maxDuration = 300;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!store || !library || !quota) return json({ error: unavailableReason() }, 503);

  const { id } = await ctx.params;
  const automation = await library.getAutomation(id);
  if (!automation) return json({ error: 'No automation with that id.' }, 404);

  const values = ((await req.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;

  /* Reserved keys configure the run rather than the form. Fewer pages than the
     runner's ten by default: each one is a page load inside a budget measured
     in seconds, and coming back with two full pages beats being killed during
     the fifth. */
  const maxPages = Math.min(4, Number(values.__pages ?? 3) || 3);
  delete values.__pages;
  delete values.__request;

  const missing = automation.schema.fields
    .filter((f) => f.required && f.exposure !== 'constant')
    .filter((f) => {
      const v = values[f.key] ?? f.defaultValue;
      return v === undefined || v === null || v === '';
    })
    .map((f) => f.key);
  if (missing.length) return json({ error: 'Missing required fields', missing }, 422);

  const userId = (await userIdFrom(req)) ?? automation.ownerId;

  const verdict = await quota.checkQuota(userId);
  if (!verdict.allowed) return json({ error: verdict.message, quota: verdict.state }, 429);
  await quota.recordRun(userId);

  const runId = `run_${nanoid(12)}`;
  const startedAt = Date.now();

  /* Written before the browser starts, so a function that is killed outright
     still leaves evidence that something was attempted. A run that vanishes
     without trace is the one nobody can debug. */
  await library.saveRun({
    id: runId,
    automationId: automation.id,
    userId,
    status: 'running',
    startedAt,
    input: values,
    events: [],
  } as Run);

  try {
    /* Two deadlines, and the engine's own is the one that matters: it stops
       and reports what it has. The outer race only exists because a hang
       inside the browser would otherwise be killed by the platform with no
       explanation at all. */
    const run = await Promise.race([
      runAutomation({ automation, values, runId, userId, maxPages, headless: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(OVER_BUDGET)), runBudgetMs + 5_000),
      ),
    ]);

    await library.saveRun(run);
    return json({ runId, status: run.status, run });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const outOfTime = message === OVER_BUDGET;
    const failed: Run = {
      id: runId,
      automationId: automation.id,
      userId,
      status: 'failed',
      startedAt,
      finishedAt: Date.now(),
      durationMs: Date.now() - startedAt,
      input: values,
      error: {
        code: outOfTime ? 'timeout' : 'internal',
        message,
        suggestion: outOfTime
          ? 'Deploy the runner and this automation will run with no time limit.'
          : undefined,
      },
      events: [],
    };
    await library.saveRun(failed).catch(() => {});
    return json({ runId, status: 'failed', run: failed, error: message }, 200);
  }
}

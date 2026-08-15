import { nanoid } from 'nanoid';
import { Automation, Trace } from '@mimic/schema';
import { library, store, unavailableReason } from '@/lib/server/backend';
import { compileTrace, normalizeTrace, runnerConfig } from '@/lib/server/runner';

/**
 * Recordings arriving from the extension.
 *
 * The extension posts here directly, so this is the one route that is not
 * called by our own pages and the one that needs its own shared secret —
 * `MIMIC_INGEST_TOKEN`, the same value the extension is configured with.
 *
 * Unlike the runner, this compiles in the request rather than answering fast
 * and refining in the background: a serverless function ends when it responds,
 * so "refine afterwards" would mean refining never. The extension already
 * waits, and a full compile is well inside the budget — it reads the trace and
 * asks the model, with no browser involved.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      'cache-control': 'no-store',
      /* The extension is not a page on this site, so its request is
         cross-origin by definition. Only this route needs to say so. */
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'content-type, x-mimic-token',
      'access-control-allow-methods': 'POST, OPTIONS',
    },
  });

export function OPTIONS() {
  return json({}, 204);
}

export async function POST(req: Request) {
  const expected = process.env.MIMIC_INGEST_TOKEN;
  if (!expected) {
    return json(
      { error: 'This site has no MIMIC_INGEST_TOKEN set, so it cannot accept recordings.' },
      503,
    );
  }
  if (req.headers.get('x-mimic-token') !== expected) {
    return json({ error: 'That ingest token is not right.' }, 401);
  }

  if (!store || !library) return json({ error: unavailableReason() }, 503);

  const body = (await req.json().catch(() => ({}))) as {
    trace?: unknown;
    name?: string;
    description?: string;
    ownerId?: string;
  };

  const parsed = Trace.safeParse(body.trace);
  if (!parsed.success) {
    return json(
      { error: 'That recording could not be read.', issues: parsed.error.issues.slice(0, 8) },
      400,
    );
  }

  // Repair the trace before anything reads it, so the compiled form and the
  // replay both work from the same corrected steps.
  const trace = { ...parsed.data, steps: normalizeTrace(parsed.data.steps) };
  if (trace.steps.length < 2) {
    return json({ error: 'The recording is empty — nothing was captured.' }, 400);
  }

  const { schema, emoji, warning } = await compileTrace(trace);
  const now = Date.now();
  const givenName = typeof body.name === 'string' ? body.name.trim() : '';

  const automation: Automation = {
    id: `au_${nanoid(12)}`,
    ownerId: typeof body.ownerId === 'string' ? body.ownerId : undefined,
    name: (givenName || schema.name || trace.title || `Task on ${trace.origin}`).slice(0, 120),
    description: (body.description || schema.description).slice(0, 600),
    site: trace.origin,
    category: schema.category,
    emoji,
    createdAt: now,
    updatedAt: now,
    schema: { ...schema, name: givenName || schema.name },
    trace,
    stats: { runs: 0, successes: 0, failures: 0 },
    visibility: 'private',
    refining: false,
  };

  await library.saveAutomation(automation);

  return json({
    automationId: automation.id,
    fields: automation.schema.fields.length,
    refining: false,
    warning:
      warning ??
      (runnerConfig.deepseek.enabled
        ? undefined
        : 'Built from rules alone — set DEEPSEEK_API_KEY for better field names and result detection.'),
  });
}

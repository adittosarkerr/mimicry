import type { Automation } from '@mimic/schema';
import { library, store, unavailableReason, userIdFrom } from '@/lib/server/backend';
import {
  authorAutomation,
  planFromTranscript,
  profileHosts,
  repairHostnames,
  resolveSpelling,
  runnerConfig,
  saveAutomation,
  sitesNamedIn,
} from '@/lib/server/runner';

/**
 * A spoken request turned into a plan — the same logic the runner applies.
 *
 * Authoring opens the site and works out how to operate it, so this needs a
 * browser as much as a run does, and gets one the same way.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const sameHost = (a: string, b: string) =>
  a.replace(/^www\./, '') === b.replace(/^www\./, '');

/**
 * The last word, when the platform is about to have it.
 *
 * Vercel stops a function at its limit and answers 504, and the page shows
 * "Request failed (504)" — a number that names neither what was being done nor
 * what would make it work. Planning is given a deadline a few seconds inside
 * that, so whatever happens the reply comes from here.
 */
const RAN_OUT =
  'That took longer than this site is allowed to spend on one request. Working out how to drive a site nobody has recorded means opening it in a browser, and that does not always fit in a minute. Deploy the runner (see DEPLOYING.md) and it has no limit — or record the task once with the extension and it replays exactly.';

export async function POST(req: Request) {
  try {
    /* The inner work respects the deadline stage by stage, which handles the
       ordinary case. This is for the one it cannot: a single call that hangs —
       a model that never answers, a page that never loads — where there is no
       next stage to check the clock. */
    return await Promise.race([
      plan(req),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(RAN_OUT)), (maxDuration - 3) * 1000),
      ),
    ]);
  } catch (err) {
    if (err instanceof Error && err.message === RAN_OUT) return json({ error: RAN_OUT }, 200);
    /* An unhandled throw here becomes a 500 with an empty body, and the page
       shows "Planning failed (500)" — which names nothing anyone can act on.
       Whatever went wrong, say it. */
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message.slice(0, 600) }, 500);
  }
}

async function plan(req: Request): Promise<Response> {
  if (!store || !library) return json({ error: unavailableReason() }, 503);

  /* Five seconds of headroom under the function's own limit, so the answer is
     ours rather than the platform's. */
  const deadline = Date.now() + (maxDuration - 5) * 1000;

  const body = (await req.json().catch(() => ({}))) as { transcript?: string };
  const spoken = typeof body.transcript === 'string' ? body.transcript.trim() : '';
  if (!spoken) return json({ error: 'No transcript supplied.' }, 400);

  if (!runnerConfig.deepseek.enabled) {
    return json(
      {
        error:
          'Voice needs DEEPSEEK_API_KEY. Set it in this project’s environment variables and redeploy.',
      },
      503,
    );
  }

  const ownerId = (await userIdFrom(req)) ?? undefined;
  const all = await library.listAutomations(ownerId);

  /* The user's own automations name the sites they talk about, so they are the
     correction key for a recogniser that turns "gozayaan dot com" into
     something nobody has heard of. Spelling asides are resolved first: someone
     spelling a name out is correcting an earlier mishearing.

     The sites with profiles join them, so the first request of a fresh install
     can name one before anything has been recorded. */
  const transcript = repairHostnames(resolveSpelling(spoken), [
    ...all.map((a) => a.site),
    ...profileHosts(),
  ]);

  const known = knownTemplates(all);

  /* "Make me an automation that…" is a request to build, not to find.
     Answering it with something already saved is the one response that cannot
     be right — the person has said they want a new one. */
  const wantsNew =
    /\b(make|build|create|write|set\s*up|author)\b[^.?!]{0,30}\b(automation|workflow|task|bot|script)\b/i.test(
      transcript,
    ) || /\bfrom scratch\b|\bbrand new\b|\bnew automation\b/i.test(transcript);

  if (wantsNew) {
    const authored = await authorAutomation(transcript, ownerId, known, { deadline });
    if (authored.automation) {
      await saveAutomation(authored.automation);
      return json(built(authored.automation, authored.confidence));
    }
    return json({
      automationId: null,
      confidence: authored.confidence,
      values: {},
      say: "I couldn't build that one.",
      missing: [],
      created: false,
      automation: null,
      suggestion: authored.refusal,
    });
  }

  /* Name a host out loud and only that host is eligible. "fmovies.org" was
     once answered with a saved automation for fmovies.com at 95% confidence —
     a different domain, a different operator, and a page of something else
     entirely. The model reads the two as the same word however firmly the
     prompt says otherwise, so the rule is enforced here instead. */
  const namedSites = sitesNamedIn(transcript);

  const candidates = all.filter((a) => {
    if (namedSites.length && !namedSites.some((host) => sameHost(host, a.site))) return false;
    // An authored automation is a proposal until it has produced results once.
    if (/\(authored\)/.test(a.schema.compiledBy) && !a.verifiedAt) return false;
    // Something run twice that has never worked is not a candidate.
    if (a.stats.runs >= 2 && a.stats.successes === 0) return false;
    return true;
  });

  const plan = await planFromTranscript(transcript, candidates);
  const chosen = plan.automationId ? candidates.find((a) => a.id === plan.automationId) : undefined;

  if (chosen) {
    return json({
      ...plan,
      created: false,
      automation: {
        id: chosen.id,
        name: chosen.name,
        site: chosen.site,
        emoji: chosen.emoji,
        schema: chosen.schema,
      },
    });
  }

  // Nothing fits. Rather than dead-ending, write one.
  const authored = await authorAutomation(transcript, ownerId, known);
  if (!authored.automation) {
    return json({
      ...plan,
      created: false,
      automation: null,
      suggestion: authored.refusal ?? plan.suggestion,
    });
  }

  await saveAutomation(authored.automation);
  return json(built(authored.automation, authored.confidence));
}

/**
 * URL shapes learned from recordings, one per site.
 *
 * Every recording that ended on a query URL teaches Mimic how that site takes
 * its inputs. Handing those to the author turns "I don't know that site" into
 * "here is one that worked".
 */
function knownTemplates(automations: Automation[]) {
  const bySite = new Map<string, ReturnType<typeof describe>>();

  function describe(a: Automation) {
    return {
      site: a.site,
      template: a.schema.urlTemplate!,
      fields: a.schema.fields
        .filter((f) => a.schema.urlTemplate!.includes(`{${f.key}}`))
        .map((f) => ({ key: f.key, label: f.label, kind: f.kind, example: f.defaultValue })),
    };
  }

  for (const automation of automations) {
    if (!automation.schema.urlTemplate) continue;
    // A recording beats an authored guess as a source of truth.
    if (/\(authored\)/.test(automation.schema.compiledBy) && bySite.has(automation.site)) continue;
    bySite.set(automation.site, describe(automation));
  }

  return Array.from(bySite.values()).slice(0, 12);
}

/** The shape the voice studio expects for a freshly authored automation. */
function built(automation: Automation, confidence: number) {
  return {
    automationId: automation.id,
    confidence,
    values: Object.fromEntries(
      automation.schema.fields
        .filter((f) => f.defaultValue !== null && f.defaultValue !== undefined)
        .map((f) => [f.key, f.defaultValue]),
    ),
    say: `I built this: ${automation.name}.`,
    missing: automation.schema.fields
      .filter((f) => f.required && f.defaultValue == null)
      .map((f) => f.key),
    created: true,
    automation: {
      id: automation.id,
      name: automation.name,
      site: automation.site,
      emoji: automation.emoji,
      schema: automation.schema,
    },
  };
}

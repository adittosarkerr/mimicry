import { library, store, unavailableReason } from '@/lib/server/backend';
import { compileTrace, normalizeTrace } from '@/lib/server/runner';

/**
 * Rebuilds an automation's form from the recording it already has.
 *
 * The trace is the durable artefact; the form is derived from it. So when the
 * compiler learns something — that a bare "21" is not a date, that a stepper
 * with no readable value must not be marked required — every automation
 * already saved can pick that up without anyone recording the task again.
 */

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!store || !library) return json({ error: unavailableReason() }, 503);

  const { id } = await ctx.params;
  const automation = await library.getAutomation(id);
  if (!automation) return json({ error: 'No automation with that id.' }, 404);

  /* Only recordings can be recompiled.
   *
   * An authored automation has no recording behind it — its "trace" is a
   * single templated navigation, and its field values live in the schema
   * rather than in any captured step. Running the recording compiler over that
   * strips every default and leaves a form that does nothing. */
  if (/\(authored\)/.test(automation.schema.compiledBy)) {
    return json(
      {
        error:
          'This automation was written from a description, not recorded, so there is no recording to rebuild the form from.',
      },
      400,
    );
  }

  const trace = { ...automation.trace, steps: normalizeTrace(automation.trace.steps) };
  const { schema, emoji } = await compileTrace(trace);

  if (!new URL(req.url).searchParams.get('dry')) {
    await library.saveAutomation({ ...automation, schema, emoji, trace, updatedAt: Date.now() });
  }

  return json({ fields: schema.fields.length, schema });
}

/**
 * Voice authoring: a request nothing recorded can serve, built from scratch
 * and then actually run.
 *
 *   node scripts/smoke-author.mjs "search youtube for soundpeats c30 reviews"
 */
const RUNNER = process.env.RUNNER_URL || 'http://localhost:8787';
const request = process.argv[2] || 'search youtube for soundpeats c30 review videos';

const j = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t.slice(0, 400) };
  }
};

console.log('request:', request);
const plan = await j(
  await fetch(`${RUNNER}/api/voice/plan`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ transcript: request }),
  }),
);

console.log('created:', plan.created, '| confidence:', plan.confidence);
console.log('say:', plan.say);
if (plan.suggestion) console.log('suggestion:', plan.suggestion);
if (!plan.automation) process.exit(1);

console.log('automation:', plan.automation.name, `(${plan.automation.site})`);
console.log(
  'fields:',
  plan.automation.schema.fields.map((f) => `${f.key}(${f.kind})="${f.defaultValue}"`).join(' | '),
);
console.log(
  'steps:',
  plan.automation.schema.fields.length,
  '| start:',
  plan.automation.schema.output.layout,
);

const started = Date.now();
const run = await j(
  await fetch(`${RUNNER}/api/automations/${plan.automation.id}/run?wait=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(plan.values ?? {}),
  }),
);

console.log('status:', run.status, `(${Math.round((Date.now() - started) / 1000)}s)`);
console.log('finalUrl:', run.output?.finalUrl);
console.log('items:', run.output?.items?.length ?? 0);
(run.output?.items || []).slice(0, 5).forEach((i, n) => console.log(`  ${n + 1}. ${i.title.slice(0, 66)}`));
if (run.error) console.log('error:', run.error.code, '-', run.error.message);
console.log('events:');
(run.events || []).forEach((e) => console.log(`  [${e.phase}] ${e.message}`));

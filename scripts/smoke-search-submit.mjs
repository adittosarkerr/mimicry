/**
 * A recording that types a query but never submits it.
 *
 * The user's Enter keypress didn't make it into the trace, so replay filled the
 * box and then scraped whatever page it was still sitting on — returning two
 * unrelated posts instead of the search results. The recorded final URL carried
 * `?s=…`, which is the evidence that a submit was supposed to happen.
 *
 *   node scripts/smoke-search-submit.mjs [query]
 */
const RUNNER = process.env.RUNNER_URL || 'http://localhost:8787';
const TOKEN = process.env.MIMIC_INGEST_TOKEN || 'dev-local-token-change-me';
const START = 'https://fitgirl-repacks.site/page/2/';
const query = process.argv[2] || 'cyberpunk';

const base = { url: START, delayBefore: 500, hints: {}, meta: { kind: 'unknown', options: [], required: false } };

const trace = {
  id: 'tr_sub1',
  version: 1,
  createdAt: Date.now(),
  startUrl: START,
  // What the recording ended on — note the query string.
  finalUrl: 'https://fitgirl-repacks.site/?s=god+of+war',
  origin: 'fitgirl-repacks.site',
  title: 'Search the catalogue',
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  steps: [
    { ...base, id: 'sb_1', seq: 0, ts: Date.now(), type: 'navigate', value: START, delayBefore: 0 },
    {
      ...base,
      id: 'sb_2',
      seq: 1,
      ts: Date.now() + 1200,
      type: 'input',
      target: {
        candidates: [
          { strategy: 'css', value: 'input[name="s"]', unique: false, score: 88 },
          { strategy: 'css', value: '#search-form-1 input', unique: false, score: 60 },
        ],
        frame: { framePath: [], shadowPath: [], frameUrl: START },
        snapshot: {
          tag: 'input',
          type: 'search',
          accessibleName: 'Search',
          attributes: { name: 's', placeholder: 'Search …' },
        },
      },
      value: 'god of war',
      meta: { kind: 'text', label: 'Search', options: [], required: true },
    },
    // No submit step at all — this is the bug being reproduced.
  ],
  requests: [],
  domSnapshots: [],
};

const j = async (r) => {
  const t = await r.text();
  try {
    return JSON.parse(t);
  } catch {
    return { raw: t.slice(0, 300) };
  }
};

const ing = await j(
  await fetch(`${RUNNER}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ trace, description: 'Missing-submit regression' }),
  }),
);
console.log('automation:', ing.automationId);

const auto = await j(await fetch(`${RUNNER}/api/automations/${ing.automationId}`));
console.log('name:', auto.name);
const key = auto.schema.fields[0]?.key;

const started = Date.now();
const run = await j(
  await fetch(`${RUNNER}/api/automations/${ing.automationId}/run?wait=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: query }),
  }),
);

console.log('status:', run.status, `(${Math.round((Date.now() - started) / 1000)}s)`);
console.log('finalUrl:', run.output?.finalUrl);
console.log('items:', run.output?.items?.length ?? 0);
(run.output?.items || []).slice(0, 6).forEach((i, n) => console.log(`  ${n + 1}. ${i.title.slice(0, 68)}`));
if (run.error) console.log('error:', run.error.code, '-', run.error.message);
console.log('events:');
(run.events || []).forEach((e) => console.log(`  [${e.phase}] ${e.message}`));

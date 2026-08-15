/**
 * End-to-end smoke test — no extension required.
 *
 * Builds a trace by hand, pushes it through ingest → compile → headless replay
 * → scrape, and prints what came back. Use it to check the runner after a
 * change without re-recording anything.
 *
 *   node scripts/smoke.mjs
 */
const RUNNER = process.env.RUNNER_URL || 'http://localhost:8787';
const TOKEN = process.env.MIMIC_INGEST_TOKEN || 'dev-local-token-change-me';

const loc = (strategy, value, extra = {}) => ({
  candidates: [{ strategy, value, unique: true, score: 90 }],
  frame: { framePath: [], shadowPath: [], frameUrl: 'https://en.wikipedia.org/wiki/Special:Search' },
  snapshot: { tag: extra.tag || 'input', attributes: {}, accessibleName: extra.an },
});

const base = {
  url: 'https://en.wikipedia.org/wiki/Special:Search',
  delayBefore: 500,
  hints: {},
  meta: { kind: 'unknown', options: [], required: false },
};

const trace = {
  id: 'tr_smoke1',
  version: 1,
  createdAt: Date.now(),
  startUrl: 'https://en.wikipedia.org/wiki/Special:Search',
  finalUrl: 'https://en.wikipedia.org/w/index.php?search=Bangladesh&fulltext=1',
  origin: 'en.wikipedia.org',
  title: 'Search Wikipedia',
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  steps: [
    { ...base, id: 'st_1', seq: 0, ts: Date.now(), type: 'navigate', value: base.url, delayBefore: 0 },
    {
      ...base,
      id: 'st_2',
      seq: 1,
      ts: Date.now(),
      type: 'input',
      target: loc('css', '#searchInput', { an: 'Search Wikipedia' }),
      value: 'Bangladesh',
      meta: { kind: 'text', label: 'Search', options: [], required: false },
    },
    {
      ...base,
      id: 'st_3',
      seq: 2,
      ts: Date.now(),
      type: 'click',
      target: loc('css', 'button.cdx-search-input__end-button', { tag: 'button', an: 'Search' }),
      value: 'Search',
      causedNavigation: true,
      meta: { kind: 'button', label: 'Search', options: [], required: false },
    },
  ],
  requests: [],
  domSnapshots: [],
};

const j = async (res) => {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 400) };
  }
};

console.log('1) ingest + compile …');
const ing = await fetch(`${RUNNER}/api/ingest`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: JSON.stringify({ trace, name: 'Search Wikipedia', description: 'Smoke test' }),
});
const ingData = await j(ing);
console.log('   ->', ing.status, ingData.automationId ?? JSON.stringify(ingData).slice(0, 200));
if (ingData.warning) console.log('   warning:', ingData.warning.slice(0, 160));
if (!ingData.automationId) process.exit(1);

console.log('2) compiled schema …');
const auto = await j(await fetch(`${RUNNER}/api/automations/${ingData.automationId}`));
console.log('   name:', auto.name, '| compiledBy:', auto.schema?.compiledBy);
console.log(
  '   fields:',
  (auto.schema?.fields || []).map((f) => `${f.key}(${f.kind},${f.exposure})="${f.defaultValue}"`).join(', '),
);

const searchKey = (auto.schema?.fields || []).find((f) => f.kind === 'text')?.key;
console.log(`3) headless run with ${searchKey} = "Photosynthesis" …`);
const t0 = Date.now();
const run = await j(
  await fetch(`${RUNNER}/api/automations/${ingData.automationId}/run?wait=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(searchKey ? { [searchKey]: 'Photosynthesis' } : {}),
  }),
);
console.log('   status:', run.status, `(${Math.round((Date.now() - t0) / 1000)}s)`);
console.log('   finalUrl:', run.output?.finalUrl);
console.log('   items:', run.output?.items?.length ?? 0);
(run.output?.items || []).slice(0, 5).forEach((i, n) =>
  console.log(`     ${n + 1}. ${i.title.slice(0, 64)}${i.url ? `  →  ${i.url.slice(0, 58)}` : ''}`),
);
if (run.output?.emptyReason) console.log('   empty:', run.output.emptyReason);
if (run.error) console.log('   error:', run.error.code, '-', run.error.message);
console.log('   events:');
(run.events || []).forEach((e) => console.log(`     [${e.phase}] ${e.message}`));

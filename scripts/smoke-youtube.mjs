/**
 * Reproduces the failure from the YouTube screenshot: the recorder captured a
 * cookie-rotation redirect as a navigation step, and replay dutifully visited
 * it, landing somewhere the search box does not exist.
 *
 * The redirect step here carries NO `redirect` hint, so this also proves the
 * fallback heuristic works on traces recorded before that hint existed.
 *
 *   node scripts/smoke-youtube.mjs
 */
const RUNNER = process.env.RUNNER_URL || 'http://localhost:8787';
const TOKEN = process.env.MIMIC_INGEST_TOKEN || 'dev-local-token-change-me';

const loc = (value, tag = 'input', an) => ({
  candidates: [{ strategy: 'css', value, unique: true, score: 90 }],
  frame: { framePath: [], shadowPath: [], frameUrl: 'https://www.youtube.com/' },
  snapshot: { tag, attributes: {}, accessibleName: an },
});

const base = {
  url: 'https://www.youtube.com/',
  delayBefore: 500,
  hints: {},
  meta: { kind: 'unknown', options: [], required: false },
};

const trace = {
  id: 'tr_yt1',
  version: 1,
  createdAt: Date.now(),
  startUrl: 'https://www.youtube.com/',
  finalUrl: 'https://www.youtube.com/results?search_query=fifa+26',
  origin: 'www.youtube.com',
  title: 'Search YouTube',
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  steps: [
    { ...base, id: 'yt_1', seq: 0, ts: Date.now(), type: 'navigate', value: 'https://www.youtube.com/', delayBefore: 0 },
    {
      // The poison step: a redirect the site performed, recorded as navigation.
      ...base,
      id: 'yt_2',
      seq: 1,
      ts: Date.now() + 400,
      type: 'navigate',
      url: 'https://accounts.youtube.com/RotateCookiesPage?origin=https://www.youtube.com&yt_pid=1',
      value: 'https://accounts.youtube.com/RotateCookiesPage?origin=https://www.youtube.com&yt_pid=1',
      delayBefore: 400,
    },
    {
      ...base,
      id: 'yt_3',
      seq: 2,
      ts: Date.now() + 3000,
      type: 'input',
      target: loc('input#search, input[name="search_query"]', 'input', 'Search'),
      value: 'fifa 26',
      meta: { kind: 'text', label: 'Search', options: [], required: false },
    },
    {
      ...base,
      id: 'yt_4',
      seq: 3,
      ts: Date.now() + 4000,
      type: 'click',
      target: loc('button#search-icon-legacy, button[aria-label="Search"]', 'button', 'Search'),
      value: 'Search',
      causedNavigation: true,
      meta: { kind: 'button', label: 'Search', options: [], required: false },
    },
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
    body: JSON.stringify({ trace, name: 'Search YouTube', description: 'Redirect regression test' }),
  }),
);
console.log('automation:', ing.automationId, ing.warning ? `\n  warning: ${ing.warning.slice(0, 120)}` : '');

const auto = await j(await fetch(`${RUNNER}/api/automations/${ing.automationId}`));
const key = auto.schema.fields.find((f) => ['text', 'combobox'].includes(f.kind))?.key ?? 'search';
console.log('field:', key);

const run = await j(
  await fetch(`${RUNNER}/api/automations/${ing.automationId}/run?wait=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: 'lofi hip hop radio' }),
  }),
);

console.log('status:', run.status);
console.log('finalUrl:', run.output?.finalUrl);
console.log('items:', run.output?.items?.length ?? 0);
(run.output?.items || []).slice(0, 5).forEach((i, n) => console.log(`  ${n + 1}. ${i.title.slice(0, 62)}`));
if (run.error) console.log('error:', run.error.code, '-', run.error.message);
console.log('events:');
(run.events || []).forEach((e) => console.log(`  [${e.phase}${e.level === 'debug' ? '/debug' : ''}] ${e.message}`));

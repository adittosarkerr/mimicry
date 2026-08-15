/**
 * Hard case: a combobox whose recorded selectors have all gone stale.
 *
 * Every structural candidate here is deliberately wrong (a class that never
 * existed, an id that doesn't). Only the semantic fallback — matching on the
 * control's accessible name and placeholder — can find the destination box.
 * This is the shape of the "Could not find input" failure on re-rendered sites.
 *
 *   node scripts/smoke-booking.mjs [site]
 */
const RUNNER = process.env.RUNNER_URL || 'http://localhost:8787';
const TOKEN = process.env.MIMIC_INGEST_TOKEN || 'dev-local-token-change-me';
const SITE = process.argv[2] || 'https://www.booking.com/';

const base = {
  url: SITE,
  delayBefore: 600,
  hints: {},
  meta: { kind: 'unknown', options: [], required: false },
};

const trace = {
  id: 'tr_bk1',
  version: 1,
  createdAt: Date.now(),
  startUrl: SITE,
  finalUrl: SITE,
  origin: new URL(SITE).hostname,
  title: 'Search stays',
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  steps: [
    { ...base, id: 'bk_1', seq: 0, ts: Date.now(), type: 'navigate', value: SITE, delayBefore: 0 },
    {
      ...base,
      id: 'bk_2',
      seq: 1,
      ts: Date.now() + 2000,
      type: 'select',
      // Every one of these is stale on purpose.
      target: {
        candidates: [
          { strategy: 'css', value: '.sb-destination__input-legacy-2019', unique: true, score: 95 },
          { strategy: 'id', value: '#ss_old_id', unique: true, score: 80 },
        ],
        frame: { framePath: [], shadowPath: [], frameUrl: SITE },
        snapshot: {
          tag: 'input',
          type: 'search',
          role: 'combobox',
          accessibleName: 'Enter destination',
          attributes: { name: 'ss', placeholder: 'Where are you going?' },
        },
      },
      value: 'Dhaka',
      meta: {
        kind: 'combobox',
        label: 'Destination',
        options: [],
        required: true,
        resolvedOptionText: 'Dhaka, Bangladesh',
      },
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
    body: JSON.stringify({ trace, name: 'Stale selector test', description: 'Semantic fallback regression' }),
  }),
);
console.log('automation:', ing.automationId);

const auto = await j(await fetch(`${RUNNER}/api/automations/${ing.automationId}`));
const key = auto.schema.fields.find((f) => f.kind === 'combobox')?.key ?? auto.schema.fields[0]?.key;
console.log('field:', key, '| kind:', auto.schema.fields[0]?.kind);

const run = await j(
  await fetch(`${RUNNER}/api/automations/${ing.automationId}/run?wait=1&pages=1`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ [key]: 'Kuala Lumpur' }),
  }),
);

console.log('status:', run.status);
if (run.error) console.log('error:', run.error.code, '-', run.error.message);
console.log('events:');
(run.events || []).forEach((e) => console.log(`  [${e.phase}${e.level === 'debug' ? '/dbg' : ''}] ${e.message}${e.detail ? `\n        ${e.detail.slice(0, 110)}` : ''}`));

/**
 * Reproduces the "picked from the list without typing" failure.
 *
 * The user clicks the destination box, the site shows trending destinations,
 * and the user clicks one. Recorded literally that is: click(input),
 * click(div "Bangkok") — and replaying it with a different destination hunts
 * for a div that no longer exists ("Could not find div Bangkok").
 *
 * Normalisation should fold the pair into one combobox step.
 *
 *   node scripts/smoke-dropdown-pick.mjs
 */
const RUNNER = process.env.RUNNER_URL || 'http://localhost:8787';
const TOKEN = process.env.MIMIC_INGEST_TOKEN || 'dev-local-token-change-me';
const SITE = 'https://www.booking.com/';

const base = { url: SITE, delayBefore: 600, hints: {}, meta: { kind: 'unknown', options: [], required: false } };

const trace = {
  id: 'tr_pick1',
  version: 1,
  createdAt: Date.now(),
  startUrl: SITE,
  finalUrl: SITE,
  origin: 'www.booking.com',
  title: 'Search stays',
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  steps: [
    { ...base, id: 'pk_1', seq: 0, ts: Date.now(), type: 'navigate', value: SITE, delayBefore: 0 },
    {
      ...base,
      id: 'pk_2',
      seq: 1,
      ts: Date.now() + 1500,
      type: 'click',
      target: {
        candidates: [{ strategy: 'css', value: 'input[name="ss"]', unique: true, score: 92 }],
        frame: { framePath: [], shadowPath: [], frameUrl: SITE },
        snapshot: {
          tag: 'input',
          type: 'search',
          role: 'combobox',
          accessibleName: 'Enter destination',
          attributes: { name: 'ss', placeholder: 'Where are you going?' },
        },
      },
      meta: { kind: 'combobox', label: 'Destination', options: [], required: true },
    },
    {
      // The literal trending-list entry. Unreplayable on its own.
      ...base,
      id: 'pk_3',
      seq: 2,
      ts: Date.now() + 3000,
      type: 'click',
      hints: { inDropdown: true },
      target: {
        candidates: [{ strategy: 'css', value: 'div[data-i="2"] > div > div', unique: true, score: 60 }],
        frame: { framePath: [], shadowPath: [], frameUrl: SITE },
        snapshot: { tag: 'div', accessibleName: 'Bangkok', text: 'Bangkok Thailand', attributes: {} },
      },
      value: 'Bangkok',
      meta: {
        kind: 'unknown',
        options: [
          { label: 'Dhaka', value: 'Dhaka', disabled: false },
          { label: 'Bangkok', value: 'Bangkok', disabled: false },
          { label: 'Kuala Lumpur', value: 'Kuala Lumpur', disabled: false },
        ],
        required: false,
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
    body: JSON.stringify({ trace, name: 'Pick-without-typing test', description: 'Normalisation regression' }),
  }),
);
console.log('automation:', ing.automationId);

const auto = await j(await fetch(`${RUNNER}/api/automations/${ing.automationId}`));
console.log(
  'fields:',
  auto.schema.fields.map((f) => `${f.key}(${f.kind}, ${f.exposure})="${f.defaultValue}" opts=${f.options.length}`).join(' | '),
);

const key = auto.schema.fields.find((f) => f.kind === 'combobox')?.key;
if (!key) {
  console.log('FAIL: no combobox field was produced — normalisation did not fold the pair');
  process.exit(1);
}

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
(run.events || []).forEach((e) => console.log(`  [${e.phase}] ${e.message}${e.detail ? `\n        ${e.detail.slice(0, 110)}` : ''}`));

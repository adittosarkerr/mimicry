import type { ControlKind, FormField, FormSchema, Trace } from '@mimic/schema';
import { launchSession, settle, waitOutChallenge } from '../replay/browser.js';
import { dismissConsent } from '../replay/engine.js';
import { waitForContent } from '../replay/extract.js';
import { slug } from './heuristics.js';

/**
 * Fields the recording never contained.
 *
 * A recording only knows what the person touched. Nobody opens the occupancy
 * panel to confirm "2 adults, 1 room" is already what they want — so the form
 * Mimic builds has no Adults field, and the first person to rerun it for a
 * family of five gets prices for a couple. The recorder cannot fix this: the
 * interaction genuinely never happened.
 *
 * The results page can. It is still sitting there holding the whole request,
 * and it will answer two questions honestly:
 *
 *   1. What controls does its own search form have? Every one of them is an
 *      input this task supports, touched or not.
 *   2. Does it accept a parameter we suspect it accepts? Ask for three adults
 *      and see whether the page comes back saying three adults.
 *
 * The second one matters most, because the sites that hide occupancy behind a
 * JavaScript panel are exactly the sites whose panel never opens for us.
 */

const MAX_PROBE_MS = 90_000;

/** A parameter worth asking about even though nothing in the recording used it. */
interface Probe {
  key: string;
  label: string;
  group: string;
  kind: ControlKind;
  /** Spellings to try, most likely first. */
  params: string[];
  /** A value distinguishable from any site default. */
  probeValue: string;
  /** Proof the page understood: this must appear after, and not before. */
  echo: (value: string) => RegExp;
  /** Reads the site's own default off the untouched page. */
  current: RegExp;
}

const PROBES: Probe[] = [
  {
    key: 'adults',
    label: 'Adults',
    group: 'Guests',
    kind: 'number',
    params: ['group_adults', 'adults', 'numAdults', 'adult'],
    probeValue: '3',
    echo: (v) => new RegExp(`\\b${v}\\s*adults?\\b`, 'i'),
    current: /\b(\d{1,2})\s*adults?\b/i,
  },
  {
    key: 'children',
    label: 'Children',
    group: 'Guests',
    kind: 'number',
    params: ['group_children', 'children', 'numChildren', 'child'],
    probeValue: '2',
    echo: (v) => new RegExp(`\\b${v}\\s*(?:children|kids)\\b`, 'i'),
    current: /\b(\d{1,2})\s*(?:children|kids)\b/i,
  },
  {
    key: 'rooms',
    label: 'Rooms',
    group: 'Guests',
    kind: 'number',
    params: ['no_rooms', 'rooms', 'numRooms', 'room'],
    probeValue: '2',
    echo: (v) => new RegExp(`\\b${v}\\s*rooms?\\b`, 'i'),
    current: /\b(\d{1,2})\s*rooms?\b/i,
  },
];

/** A control on the page's own search form that no recorded step touched. */
interface FormControl {
  name: string;
  tag: string;
  type?: string;
  label?: string;
  value?: string;
  options?: { label: string; value: string }[];
  hidden: boolean;
}

/** Names that carry a session, not a request. */
const NOISE =
  /^(csrf|_token|authenticity|utm_|sid|aid|label|ssne|ssne_untouched|src|dest_id|dest_type|_|__|nonce|state|redirect|referer|返回)/i;

/**
 * Reads the search form the results page ships with.
 *
 * Deliberately looks at `name` attributes rather than anything visual: a form
 * control with a name is, by definition, a parameter the site accepts, and it
 * keeps working when the page is server-rendered with no JavaScript at all —
 * which is how a great many sites arrive for an automated visitor.
 */
function readFormControls(): FormControl[] {
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  const labelOf = (el: Element): string => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;
    const id = el.getAttribute('id');
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const text = clean((lab as HTMLElement | null)?.innerText);
      if (text) return text;
    }
    const wrap = el.closest('label');
    const text = clean((wrap as HTMLElement | null)?.innerText);
    if (text && text.length < 60) return text;
    return clean((el as HTMLInputElement).placeholder ?? el.getAttribute('title'));
  };

  const forms = Array.from(document.querySelectorAll('form'));
  // The search form is the one whose controls the results came from — the
  // biggest form carrying a text-ish input.
  const scored = forms
    .map((f) => {
      const controls = Array.from(f.querySelectorAll('input,select,textarea'));
      const searchy = controls.some((c) => {
        const i = c as HTMLInputElement;
        return ['text', 'search'].includes(i.type) || c.tagName === 'SELECT';
      });
      return { form: f, count: controls.length, searchy };
    })
    .filter((s) => s.searchy && s.count)
    .sort((a, b) => b.count - a.count);

  const form = scored[0]?.form;
  if (!form) return [];

  const out: FormControl[] = [];
  for (const el of Array.from(form.querySelectorAll('input,select,textarea'))) {
    if (out.length >= 30) break;
    const i = el as HTMLInputElement;
    const name = i.name;
    if (!name) continue;
    const type = el.tagName === 'INPUT' ? i.type : undefined;
    if (type && ['submit', 'button', 'image', 'reset', 'password', 'file'].includes(type)) continue;

    const control: FormControl = {
      name,
      tag: el.tagName.toLowerCase(),
      type,
      label: labelOf(el) || undefined,
      value: i.value ? i.value.slice(0, 60) : undefined,
      hidden: type === 'hidden',
    };

    if (el.tagName === 'SELECT') {
      control.options = Array.from((el as unknown as HTMLSelectElement).options)
        .slice(0, 80)
        .map((o) => ({ label: clean(o.textContent), value: o.value }))
        .filter((o) => o.label);
    }

    out.push(control);
  }

  return out;
}

export interface HarvestResult {
  fields: FormField[];
  /** Extended template, when probing found parameters the site honours. */
  urlTemplate?: string;
  notes: string[];
}

const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Where the recorded run ended up, with the recorded values in place. */
function resultsUrl(schema: FormSchema, trace: Trace): string | undefined {
  const candidate = schema.urlTemplate
    ? schema.urlTemplate.replace(/\{([a-z0-9_]+)\}/gi, (whole, key: string) => {
        const field = schema.fields.find((f) => f.key === key);
        const value = field?.defaultValue;
        return value === undefined || value === null ? whole : encodeURIComponent(String(value));
      })
    : trace.finalUrl;

  if (!candidate || /\{[a-z0-9_]+\}/i.test(candidate)) return trace.finalUrl;
  return candidate;
}

function withParam(url: string, param: string, value: string): string {
  const u = new URL(url);
  u.searchParams.set(param, value);
  /* URL re-serialises every parameter, which percent-encodes the braces of any
     `{field}` placeholder already in the template — and an encoded placeholder
     is never substituted, so the destination silently becomes the literal text
     "%7Bdestination%7D". */
  return u.toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}');
}

/** How many times the page says this. */
function countOf(re: RegExp, text: string): number {
  return text.match(new RegExp(re.source, `${re.flags.replace('g', '')}g`))?.length ?? 0;
}

/**
 * Adds the inputs the results page knows about and the recording missed.
 *
 * Runs after the automation is already saved and usable, because it costs a
 * browser and up to a minute of page loads. Nothing here can break an existing
 * form: it only ever appends fields, and only ones the site proved it accepts.
 */
export async function harvestFields(schema: FormSchema, trace: Trace): Promise<HarvestResult> {
  const notes: string[] = [];
  const url = resultsUrl(schema, trace);
  if (!url || !/^https?:/i.test(url)) return { fields: [], notes: ['no results page to look at'] };

  /* Everything found here is delivered as a URL parameter, so without a
     template there is nowhere to put it. Adding the fields anyway would give
     the form boxes that quietly do nothing, which is worse than not having
     them: the run looks configured and isn't. */
  if (!schema.urlTemplate) {
    return { fields: [], notes: ['this automation replays step by step, so extra parameters have nowhere to go'] };
  }

  const taken = new Set(schema.fields.map((f) => f.key));
  const takenLabels = new Set(schema.fields.map((f) => normalize(f.label)));
  const alreadyInUrl = new Set<string>();
  try {
    for (const [k] of new URL(url).searchParams) alreadyInUrl.add(k.toLowerCase());
  } catch {
    /* not a URL we can read parameters from */
  }

  const session = await launchSession({ trace });
  const { page } = session;
  const fields: FormField[] = [];
  let template = schema.urlTemplate;
  const deadline = Date.now() + MAX_PROBE_MS;

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, 6000);
    await waitOutChallenge(page);
    await waitForContent(page, 15_000);
    await dismissConsent(page);

    const readText = () => page.evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? '');

    /* Everything below is a before/after comparison, so a half-loaded "before"
       is not a slow start — it is a wrong answer. A page that arrives nearly
       empty says nothing about adults or rooms, and every probe gets skipped
       for a site that supports all of them. */
    let baseText = await readText();
    if (baseText.length < 400) {
      await page.waitForTimeout(4000);
      baseText = await readText();
    }

    // ── the page's own form ────────────────────────────────────────────────
    const controls = await page.evaluate(readFormControls).catch(() => [] as FormControl[]);
    for (const control of controls) {
      if (fields.length >= 8) break;
      if (NOISE.test(control.name)) continue;
      // Hidden inputs are plumbing unless they carry something a person chose,
      // and we cannot tell which — the visible ones are the offer.
      if (control.hidden) continue;
      if (alreadyInUrl.has(control.name.toLowerCase())) continue;

      const label = control.label || control.name.replace(/[_-]+/g, ' ');
      if (takenLabels.has(normalize(label))) continue;

      const key = slug(label);
      if (taken.has(key)) continue;

      const kind: ControlKind =
        control.tag === 'select'
          ? 'select'
          : control.tag === 'textarea'
            ? 'textarea'
            : control.type === 'checkbox'
              ? 'checkbox'
              : control.type === 'number'
                ? 'number'
                : control.type === 'date'
                  ? 'date'
                  : 'text';

      // A select with one option is a label, not a choice.
      if (kind === 'select' && (control.options?.length ?? 0) < 2) continue;

      taken.add(key);
      takenLabels.add(normalize(label));
      fields.push({
        key,
        label: label.slice(0, 60),
        hint: 'Found on the site’s own search form.',
        kind,
        group: 'Advanced',
        order: 900 + fields.length,
        required: false,
        defaultValue: control.value ?? null,
        options: (control.options ?? []).map((o) => ({ ...o, disabled: false })),
        validation: {},
        bindsTo: [],
        exposure: 'advanced',
      });

      if (template) template = withParam(template, control.name, `{${key}}`);
      notes.push(`took “${label}” from the site’s search form`);
    }

    // ── parameters the site accepts but never showed us ────────────────────
    for (const probe of PROBES) {
      if (Date.now() > deadline) {
        notes.push('ran out of time before probing every parameter');
        break;
      }
      if (taken.has(probe.key) || takenLabels.has(normalize(probe.label))) continue;
      if (probe.params.some((p) => alreadyInUrl.has(p.toLowerCase()))) continue;

      // Only ask a site that talks about this at all. Probing a video site for
      // room counts is a wasted page load and a chance to be wrong.
      if (!probe.current.test(baseText)) {
        notes.push(`the page never mentions ${probe.label.toLowerCase()} — did not probe`);
        continue;
      }

      const before = baseText.match(probe.current)?.[1];
      // Pick a value the page is not already showing, so an echo means something.
      const value = before === probe.probeValue ? String(Number(probe.probeValue) + 1) : probe.probeValue;
      const wanted = probe.echo(value);
      /* "2 rooms" also appears in "only 2 rooms left at this price", so the
         phrase being present proves nothing on its own. One more of them than
         before does — the page gained a statement it wasn't making. */
      const baseCount = countOf(wanted, baseText);

      for (const param of probe.params.slice(0, 3)) {
        if (Date.now() > deadline) break;
        const probeUrl = withParam(url, param, value);
        const ok = await page
          .goto(probeUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 })
          .then(async () => {
            await settle(page, 4000);
            const text = await page.evaluate(() => document.body?.innerText?.slice(0, 20_000) ?? '');
            return countOf(wanted, text) > baseCount;
          })
          .catch(() => false);

        if (!ok) continue;

        taken.add(probe.key);
        takenLabels.add(normalize(probe.label));
        fields.push({
          key: probe.key,
          label: probe.label,
          hint: `The site accepts this as “${param}”, even though the recording never set it.`,
          kind: probe.kind,
          group: probe.group,
          order: 800 + fields.length,
          required: false,
          defaultValue: before ?? null,
          options: [],
          validation: { min: 0, max: 30 },
          bindsTo: [],
          exposure: 'variable',
        });

        if (template) template = withParam(template, param, `{${probe.key}}`);
        notes.push(`the site honours “${param}” — added ${probe.label}`);
        break;
      }
    }
  } catch (err) {
    notes.push(`stopped early: ${String(err).slice(0, 120)}`);
  } finally {
    await session.close();
  }

  return { fields, urlTemplate: template, notes };
}

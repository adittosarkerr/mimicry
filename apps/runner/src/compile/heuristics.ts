import type {
  ControlKind,
  FormField,
  FormSchema,
  OutputSpec,
  RecordedStep,
  Trace,
} from '@mimic/schema';
import { profileFor } from '../sites/profiles';

/**
 * Rule-based trace → form compiler.
 *
 * This runs first and always. The AI pass refines its output (better names,
 * smarter grouping, sharper output selectors) but never replaces it, so a
 * DeepSeek outage degrades quality instead of breaking the product.
 */

/** Kinds the user should be able to edit before a rerun. */
const EDITABLE: ControlKind[] = [
  'text',
  'textarea',
  'number',
  'email',
  'select',
  'combobox',
  'multiselect',
  'checkbox',
  'radio',
  'toggle',
  'date',
  'daterange',
  'time',
  'datetime',
  'slider',
  'file',
];

/** Things that are almost always site chrome rather than user intent. */
const CHROME_TEXT =
  /(accept|allow|agree|got it|okay|ok|dismiss|close|continue|cookie|consent|privacy|subscribe|newsletter|sign in with|later|skip)/i;

/** Fields that look like preferences rather than the core task. */
const ADVANCED_HINT =
  /(currency|language|locale|region|sort|order by|per page|theme|filter|advanced|nationality|residence)/i;

export const slug = (input: string, fallback = 'field') => {
  const s = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/^(\d)/, 'f$1')
    .slice(0, 40);
  return s || fallback;
};

/** Only capitalise at word starts — `\b\w` turns "I'm" into "I'M". */
const titleCase = (s: string) =>
  s
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/(^|\s)(\p{L})/gu, (_m, sep: string, ch: string) => sep + ch.toUpperCase());

const MONTHS_RE =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/i;

/**
 * Calendar cells, live counters and running totals make terrible field names.
 * "20", "Tuesday, September 8, 2026" and "713 properties" all describe this
 * run, not the input — a rerun with different values would contradict them.
 */
function isUnstableLabel(raw: string): boolean {
  const s = raw.trim();
  if (!s) return true;
  if (/^\d+$/.test(s)) return true; // a bare day number
  if (/^\d{1,2}[/-]\d{1,2}([/-]\d{2,4})?$/.test(s)) return true;
  if (MONTHS_RE.test(s) && /\d/.test(s)) return true; // "Thu, Aug 20"
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
  return false;
}

/**
 * Trims the volatile tail off an otherwise good label:
 * "Breakfast included: 713 properties" → "Breakfast included".
 */
function cleanLabel(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')
    .replace(/[:\-–—(]\s*\d[\d,.\s]*\s*(properties|results|options|items|reviews|hotels|flights|stays|deals)?\)?\s*$/i, '')
    .replace(/\s*[·|•]\s*$/, '')
    .replace(/\s*\*\s*$/, '')
    .trim();
}

/**
 * Is this heading a form section, or just the nearest sentence?
 *
 * The recorder reports whatever heading sits above a control, and on a busy
 * page that is marketing copy: "Popular for business travellers", "Search
 * properties". Grouping the form by those produces a section per field, each
 * titled with an advertisement. A real section name is short and reads like a
 * label, not like a sentence.
 */
function usableSection(raw: string): boolean {
  const s = raw.trim();
  if (!s || s.length > 28) return false;
  if (isUnstableLabel(s)) return false;
  if (s.split(/\s+/).length > 3) return false;
  // Copy, not a label: a call to action or a claim about the results.
  if (/\b(popular|recommended|best|top|explore|discover|browse|deals?|offers?|save|book now)\b/i.test(s)) {
    return false;
  }
  if (/[.!?]$/.test(s)) return false;
  return true;
}

/** Best human label available for a step's control. */
function labelFor(step: RecordedStep, index: number, typedValues: Set<string> = new Set()): string {
  const meta = step.meta as RecordedStep['meta'] & { openerLabel?: string };
  const snap = step.target?.snapshot;

  // For a calendar day, the only useful name is on the field that opened it.
  const candidates = [
    meta.openerLabel,
    meta.label,
    meta.placeholder,
    snap?.accessibleName,
    snap?.attributes?.name,
    snap?.attributes?.['aria-label'],
    snap?.attributes?.id,
  ];

  for (const raw of candidates) {
    if (!raw) continue;
    const cleaned = cleanLabel(raw);
    if (!cleaned || cleaned.length > 60) continue;
    if (isUnstableLabel(cleaned)) continue;
    /* Once a search box holds "Kuala Lumpur", every accessible name derived
       from it says "Kuala Lumpur" — including the one on the date picker it
       opens. A label that is really somebody's answer names the wrong thing
       and is wrong again on the next run. */
    if (typedValues.has(cleaned.toLowerCase())) continue;
    return titleCase(cleaned);
  }

  const section = meta.section && !isUnstableLabel(meta.section) ? meta.section : undefined;
  if (section) return `${titleCase(cleanLabel(section))} ${index + 1}`;
  return `${titleCase(meta.kind)} ${index + 1}`;
}

/** Does this step carry a value the user might want to change? */
function isVariable(step: RecordedStep): boolean {
  if (step.hints?.inConsent) return false;
  if (step.hints?.secret) return false;
  if (step.type === 'navigate' || step.type === 'scroll' || step.type === 'press') return false;
  if (step.type === 'extract') return false;
  if (!EDITABLE.includes(step.meta.kind)) return false;
  if (step.value === undefined || step.value === null || step.value === '') {
    // Checkboxes legitimately carry `false`.
    return typeof step.value === 'boolean';
  }
  const text = String(step.value);
  if (step.type === 'click' && CHROME_TEXT.test(text)) return false;
  return true;
}

/** Two steps hitting the same control shouldn't produce two fields. */
function identity(step: RecordedStep): string {
  const c = step.target?.candidates?.[0];
  return `${step.meta.kind}:${c?.strategy ?? 'none'}:${c?.value ?? step.id}:${c?.name ?? ''}`;
}

/**
 * Consecutive date fields on the same page are nearly always a range
 * (check-in / check-out, depart / return). Naming them as a pair makes the
 * generated form read the way the site does.
 */
function labelDatePair(fields: FormField[], category: string): void {
  const dates = fields.filter((f) => f.kind === 'date' || f.kind === 'datetime');
  if (dates.length < 2) return;

  const [a, b] = dates;
  const needsName = (f: FormField) => /^(date|datetime)( \d+)?$/i.test(f.label);

  if (needsName(a) || needsName(b)) {
    const [firstLabel, secondLabel] =
      category === 'hotels'
        ? ['Check-in', 'Check-out']
        : category === 'flights'
          ? ['Depart', 'Return']
          : ['Start date', 'End date'];

    if (needsName(a)) {
      a.label = firstLabel;
      a.key = slug(firstLabel);
    }
    if (needsName(b)) {
      b.label = secondLabel;
      b.key = slug(secondLabel);
    }
  }

  // The second date can never precede the first.
  b.validation = { ...b.validation, afterField: a.key };
}

/** Guess what the automation produces from where it ended up. */
function inferOutput(trace: Trace): OutputSpec {
  const marked = trace.steps.find((s) => s.type === 'extract');
  const finalUrl = trace.finalUrl || trace.startUrl;
  const url = finalUrl.toLowerCase();

  const layout: OutputSpec['layout'] =
    /(confirm|success|thank|receipt|booking|sent|complete)/.test(url) ? 'confirmation' : 'cards';

  /* A first guess only — the extractor overrides it from what was actually
     scraped. Left undefined rather than forced to 'generic' so that a run which
     scrapes nothing conclusive still falls back to something sensible. */
  const { category } = inferCategory(trace);
  const resultKind: OutputSpec['resultKind'] =
    category === 'hotels'
      ? 'stay'
      : category === 'shopping'
        ? 'product'
        : category === 'video'
          ? 'video'
          : category === 'research'
            ? 'article'
            : undefined;

  return {
    layout,
    resultKind,
    containerLocator: marked?.target?.candidates?.[0]?.value,
    itemLocator: undefined,
    itemLocatorPinned: false,
    fields: [],
    emptyStateHints: [
      'no results',
      'no results found',
      'nothing found',
      'we could not find',
      "couldn't find",
      'no flights',
      'no properties found',
      'no matches',
      '0 results',
    ],
    unavailableHints: [
      'sold out',
      'unavailable',
      'out of stock',
      'no longer available',
      'fully booked',
      'not available',
    ],
  };
}

/**
 * Turns the page the recording ended on into a reusable URL.
 *
 * Most search tasks are, underneath, one GET request: everything the person did
 * — clicking the box, typing, waiting for suggestions, pressing Enter — existed
 * only to produce `?search_query=claude`. When the recorded values are visible
 * in that URL they can be swapped for placeholders, and the next run can go
 * straight there. That skips every fragile part of a replay at once.
 *
 * Conservative on purpose: a value has to appear as a whole query parameter, so
 * a coincidental substring in a tracking id can't become a placeholder.
 */
export interface UrlTemplate {
  template: string;
  /** Inputs the URL declares that no recorded step produced a field for. */
  extraFields: FormField[];
  /**
   * Values the URL supplies for fields that exist but came back empty.
   *
   * A guest-count stepper produces a field with no value — the recording can
   * see the control but not what it ended up at. The URL knows: `group_adults=2`.
   */
  patches: { key: string; defaultValue: FormField['defaultValue'] }[];
}

export function inferUrlTemplate(trace: Trace, fields: FormField[]): UrlTemplate | undefined {
  const finalUrl = resultsUrlOf(trace);
  if (!finalUrl) return undefined;

  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return undefined;
  }

  // No query means nothing was carried in the URL — this was a real UI journey.
  if (!url.search || url.search.length < 2) return undefined;

  /* Session ids, cookie-rotation bounces and tracking parameters are not part
     of the task, and replaying a stale one can bounce the run somewhere else. */
  /* Two kinds of parameter have to go.
     Tracking and session junk, which is stale by the next run — and resolved
     identifiers, which are worse: `dest_id=-2403010` is Kuala Lumpur's id, and
     it silently overrules the `ss=` you just changed. Leaving it in makes an
     automation that searches the same city forever whatever you type. */
  const JUNK_PARAM =
    /^(sid|sessionid|session_id|aid|_ga|gclid|fbclid|utm_|yt_pid|origin|ref|referrer|sp_|pf_rd|dib|qid|sprefix|crid|s?token|csrf|label|efdco|src|dest_id|dest_type|place_id|geo_?id|city_?id|region_?id|entity_?id|search_pageview_id|sb_travel_purpose)$/i;
  for (const key of Array.from(url.searchParams.keys())) {
    if (JUNK_PARAM.test(key)) url.searchParams.delete(key);
  }

  let replaced = 0;
  for (const field of fields) {
    /* The recorded default is the usual source, but a trace whose typing step
       went missing has none — so fall back to whatever the step this field
       binds to actually carried. */
    const value = field.defaultValue ?? recordedValueOf(trace, field);
    if (typeof value !== 'string' && typeof value !== 'number') continue;
    const text = String(value).trim();
    if (text.length < 2) continue;

    for (const [key, param] of Array.from(url.searchParams.entries())) {
      // Whole-value match only, case-insensitively — "claude" is the query, not
      // a fragment of some other parameter that happens to contain it.
      if (param.trim().toLowerCase() !== text.toLowerCase()) continue;
      url.searchParams.set(key, `{${field.key}}`);
      replaced += 1;
      break;
    }
  }

  /* Whatever is left in the URL that nothing on the form accounts for.
   *
   * The results URL is the site telling you exactly what it takes: `ss`,
   * `checkin`, `checkout`, `group_adults`, `no_rooms`. A stepper the user
   * clicked leaves no readable value behind, so the compiler never produced a
   * field for it — and the form came back missing Adults, Children and Rooms
   * even though the recording plainly set all three. Reading them off the URL
   * gets them back, correctly typed, without anybody asking. */
  const claimed = new Set(fields.map((f) => f.key));
  const extraFields: FormField[] = [];
  const patches: UrlTemplate['patches'] = [];

  /** An existing field that means the same thing as this parameter. */
  const twinOf = (candidate: FormField) =>
    fields.find(
      (f) =>
        f.key === candidate.key ||
        f.label.toLowerCase().replace(/[^a-z]/g, '') ===
          candidate.label.toLowerCase().replace(/[^a-z]/g, ''),
    );

  for (const [key, raw] of Array.from(url.searchParams.entries())) {
    if (raw.startsWith('{')) continue; // already a placeholder
    const derived = fieldFromParam(key, raw, new Set());
    if (!derived) continue;

    /* The form usually already has a box for this — "Adults" exists, it just
       has nothing in it. Filling that one in is right; adding "Adults 2"
       beside it is how a form ends up with fifteen fields and two of
       everything. */
    const twin = twinOf(derived);
    if (twin) {
      url.searchParams.set(key, `{${twin.key}}`);
      if (twin.defaultValue === null || twin.defaultValue === undefined) {
        patches.push({ key: twin.key, defaultValue: derived.defaultValue });
      }
      replaced += 1;
      continue;
    }

    if (claimed.has(derived.key)) continue;
    url.searchParams.set(key, `{${derived.key}}`);
    claimed.add(derived.key);
    extraFields.push({ ...derived, order: fields.length + extraFields.length });
    replaced += 1;
  }

  if (!replaced) return undefined;

  return {
    // searchParams escapes the braces; the engine wants them readable.
    template: url.toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}'),
    extraFields,
    patches,
  };
}

/**
 * Well-known search parameters, named the way a person would.
 *
 * Sites converged on these decades ago, so a small table covers most of the
 * web. Anything not listed still becomes a field when its name reads like an
 * input rather than a tracking token — the table is for good labels, not for
 * deciding what counts.
 */
const KNOWN_PARAMS: Record<string, { label: string; kind: ControlKind; group?: string }> = {
  ss: { label: 'Destination', kind: 'text' },
  q: { label: 'Search', kind: 'text' },
  query: { label: 'Search', kind: 'text' },
  k: { label: 'Search', kind: 'text' },
  keyword: { label: 'Search', kind: 'text' },
  search: { label: 'Search', kind: 'text' },
  search_query: { label: 'Search', kind: 'text' },
  checkin: { label: 'Check-in', kind: 'date', group: 'Dates' },
  checkout: { label: 'Check-out', kind: 'date', group: 'Dates' },
  depart: { label: 'Departure date', kind: 'date', group: 'Dates' },
  departure: { label: 'Departure date', kind: 'date', group: 'Dates' },
  return: { label: 'Return date', kind: 'date', group: 'Dates' },
  group_adults: { label: 'Adults', kind: 'number', group: 'Guests' },
  adults: { label: 'Adults', kind: 'number', group: 'Guests' },
  group_children: { label: 'Children', kind: 'number', group: 'Guests' },
  children: { label: 'Children', kind: 'number', group: 'Guests' },
  no_rooms: { label: 'Rooms', kind: 'number', group: 'Guests' },
  rooms: { label: 'Rooms', kind: 'number', group: 'Guests' },
  infants: { label: 'Infants', kind: 'number', group: 'Guests' },
  currency: { label: 'Currency', kind: 'text' },
  lang: { label: 'Language', kind: 'text' },
  sort: { label: 'Sort by', kind: 'text' },
  page: { label: 'Page', kind: 'number' },
};

/** Parameters that describe the visitor or the session, never the request. */
const NOT_AN_INPUT =
  /^(label|aid|sid|sb_|efdco|src|dest_id|dest_type|nflt|lang_?click|soz|lp_|ss_all|ssne|ssne_untouched|highlighted|do_availability_check|from_sf|search_pageview_id|search_selected|search_sid|ac_|group_?id|sr_|req_|selected_currency|no_?ref|utm|gclid|fbclid|_ga|token|csrf|hl|gl|ei|ved|uact|oq|sclient|source|sca_|biw|bih|dpr)/i;

function fieldFromParam(
  key: string,
  value: string,
  claimed: Set<string>,
): FormField | undefined {
  if (NOT_AN_INPUT.test(key)) return undefined;
  if (!value.trim() || value.length > 80) return undefined;

  const known = KNOWN_PARAMS[key.toLowerCase()];
  // Unlisted parameters have to look like an input: a readable name, and a
  // value short enough to be something a person chose.
  if (!known && (key.length < 2 || key.length > 24 || !/^[a-z][a-z0-9_-]*$/i.test(key))) {
    return undefined;
  }
  if (!known && /^[0-9a-f]{16,}$/i.test(value)) return undefined; // an id, not a choice

  const fieldKey = slug(known?.label ?? key);
  if (claimed.has(fieldKey)) return undefined;

  const isDate = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const isNumber = /^\d{1,4}$/.test(value);
  const kind: ControlKind = known?.kind ?? (isDate ? 'date' : isNumber ? 'number' : 'text');

  return {
    key: fieldKey,
    label: known?.label ?? titleCase(key.replace(/_/g, ' ')),
    hint: undefined,
    kind,
    group: known?.group ?? (kind === 'date' ? 'Dates' : 'Details'),
    order: 0,
    required: false,
    defaultValue: kind === 'number' ? Number(value) : value,
    placeholder: undefined,
    options: [],
    dynamicOptions: undefined,
    validation: {},
    bindsTo: [],
    /* Currency, language and sort order matter but are rarely changed; the
       things the request is actually about stay in the main form. */
    exposure: ADVANCED_HINT.test(known?.label ?? key) ? 'advanced' : 'variable',
  };
}

/**
 * The page the recording really ended on.
 *
 * `trace.finalUrl` is whatever the tab happened to show when recording stopped,
 * and on plenty of sites that is a cookie-rotation or auth bounce rather than
 * the results — one YouTube recording ended on `accounts.youtube.com/
 * RotateCookiesPage`. Walking back through the steps for the last real page
 * finds what the person was actually looking at.
 */
function resultsUrlOf(trace: Trace): string | undefined {
  const BOUNCE = /(rotatecookies|consent|gdpr|accounts\.|auth|login|signin|challenge|captcha)/i;

  const candidates = [trace.finalUrl, ...trace.steps.map((s) => s.url ?? String(s.value ?? ''))]
    .filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u));

  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const url = candidates[i];
    if (BOUNCE.test(url)) continue;
    if (!url.includes('?')) continue; // no query means nothing to templatise
    return url;
  }
  return undefined;
}

/** What the recording put into the step this field drives. */
function recordedValueOf(trace: Trace, field: FormField): string | undefined {
  for (const id of field.bindsTo) {
    const step = trace.steps.find((s) => s.id === id);
    const value = step?.value;
    if (typeof value === 'string' && value.trim() && value !== 'Enter') return value.trim();
    if (step?.meta?.resolvedOptionText) return step.meta.resolvedOptionText;
  }
  return undefined;
}

/** Rough category so the dashboard can pick an icon. */
export function inferCategory(trace: Trace): { category: string; emoji: string } {
  const hay = `${trace.origin} ${trace.title ?? ''} ${trace.startUrl} ${trace.finalUrl ?? ''}`.toLowerCase();
  const table: [RegExp, string, string][] = [
    [/flight|air|fly|aviation|gozayaan|skyscanner|kayak/, 'flights', '✈️'],
    [/hotel|stay|room|booking\.com|agoda|airbnb/, 'hotels', '🏨'],
    [/mail|gmail|outlook|inbox/, 'email', '✉️'],
    [/youtube|video|vimeo/, 'video', '▶️'],
    [/wiki|scholar|arxiv|docs/, 'research', '📚'],
    [/shop|cart|store|amazon|daraz|checkout/, 'shopping', '🛒'],
    [/job|career|linkedin|hiring/, 'jobs', '💼'],
    [/bank|pay|invoice|finance/, 'finance', '💳'],
    [/search|google|bing/, 'search', '🔎'],
  ];
  for (const [re, category, emoji] of table) {
    if (re.test(hay)) return { category, emoji };
  }
  return { category: 'general', emoji: '⚡' };
}

/** Two labels naming the same thing, ignoring case and punctuation. */
function sameLabel(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(a) === norm(b);
}

export function compileHeuristically(trace: Trace): FormSchema {
  const fields: FormField[] = [];
  const seen = new Map<string, FormField>();
  const usedKeys = new Set<string>();

  /* Everything the person typed or picked during the recording. Used to stop
     a value being mistaken for a label — see labelFor. */
  const typedValues = new Set<string>();
  for (const step of trace.steps) {
    for (const candidate of [step.value, step.meta.resolvedOptionText]) {
      if (typeof candidate !== 'string') continue;
      const text = candidate.trim().toLowerCase();
      if (text.length >= 2 && text.length <= 60) typedValues.add(text);
    }
  }

  const uniqueKey = (base: string) => {
    let key = slug(base);
    let n = 2;
    while (usedKeys.has(key)) key = `${slug(base)}_${n++}`;
    usedKeys.add(key);
    return key;
  };

  trace.steps.forEach((step, i) => {
    if (!isVariable(step)) return;

    const id = identity(step);
    const existing = seen.get(id);
    if (existing) {
      // Same control touched twice — last value wins, both steps stay bound.
      existing.defaultValue = normalizeValue(step);
      existing.bindsTo.push(step.id);
      return;
    }

    const label = labelFor(step, i, typedValues);
    const kind = step.meta.kind;
    // A heading that names today's date is a group called "Thursday, August 20"
    // — meaningless the moment the automation is rerun.
    const rawSection = step.meta.section ? cleanLabel(step.meta.section) : '';
    const section = usableSection(rawSection) ? titleCase(rawSection) : undefined;

    const defaultValue = normalizeValue(step);

    const field: FormField = {
      key: uniqueKey(label),
      label,
      hint: step.meta.placeholder && step.meta.placeholder !== label ? step.meta.placeholder : undefined,
      kind,
      group: section || defaultGroup(kind),
      order: fields.length,
      /* Required only when the recording actually captured a value.
       *
       * A stepper the user clicked four times leaves no readable value behind,
       * and marking that field required produces a form that cannot be
       * submitted at all — "Missing required fields" with every visible box
       * filled in. If we don't know what to put there, the site's own default
       * is a better answer than blocking the run. */
      required: Boolean(step.meta.required) && defaultValue !== null && defaultValue !== undefined,
      defaultValue,
      placeholder: step.meta.placeholder,
      options: step.meta.options ?? [],
      dynamicOptions:
        kind === 'combobox' ? { searchStepId: step.id, matchMode: 'ai' as const } : undefined,
      validation: {
        min: step.meta.min,
        max: step.meta.max,
        pattern: step.meta.pattern,
      },
      bindsTo: [step.id],
      exposure: ADVANCED_HINT.test(`${label} ${section ?? ''}`) ? 'advanced' : 'variable',
    };

    seen.set(id, field);
    fields.push(field);
  });

  const { category } = inferCategory(trace);
  labelDatePair(fields, category);

  /* The results URL declares inputs the recording couldn't capture — guest
     counts clicked on a stepper, filters applied through a menu. Fold them in
     before the groups are worked out, so "Guests" and "Dates" appear as real
     sections rather than being dropped. */
  const urlTemplate = inferUrlTemplate(trace, fields);
  if (urlTemplate) {
    for (const patch of urlTemplate.patches) {
      const target = fields.find((f) => f.key === patch.key);
      if (target) target.defaultValue = patch.defaultValue;
    }
    fields.push(...urlTemplate.extraFields);
  }

  /* A site described properly beats anything read off one recording.
   *
   * These are the sites whose URL welds route and dates into one string, so
   * inference produces a form whose fields cannot reach the URL at all. The
   * recorded values still seed the profile's fields, so the automation opens
   * on the trip that was recorded — it is just editable now. */
  const profile = profileFor(trace.origin);
  const profileFields = profile
    ? profile.fields.map((f) => {
        const recorded = fields.find((r) => r.key === f.key || sameLabel(r.label, f.label));
        return recorded?.defaultValue != null && recorded.defaultValue !== ''
          ? { ...f, defaultValue: recorded.defaultValue }
          : { ...f };
      })
    : undefined;

  const finalFields = profileFields ?? fields;
  const groups = Array.from(new Set(finalFields.map((f) => f.group)));
  const durations = trace.steps.map((s) => s.delayBefore || 0).reduce((a, b) => a + b, 0);

  return {
    id: `fs_${trace.id.replace(/^tr_/, '')}`,
    traceId: trace.id,
    version: 1,
    name: profile?.name ?? trace.title ?? `Task on ${trace.origin}`,
    description: describeTrace(trace, finalFields),
    site: trace.origin,
    category: profile?.category ?? category,
    fields: finalFields,
    groups: groups.length ? groups : ['General'],
    // The profile builds its URL in code; there is no template to store.
    urlTemplate: profile ? undefined : urlTemplate?.template,
    output: profile?.output ?? inferOutput(trace),
    // Replay is faster than a human but pages still have to load.
    estimatedDurationMs: Math.max(8_000, Math.min(durations * 0.6 + trace.steps.length * 900, 240_000)),
    compiledBy: 'heuristics',
    compiledAt: Date.now(),
    heuristicOnly: true,
  };
}

function defaultGroup(kind: ControlKind): string {
  if (['date', 'daterange', 'time', 'datetime'].includes(kind)) return 'Dates';
  if (['checkbox', 'toggle', 'radio', 'slider'].includes(kind)) return 'Filters';
  if (['select', 'multiselect'].includes(kind)) return 'Options';
  return 'Details';
}

function normalizeValue(step: RecordedStep): FormField['defaultValue'] {
  const v = step.value;
  if (v === undefined) return null;
  if (typeof v === 'boolean' || typeof v === 'number') return v;
  if (Array.isArray(v)) return v.map(String);
  // A combobox's true value is what the site resolved it to, not what was typed.
  if (step.meta.kind === 'combobox' && step.meta.resolvedOptionText) {
    return step.meta.resolvedOptionText;
  }
  if (step.hints?.isoDate) return step.hints.isoDate;

  /* A date field can only hold a date.
   *
   * Clicking a calendar cell whose markup carries no ISO value leaves the cell
   * text — "21" — and putting that in a date input produces a control the
   * browser shows as empty and refuses to submit. Better to hand back an empty
   * date the user can fill than a value that silently blocks the form. */
  if (['date', 'datetime', 'daterange'].includes(step.meta.kind)) {
    const text = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text;
    const parsed = Date.parse(text);
    if (!Number.isNaN(parsed) && /\d{4}/.test(text)) {
      return new Date(parsed).toISOString().slice(0, 10);
    }
    return null;
  }

  return String(v);
}

function describeTrace(trace: Trace, fields: FormField[]): string {
  const acts = trace.steps.filter((s) => s.type === 'click').length;
  const inputs = fields.length;
  const site = trace.origin.replace(/^www\./, '');
  return `Replays a ${trace.steps.length}-step task on ${site} — ${inputs} editable field${
    inputs === 1 ? '' : 's'
  }, ${acts} interaction${acts === 1 ? '' : 's'}.`;
}

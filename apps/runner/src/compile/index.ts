import type { FormField, FormSchema, RecordedStep, Trace } from '@mimic/schema';
import { chatJson, DeepSeekError } from '../deepseek.js';
import { config } from '../config.js';
import { compileHeuristically, inferCategory, slug } from './heuristics.js';
import { condenseHtml, guessResultContainers } from './dom.js';

/**
 * Trace → FormSchema.
 *
 * Heuristics run first and produce a schema that always works. DeepSeek then
 * gets the same trace plus the final page and returns a refined schema —
 * better field names, sane grouping, which fields are really variables, and
 * concrete selectors for scraping the results. The two are merged, with the
 * heuristic result winning on anything the model contradicts structurally
 * (step ids, option lists, recorded defaults).
 */

interface AiField {
  step_ids?: string[];
  key?: string;
  label?: string;
  hint?: string;
  kind?: string;
  group?: string;
  order?: number;
  required?: boolean;
  exposure?: 'variable' | 'constant' | 'advanced';
  options?: { label: string; value: string }[];
  validation?: Record<string, unknown>;
}

interface AiSchema {
  name?: string;
  description?: string;
  category?: string;
  fields?: AiField[];
  output?: {
    layout?: string;
    result_kind?: string;
    container_locator?: string;
    item_locator?: string;
    fields?: { key: string; label: string; selector?: string; attribute?: string; type?: string }[];
    empty_state_hints?: string[];
    unavailable_hints?: string[];
  };
}

const VALID_KINDS = new Set([
  'text', 'textarea', 'number', 'password', 'email', 'select', 'combobox', 'multiselect',
  'checkbox', 'radio', 'toggle', 'date', 'daterange', 'time', 'datetime', 'slider', 'file',
  'button', 'link', 'unknown',
]);

const VALID_LAYOUTS = new Set(['list', 'cards', 'table', 'detail', 'confirmation', 'raw']);

const VALID_RESULT_KINDS = new Set([
  'video', 'stay', 'product', 'article', 'discussion', 'repo', 'place', 'generic',
]);

/** Compact one step into the few lines the model actually needs. */
function summarizeStep(step: RecordedStep) {
  const snap = step.target?.snapshot;
  return {
    id: step.id,
    type: step.type,
    kind: step.meta.kind,
    label: step.meta.label,
    section: step.meta.section,
    placeholder: step.meta.placeholder,
    value: typeof step.value === 'string' ? step.value.slice(0, 120) : step.value,
    resolved: step.meta.resolvedOptionText,
    options: step.meta.options?.slice(0, 12).map((o) => o.label),
    optionCount: step.meta.options?.length,
    tag: snap?.tag,
    role: snap?.role,
    name: snap?.accessibleName?.slice(0, 80),
    text: snap?.text?.slice(0, 80),
    testid:
      snap?.attributes?.['data-testid'] ??
      snap?.attributes?.['data-test'] ??
      snap?.attributes?.name ??
      snap?.attributes?.id,
    hints: step.hints,
    url: step.url,
  };
}

const SYSTEM_PROMPT = `You are Mimic's automation compiler.

You are given a recording of a real person completing one task in a browser, plus the HTML of the page they ended on. Your job is to turn that recording into a reusable form: the inputs a user must supply to run the same task again with different values, and instructions for scraping the result.

Rules:
1. A field is a VARIABLE only if a user would plausibly change it on a rerun — destination, dates, passenger counts, search queries, recipients, quantities.
2. Site chrome is a CONSTANT: cookie banners, "Search" buttons, opening a dropdown, dismissing a modal, navigation clicks. Do not expose these as fields.
3. Preferences that matter but are rarely changed are ADVANCED: currency, language, sort order, cabin class, filters, results-per-page.
4. Preserve the real widget type. A native <select> is "select". A typeahead that queries the site is "combobox". A calendar day click is "date". A pill toggle is "toggle". Never downgrade a rich widget to plain text.
5. Two date fields in sequence are almost always a range — name them accordingly and mark the second as after the first.
6. Every field must reference at least one step id from the recording in step_ids. Never invent step ids.
7. Keys are snake_case, short, and descriptive: destination, check_in, adults, cabin_class.
8. For output, give CSS selectors that match the RESULT ITEMS on the final page — one selector matching many sibling elements — plus selectors for the useful fields inside each item (title, price, url, image, rating, duration).
9. Include phrases this specific site uses for "no results" and "unavailable/sold out" so a run can report an honest empty state.
10. Say what the results ARE in result_kind — videos, places to stay, products, articles, discussion threads, code repositories, places. Mimic lays each kind out differently, so this decides whether the user sees thumbnails and durations or prices and ratings. Use "generic" only when the recording genuinely doesn't say.

Respond with a single JSON object, no prose, matching:
{
  "name": string,
  "description": string,
  "category": string,
  "fields": [{ "step_ids": string[], "key": string, "label": string, "hint": string, "kind": string, "group": string, "order": number, "required": boolean, "exposure": "variable"|"constant"|"advanced", "options": [{"label":string,"value":string}], "validation": {} }],
  "output": {
    "layout": "list"|"cards"|"table"|"detail"|"confirmation"|"raw",
    "result_kind": "video"|"stay"|"product"|"article"|"discussion"|"repo"|"place"|"generic",
    "container_locator": string,
    "item_locator": string,
    "fields": [{"key":string,"label":string,"selector":string,"attribute":string,"type":string}],
    "empty_state_hints": string[],
    "unavailable_hints": string[]
  }
}`;

function buildUserPrompt(trace: Trace, baseline: FormSchema): string {
  const steps = trace.steps
    .filter((s) => s.type !== 'scroll')
    .slice(0, 140)
    .map(summarizeStep);

  const finalHtml = condenseHtml(trace.finalDom ?? '', 16_000);
  const repeated = guessResultContainers(trace.finalDom ?? '');

  return JSON.stringify(
    {
      task: {
        site: trace.origin,
        title: trace.title,
        start_url: trace.startUrl,
        final_url: trace.finalUrl,
        locale: trace.locale,
        recorded_at: new Date(trace.createdAt).toISOString(),
      },
      steps,
      network_endpoints: trace.requests
        .filter((r) => /json|api|search|graphql/i.test(r.url))
        .slice(0, 15)
        .map((r) => `${r.method} ${r.url.slice(0, 160)}`),
      heuristic_draft: {
        fields: baseline.fields.map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind,
          binds_to: f.bindsTo,
          default: f.defaultValue,
        })),
      },
      repeated_class_signatures_on_final_page: repeated,
      final_page_html: finalHtml,
    },
    null,
    0,
  );
}

/** Merge the model's schema onto the heuristic baseline. */
function merge(baseline: FormSchema, ai: AiSchema, trace: Trace): FormSchema {
  const validStepIds = new Set(trace.steps.map((s) => s.id));
  const usedKeys = new Set<string>();
  const claimedSteps = new Set<string>();
  const fields: FormField[] = [];

  const uniqueKey = (base: string) => {
    let key = slug(base);
    let n = 2;
    while (usedKeys.has(key)) key = `${slug(base)}_${n++}`;
    usedKeys.add(key);
    return key;
  };

  for (const raw of ai.fields ?? []) {
    const bindsTo = (raw.step_ids ?? []).filter((id) => validStepIds.has(id));
    if (!bindsTo.length) continue; // hallucinated binding — drop it
    if (raw.exposure === 'constant') {
      bindsTo.forEach((id) => claimedSteps.add(id));
      continue; // constants are replayed as recorded, not shown in the form
    }

    // Anything the heuristics already worked out about these steps.
    const twin = baseline.fields.find((f) => f.bindsTo.some((id) => bindsTo.includes(id)));
    const kind = VALID_KINDS.has(raw.kind ?? '') ? (raw.kind as FormField['kind']) : twin?.kind ?? 'text';

    const field: FormField = {
      key: uniqueKey(raw.key || raw.label || twin?.key || 'field'),
      label: raw.label || twin?.label || 'Field',
      hint: raw.hint || twin?.hint,
      kind,
      group: raw.group || twin?.group || 'Details',
      order: typeof raw.order === 'number' ? raw.order : fields.length,
      /* Required only when the recording left something to prefill with.
       *
       * The model happily marks "Adults", "Rooms" and "Check-in" required
       * because the site does — but a stepper clicked four times leaves no
       * readable value, so the form arrives with a required field nothing can
       * fill and refuses to submit with every visible box completed. The site's
       * own default is a better outcome than a form that cannot be run. */
      required: (raw.required ?? twin?.required ?? false) && twin?.defaultValue != null,
      // Recorded values and option lists come from the page, never the model.
      defaultValue: twin?.defaultValue ?? null,
      placeholder: twin?.placeholder,
      options: twin?.options?.length ? twin.options : normalizeOptions(raw.options),
      dynamicOptions: twin?.dynamicOptions ?? (kind === 'combobox' ? { searchStepId: bindsTo[0], matchMode: 'ai' } : undefined),
      validation: { ...(twin?.validation ?? {}), ...sanitizeValidation(raw.validation) },
      bindsTo,
      exposure: raw.exposure === 'advanced' ? 'advanced' : 'variable',
      showWhen: undefined,
    };

    bindsTo.forEach((id) => claimedSteps.add(id));
    fields.push(field);
  }

  /* Anything the heuristics found but the model never mentioned stays, tucked
     into Advanced. Losing a real input silently is worse than one extra field.

     Except when it is the same input twice. Fields read off the results URL
     bind to no step, so the "did the model claim it" test never excludes them,
     and a form ends up with Adults and "Adults 2" side by side — one holding
     the value, one empty. Same name means same field: keep one, and let the
     URL's value fill the box the model left blank. */
  // Doubled letters collapse so "Travelling" and "Traveling" are one field.
  const sameThing = (a: string, b: string) => {
    const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(.)\1+/g, '$1');
    return norm(a) === norm(b);
  };

  for (const f of baseline.fields) {
    if (f.bindsTo.some((id) => claimedSteps.has(id))) continue;

    const twin = fields.find((existing) => sameThing(existing.label, f.label));
    if (twin) {
      if (twin.defaultValue === null || twin.defaultValue === undefined) {
        twin.defaultValue = f.defaultValue;
      }
      continue;
    }

    fields.push({ ...f, key: uniqueKey(f.key), exposure: 'advanced', order: fields.length });
  }

  fields.sort((a, b) => a.order - b.order);
  fields.forEach((f, i) => {
    f.order = i;
  });

  const layout = VALID_LAYOUTS.has(ai.output?.layout ?? '')
    ? (ai.output!.layout as FormSchema['output']['layout'])
    : baseline.output.layout;

  return {
    ...baseline,
    name: ai.name?.trim() || baseline.name,
    description: ai.description?.trim() || baseline.description,
    category: ai.category?.trim() || baseline.category,
    fields,
    groups: Array.from(new Set(fields.map((f) => f.group))),
    output: {
      layout,
      resultKind: VALID_RESULT_KINDS.has(ai.output?.result_kind ?? '')
        ? (ai.output!.result_kind as FormSchema['output']['resultKind'])
        : baseline.output.resultKind,
      containerLocator: ai.output?.container_locator || baseline.output.containerLocator,
      itemLocator: ai.output?.item_locator || baseline.output.itemLocator,
      itemLocatorPinned: baseline.output.itemLocatorPinned,
      fields: (ai.output?.fields ?? []).slice(0, 20).map((f) => ({
        key: slug(f.key || f.label || 'value'),
        label: f.label || f.key || 'Value',
        selector: f.selector,
        attribute: f.attribute,
        type: (['text', 'number', 'price', 'url', 'image', 'date', 'duration', 'rating'].includes(
          f.type ?? '',
        )
          ? f.type
          : 'text') as 'text',
      })),
      emptyStateHints: dedupeStrings([
        ...(ai.output?.empty_state_hints ?? []),
        ...baseline.output.emptyStateHints,
      ]),
      unavailableHints: dedupeStrings([
        ...(ai.output?.unavailable_hints ?? []),
        ...baseline.output.unavailableHints,
      ]),
    },
    compiledBy: config.deepseek.model,
    compiledAt: Date.now(),
    heuristicOnly: false,
  };
}

function normalizeOptions(options: AiField['options']): FormField['options'] {
  return (options ?? [])
    .filter((o) => o && typeof o.label === 'string')
    .slice(0, 200)
    .map((o) => ({ label: o.label, value: String(o.value ?? o.label), disabled: false }));
}

function sanitizeValidation(v: Record<string, unknown> | undefined): FormField['validation'] {
  if (!v || typeof v !== 'object') return {};
  const allowed = ['min', 'max', 'minLength', 'maxLength', 'pattern', 'notBefore', 'notAfter', 'afterField'];
  const out: Record<string, unknown> = {};
  for (const k of allowed) if (v[k] !== undefined && v[k] !== null) out[k] = v[k];
  return out as FormField['validation'];
}

const dedupeStrings = (arr: string[]) =>
  Array.from(new Set(arr.map((s) => String(s).toLowerCase().trim()).filter(Boolean))).slice(0, 30);

export interface CompileResult {
  schema: FormSchema;
  emoji: string;
  /** Populated when the AI pass failed — surfaced in the UI, not swallowed. */
  warning?: string;
}

/**
 * The rule-based form, immediately.
 *
 * No network, so it returns in milliseconds. Ingest answers the extension with
 * this and refines afterwards: the AI pass can take a minute against a large
 * page, and a browser extension holding a request open that long gets its
 * service worker evicted mid-flight — which looked, from the popup, like the
 * recording had hung forever.
 */
export function compileBaseline(trace: Trace): CompileResult {
  const baseline = compileHeuristically(trace);
  const { emoji } = inferCategory(trace);
  return {
    schema: baseline,
    emoji,
    warning: config.deepseek.enabled
      ? undefined
      : 'DEEPSEEK_API_KEY is not set — built the form from rules only. Field names may be rough.',
  };
}

export async function compileTrace(trace: Trace): Promise<CompileResult> {
  const { schema: baseline, emoji, warning } = compileBaseline(trace);

  if (!config.deepseek.enabled) return { schema: baseline, emoji, warning };

  try {
    const ai = await chatJson<AiSchema>(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildUserPrompt(trace, baseline) },
      ],
      { temperature: 0.15, maxTokens: 8000, timeoutMs: 120_000 },
    );
    const merged = merge(baseline, ai, trace);
    // A model that returns nothing usable is worse than the baseline.
    if (!merged.fields.length && baseline.fields.length) {
      return { schema: baseline, emoji, warning: 'The AI pass returned no usable fields — using the rule-based form.' };
    }
    return { schema: merged, emoji };
  } catch (err) {
    const message = err instanceof DeepSeekError ? err.message : String(err);
    return {
      schema: baseline,
      emoji,
      warning: `AI refinement failed, so this form was built from rules only. ${message.slice(0, 200)}`,
    };
  }
}

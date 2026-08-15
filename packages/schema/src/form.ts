import { z } from 'zod';
import { ControlKind, SelectOption } from './trace';
import { ResultKind } from './run';

/**
 * A field in the generated form. One field can drive several recorded steps —
 * a "Passengers" stepper the user clicked four times collapses into a single
 * number input bound to those four click steps.
 */
export const FormField = z.object({
  /** Stable key used in the REST payload: `destination`, `check_in`, `currency`. */
  key: z.string().regex(/^[a-z][a-z0-9_]*$/, 'snake_case key'),
  label: z.string(),
  /** One-line help text shown under the field. */
  hint: z.string().optional(),
  kind: ControlKind,
  /** Grouping in the UI — "Trip", "Passengers", "Filters", "Preferences". */
  group: z.string().default('General'),
  order: z.number().int().default(0),

  required: z.boolean().default(false),
  /** Value captured during recording; pre-fills the form. */
  defaultValue: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])
    .optional(),
  placeholder: z.string().optional(),

  /** For select / multiselect / radio / toggle groups. */
  options: z.array(SelectOption).default([]),
  /**
   * Combobox fields whose options are fetched live from the site during replay
   * (airport lookups). The runner types the query and picks the best match.
   */
  dynamicOptions: z
    .object({
      /** Step that opens/searches the combobox. */
      searchStepId: z.string(),
      matchMode: z.enum(['exact', 'contains', 'first', 'ai']).default('ai'),
    })
    .optional(),

  validation: z
    .object({
      min: z.union([z.string(), z.number()]).optional(),
      max: z.union([z.string(), z.number()]).optional(),
      minLength: z.number().optional(),
      maxLength: z.number().optional(),
      pattern: z.string().optional(),
      /** For dates: "today", "today+1", or an ISO date. */
      notBefore: z.string().optional(),
      notAfter: z.string().optional(),
      /** Key of another field this one must come after (check-out > check-in). */
      afterField: z.string().optional(),
    })
    .default({}),

  /** Recorded steps whose value this field substitutes into. */
  bindsTo: z.array(z.string()).default([]),
  /**
   * `variable` — user can edit (destination, dates).
   * `constant` — baked into replay, hidden from the form (cookie banner click).
   * `advanced` — editable but tucked behind "Advanced" (currency, language, sort).
   */
  exposure: z.enum(['variable', 'constant', 'advanced']).default('variable'),
  /** Only show this field when another field has a given value. */
  showWhen: z
    .object({ field: z.string(), equals: z.union([z.string(), z.boolean(), z.number()]) })
    .optional(),
});
export type FormField = z.infer<typeof FormField>;

/** What the automation is expected to produce, so the UI can render it natively. */
export const OutputSpec = z.object({
  /** How results render in Mimic's own theme. */
  layout: z.enum(['list', 'cards', 'table', 'detail', 'confirmation', 'raw']).default('cards'),
  /**
   * What the results are — videos, places to stay, products, articles.
   *
   * The compiler declares it when the recording makes it obvious; the extractor
   * infers it from the scraped fields otherwise, and the inference wins when it
   * disagrees with a guess made before anything was actually scraped.
   */
  resultKind: ResultKind.optional(),
  /** Locator of the container holding results on the final page. */
  containerLocator: z.string().optional(),
  /** Locator for a single result within the container. */
  itemLocator: z.string().optional(),
  /**
   * True when a person chose this block from the picker.
   *
   * A compiled locator is a guess made from one recording and competes with
   * what the extractor finds on the live page; a picked one does not. Somebody
   * looked at the choices and said "that list", and no heuristic gets to
   * second-guess it on the next run.
   */
  itemLocatorPinned: z.boolean().default(false),
  /** Named fields to pull out of each result item. */
  fields: z
    .array(
      z.object({
        key: z.string(),
        label: z.string(),
        selector: z.string().optional(),
        attribute: z.string().optional(), // 'text' | 'href' | 'src' | any attr
        type: z.enum(['text', 'number', 'price', 'url', 'image', 'date', 'duration', 'rating']).default('text'),
      }),
    )
    .default([]),
  /**
   * Phrases that mean "nothing found" or "unavailable" on this site, so the run
   * reports an honest empty/unavailable state instead of a silent success.
   */
  emptyStateHints: z.array(z.string()).default([]),
  unavailableHints: z.array(z.string()).default([]),
});
export type OutputSpec = z.infer<typeof OutputSpec>;

export const FormSchema = z.object({
  id: z.string(),
  traceId: z.string(),
  version: z.literal(1).default(1),
  /** "Search flights on GoZayaan" */
  name: z.string(),
  description: z.string(),
  site: z.string(), // hostname
  favicon: z.string().optional(),
  /** Icon hint for the dashboard card: 'flight' | 'hotel' | 'mail' | 'search' … */
  category: z.string().default('general'),
  fields: z.array(FormField),
  groups: z.array(z.string()).default(['General']),
  /**
   * The results URL with the recorded values swapped for `{field_key}`.
   *
   * When a recording ends on a URL that carries what the user typed —
   * `?search_query=claude`, `?ss=Kuala+Lumpur` — the whole interaction was just
   * a way of building that URL. Going straight there is dramatically more
   * reliable than reproducing the typing: no dropdown to race, no submit to
   * miss, no half-rendered single-page app. The step-by-step replay stays as
   * the fallback for anything the template cannot express.
   */
  urlTemplate: z.string().optional(),
  output: OutputSpec,
  /** Rough seconds the recorded run took — drives the progress bar estimate. */
  estimatedDurationMs: z.number().default(30_000),
  /** Model + prompt version that produced this schema, for reproducibility. */
  compiledBy: z.string().default('deepseek-chat'),
  compiledAt: z.number(),
  /** Set when the AI compiler was unavailable and we fell back to heuristics. */
  heuristicOnly: z.boolean().default(false),
});
export type FormSchema = z.infer<typeof FormSchema>;

/** User-supplied values keyed by FormField.key. */
export const FormValues = z.record(
  z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]),
);
export type FormValues = z.infer<typeof FormValues>;

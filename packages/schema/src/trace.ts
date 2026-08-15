import { z } from 'zod';
import { ElementLocator } from './locator';

/**
 * What kind of control the user actually touched. The recorder infers this from
 * tag/role/ARIA so the generated form can render the *same* widget — a native
 * <select> becomes a dropdown, a react date picker becomes a calendar, and a
 * pill filter becomes a toggle group.
 */
export const ControlKind = z.enum([
  'text',
  'textarea',
  'number',
  'password',
  'email',
  'select', // native <select>
  'combobox', // typeahead / autocomplete (airport pickers, city search)
  'multiselect',
  'checkbox',
  'radio',
  'toggle',
  'date',
  'daterange',
  'time',
  'datetime',
  'slider', // range inputs, price filters
  'file',
  'button',
  'link',
  'unknown',
]);
export type ControlKind = z.infer<typeof ControlKind>;

export const SelectOption = z.object({
  label: z.string(),
  value: z.string(),
  disabled: z.boolean().default(false),
  group: z.string().optional(),
});
export type SelectOption = z.infer<typeof SelectOption>;

/** Everything the recorder knows about the control beyond how to find it. */
export const ControlMeta = z.object({
  kind: ControlKind.default('unknown'),
  /** Human label — from <label>, aria-label, placeholder, or nearest heading. */
  label: z.string().optional(),
  placeholder: z.string().optional(),
  /** Options captured for selects, radio groups, and open comboboxes. */
  options: z.array(SelectOption).default([]),
  min: z.union([z.string(), z.number()]).optional(),
  max: z.union([z.string(), z.number()]).optional(),
  step: z.union([z.string(), z.number()]).optional(),
  pattern: z.string().optional(),
  required: z.boolean().default(false),
  /**
   * For comboboxes: the dropdown item the user finally picked, which is often
   * different from what they typed ("dha" → "Dhaka, Bangladesh (DAC)").
   */
  resolvedOptionText: z.string().optional(),
  /** Section heading the control sits under — "Filters", "Passengers", etc. */
  section: z.string().optional(),
});
export type ControlMeta = z.infer<typeof ControlMeta>;

export const StepType = z.enum([
  'navigate',
  'click',
  'dblclick',
  'input', // typed text
  'select', // chose a <select> option
  'check', // checkbox / radio / toggle set
  /**
   * Set a counter — "3 adults" — to an exact number.
   *
   * The whole +/− widget is one step. Recording the individual clicks loses the
   * meaning: four anonymous clicks on a "+" cannot be replayed against a site
   * whose default has since changed, and cannot be turned into a form field.
   */
  'stepper',
  'press', // key press (Enter, Escape, Tab)
  'hover',
  'scroll',
  'upload',
  'dragdrop',
  'waitFor', // explicit or inferred settle point
  'extract', // marks the results region the user cared about
]);
export type StepType = z.infer<typeof StepType>;

export const RecordedStep = z.object({
  id: z.string(),
  seq: z.number().int(),
  ts: z.number(), // epoch ms
  type: StepType,
  /** Page URL when the step happened. */
  url: z.string(),
  title: z.string().optional(),
  target: ElementLocator.optional(), // absent for navigate
  /**
   * Second element involved in a compound interaction: the dropdown option a
   * combobox search resolved to, or the day cell clicked inside a calendar.
   */
  secondaryTarget: ElementLocator.optional(),
  meta: ControlMeta.default({ kind: 'unknown', options: [], required: false }),
  /** Typed text, chosen option value, checkbox state, key name, scroll offset… */
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional(),
  /** ms the user spent before this step — replay uses it to pace human-ish. */
  delayBefore: z.number().default(0),
  /** True when the click caused a navigation or a large DOM swap. */
  causedNavigation: z.boolean().default(false),
  /** Screenshot key stored by the runner, if captured. */
  screenshot: z.string().optional(),
  /** Recorder notes: "opened dropdown", "dismissed cookie banner". */
  note: z.string().optional(),
  /** Recorder classification hints the compiler uses to decide exposure. */
  hints: z
    .object({
      inDropdown: z.boolean().optional(),
      inCalendar: z.boolean().optional(),
      inConsent: z.boolean().optional(),
      secret: z.boolean().optional(),
      /** ISO date parsed off a calendar cell, when one was derivable. */
      isoDate: z.string().optional(),
      /**
       * This navigation was the site redirecting, not the user choosing.
       * Replay must not visit these URLs directly.
       */
      redirect: z.boolean().optional(),
      /**
       * Ids of steps folded into this one during normalisation. Form fields
       * compiled against the original ids still resolve through these.
       */
      mergedFrom: z.array(z.string()).optional(),
    })
    .default({}),
});
export type RecordedStep = z.infer<typeof RecordedStep>;

/** Network calls seen during recording — hints at a faster API-level replay. */
export const ObservedRequest = z.object({
  method: z.string(),
  url: z.string(),
  resourceType: z.string().optional(),
  status: z.number().optional(),
  /** Truncated bodies, secrets stripped. */
  requestBody: z.string().optional(),
  responseSample: z.string().optional(),
});
export type ObservedRequest = z.infer<typeof ObservedRequest>;

export const Trace = z.object({
  id: z.string(),
  version: z.literal(1).default(1),
  createdAt: z.number(),
  /** Where the recording started. */
  startUrl: z.string(),
  finalUrl: z.string().optional(),
  origin: z.string(),
  /** Best-effort human title: "Search flights on gozayaan.com". */
  title: z.string().optional(),
  viewport: z.object({ width: z.number(), height: z.number() }).default({
    width: 1440,
    height: 900,
  }),
  userAgent: z.string().optional(),
  locale: z.string().optional(),
  timezone: z.string().optional(),
  steps: z.array(RecordedStep),
  requests: z.array(ObservedRequest).default([]),
  /** Raw HTML of the final page — the output scraper and AI compiler both use it. */
  finalDom: z.string().optional(),
  /** DOM of the page at the moment the user hit Stop, per frame. */
  domSnapshots: z
    .array(z.object({ url: z.string(), html: z.string() }))
    .default([]),
});
export type Trace = z.infer<typeof Trace>;

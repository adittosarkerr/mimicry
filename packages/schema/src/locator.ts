import { z } from 'zod';

/**
 * A single way of pointing at an element. The recorder emits many of these per
 * element so replay can degrade gracefully when a site ships new markup:
 * hashed CSS classes churn constantly, but `data-testid`, accessible names and
 * visible text usually survive a redeploy.
 */
export const LocatorStrategy = z.enum([
  'testid', // [data-testid=…], [data-test=…], [data-qa=…]
  'id', // #foo — only when the id looks stable (not react-generated)
  'role', // getByRole(role, { name })
  'label', // getByLabel — form controls with a <label for>
  'placeholder',
  'text', // exact visible text
  'altText',
  'title',
  'name', // [name=…] — very stable on real forms
  'css', // structural fallback
  'xpath', // absolute-ish fallback, last resort
  'nth', // "the 3rd <li> inside this container" — for list items
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategy>;

export const LocatorCandidate = z.object({
  strategy: LocatorStrategy,
  value: z.string(),
  /** Optional accessible name, used with `role`. */
  name: z.string().optional(),
  /** Was this selector unique on the page at record time? */
  unique: z.boolean().default(true),
  /**
   * 0–100 confidence that this selector still resolves after a site update.
   * Replay tries candidates in descending score order.
   */
  score: z.number().min(0).max(100),
});
export type LocatorCandidate = z.infer<typeof LocatorCandidate>;

/** Where an element lives when the page uses iframes or shadow DOM. */
export const FrameContext = z.object({
  /** Chain of iframe selectors from the top document inwards. */
  framePath: z.array(z.string()).default([]),
  frameUrl: z.string().optional(),
  /** Chain of shadow host selectors, outermost first. */
  shadowPath: z.array(z.string()).default([]),
});
export type FrameContext = z.infer<typeof FrameContext>;

export const ElementLocator = z.object({
  candidates: z.array(LocatorCandidate).min(1),
  frame: FrameContext.default({ framePath: [], shadowPath: [] }),
  /** Snapshot of the element at record time — used by the AI compiler and for debugging. */
  snapshot: z
    .object({
      tag: z.string(),
      type: z.string().optional(),
      role: z.string().optional(),
      accessibleName: z.string().optional(),
      text: z.string().optional(),
      html: z.string().optional(),
      attributes: z.record(z.string()).default({}),
      box: z
        .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
        .optional(),
    })
    .optional(),
});
export type ElementLocator = z.infer<typeof ElementLocator>;

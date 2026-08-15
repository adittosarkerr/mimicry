import { z } from 'zod';

export const RunStatus = z.enum([
  'queued',
  'starting',
  'running',
  'needs_attention', // captcha / login wall — headful handoff offered
  'succeeded',
  'partial', // finished, but the site returned nothing / unavailable
  'failed',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatus>;

/**
 * Phases drive the Claude-style live console. Each one has its own verb in the
 * UI ("Resolving…", "Filling…", "Reading results…").
 */
export const RunPhase = z.enum([
  'boot', // launching browser
  'navigate',
  'resolve', // finding an element / matching a combobox option
  'fill',
  'act', // click, submit
  'wait', // waiting for results to settle
  'extract',
  'render',
  'done',
  'error',
]);
export type RunPhase = z.infer<typeof RunPhase>;

export const RunEvent = z.object({
  runId: z.string(),
  seq: z.number().int(),
  ts: z.number(),
  phase: RunPhase,
  level: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  /** One line for the console: "Matched 'Dhaka' → Hazrat Shahjalal Intl (DAC)". */
  message: z.string(),
  /** Optional detail revealed when the user expands the line. */
  detail: z.string().optional(),
  stepId: z.string().optional(),
  /** 0–100. */
  progress: z.number().min(0).max(100).optional(),
  /** Storage key of a screenshot taken at this moment. */
  screenshot: z.string().optional(),
  /** Current page URL, so the console can show where the bot is. */
  url: z.string().optional(),
});
export type RunEvent = z.infer<typeof RunEvent>;

/**
 * What kind of thing came back.
 *
 * Results are not interchangeable: a video wants a wide thumbnail, a duration
 * and a channel; a place to stay wants a photo, a nightly price and a rating; a
 * repository wants stars and a language. Rendering all of them as the same card
 * throws away most of what the user came to see, so the run reports what it
 * found and the UI lays it out accordingly.
 */
export const ResultKind = z.enum([
  'video',
  'stay',
  'product',
  'article',
  'discussion',
  'repo',
  'place',
  'generic',
]);
export type ResultKind = z.infer<typeof ResultKind>;

/**
 * Facts that mean the same thing on every site.
 *
 * Kept apart from the free-form `attributes` list because the renderer needs to
 * place them deliberately — a duration belongs on the thumbnail, a rating next
 * to the price — and cannot do that with an unlabelled bag of strings.
 */
export const ResultMeta = z.object({
  /** "12:04", "1:05:58" */
  duration: z.string().optional(),
  /** "1.2M views", "3,410 watching" */
  views: z.string().optional(),
  /** "2 days ago", "Aug 6, 2025" */
  published: z.string().optional(),
  /** Channel, seller, publisher, author, owner. */
  author: z.string().optional(),
  location: z.string().optional(),
  /** "713 reviews" */
  reviews: z.string().optional(),
  /** Repositories: star count and primary language. */
  stars: z.string().optional(),
  language: z.string().optional(),
  /** Discussions: points/votes, answers/comments. */
  points: z.string().optional(),
  comments: z.string().optional(),
  /** News: the publication. */
  source: z.string().optional(),
});
export type ResultMeta = z.infer<typeof ResultMeta>;

/** One scraped result — a flight, a hotel, a video, a search hit. */
export const ResultItem = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string().optional(),
  description: z.string().optional(),
  image: z.string().optional(),
  /** Deep link back to the real site for this specific result. */
  url: z.string().optional(),
  price: z
    .object({ amount: z.number(), currency: z.string(), formatted: z.string() })
    .optional(),
  rating: z.number().optional(),
  meta: ResultMeta.default({}),
  badges: z.array(z.string()).default([]),
  /** Arbitrary label/value pairs — duration, stops, room type, seats left. */
  attributes: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
  /** Which page of results this came from, so the UI can group them. */
  page: z.number().int().default(1),
  /** Site said this one is sold out / unavailable. */
  unavailable: z.boolean().default(false),
  unavailableReason: z.string().optional(),
});
export type ResultItem = z.infer<typeof ResultItem>;

/**
 * A page read as a document rather than as a list.
 *
 * "Search Wikipedia for football and print the article" is not a request for
 * fifty links — it is a request for the page itself. Returning search results
 * there answers a question nobody asked, so a run can come back with the
 * article's own structure instead.
 */
export const ResultDocument = z.object({
  title: z.string(),
  url: z.string().optional(),
  /** One-paragraph summary — the lead, on most pages. */
  summary: z.string().optional(),
  /** Lead image, where the page has one. */
  image: z.string().optional(),
  sections: z
    .array(
      z.object({
        heading: z.string().optional(),
        /** 2 for a top-level section, 3 for a subsection, and so on. */
        level: z.number().int().min(1).max(6).default(2),
        paragraphs: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  wordCount: z.number().int().default(0),
});
export type ResultDocument = z.infer<typeof ResultDocument>;

export const RunOutput = z.object({
  layout: z.enum(['list', 'cards', 'table', 'detail', 'confirmation', 'raw']).default('cards'),
  /** What the results are, so the UI can render them as that rather than as rows. */
  resultKind: ResultKind.default('generic'),
  /** Headline the UI shows above results: "14 flights · Dhaka → Bangkok · 12 Sep". */
  summary: z.string().optional(),
  items: z.array(ResultItem).default([]),
  /** Set when the run was asked for a page's contents rather than a list. */
  document: ResultDocument.optional(),
  /** For confirmation-style runs (mail sent, booking made). */
  confirmation: z
    .object({
      ok: z.boolean(),
      reference: z.string().optional(),
      message: z.string(),
      details: z.array(z.object({ label: z.string(), value: z.string() })).default([]),
    })
    .optional(),
  /**
   * A written answer to what was actually asked.
   *
   * Some requests are not satisfied by a list. "Make me a good PC under 80,000"
   * or "which of these is the best value" needs somebody to read the results
   * and say something — the list is the evidence, not the answer. This is that
   * reading, produced from the scraped items only, so it can be checked against
   * what is on screen rather than taken on trust.
   */
  answer: z
    .object({
      text: z.string(),
      /** Indexes into `items` that the answer leans on, so it can be checked. */
      cites: z.array(z.number()).default([]),
      model: z.string(),
    })
    .optional(),
  /** Link to the final page the automation ended on. */
  finalUrl: z.string().optional(),
  finalScreenshot: z.string().optional(),
  /** Honest signal when the site had nothing to give. */
  emptyReason: z.string().optional(),
  /**
   * Every repeated block the extractor ranked, best first. Surfaced so the user
   * can correct a wrong pick by choosing the right one — which is a far more
   * reliable way to point at the results than clicking a region in a live page.
   */
  candidates: z
    .array(
      z.object({
        selector: z.string(),
        count: z.number(),
        score: z.number(),
        samples: z.array(z.string()).default([]),
        chosen: z.boolean().default(false),
      }),
    )
    .default([]),
  raw: z.unknown().optional(),
});
export type RunOutput = z.infer<typeof RunOutput>;

export const Run = z.object({
  id: z.string(),
  automationId: z.string(),
  userId: z.string().optional(),
  status: RunStatus,
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  durationMs: z.number().optional(),
  input: z.record(z.unknown()).default({}),
  events: z.array(RunEvent).default([]),
  output: RunOutput.optional(),
  error: z
    .object({
      code: z.enum([
        'timeout',
        'element_not_found',
        'navigation_failed',
        'bot_wall',
        'captcha',
        'login_required',
        'no_results',
        'site_error',
        'internal',
      ]),
      message: z.string(),
      stepId: z.string().optional(),
      screenshot: z.string().optional(),
      /** Actionable next step shown to the user. */
      suggestion: z.string().optional(),
    })
    .optional(),
});
export type Run = z.infer<typeof Run>;

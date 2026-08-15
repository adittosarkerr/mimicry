import { nanoid } from 'nanoid';
import type {
  Automation,
  ControlKind,
  ElementLocator,
  FormField,
  RecordedStep,
  Trace,
} from '@mimic/schema';
import { chatJson } from './deepseek';
import { config } from './config';
import { detectWall, launchSession, settle, waitOutChallenge } from './replay/browser';
import { extractOutput } from './replay/extract';
import { runAutomation } from './replay/engine';
import { exploreSite } from './explore';
import { profileFor, type SiteProfile } from './sites/profiles';

/**
 * Authoring automations from a description, with no recording.
 *
 * The replay engine can already find elements by meaning rather than by
 * selector — accessible name, placeholder, role — which is exactly the kind of
 * target a model can describe reliably. So a spoken request can be turned into
 * a real, runnable automation.
 *
 * The strong preference is a direct search URL (`?q={query}`). Driving a search
 * box blind is guesswork; navigating to a URL pattern is not, and most sites
 * expose one.
 */

interface AuthoredField {
  key?: string;
  label?: string;
  kind?: string;
  required?: boolean;
  default?: string | number | boolean | null;
  hint?: string;
  options?: string[];
}

interface AuthoredStep {
  action?: 'navigate' | 'fill' | 'click' | 'press' | 'select';
  /** For navigate. May contain `{field_key}` placeholders. */
  url?: string;
  /** How to find the element, in human terms. */
  target?: { role?: string; name?: string; placeholder?: string; tag?: string; css?: string };
  /** Literal value, or `{field_key}` to take it from the form. */
  value?: string;
  key?: string;
}

interface AuthoredAutomation {
  name?: string;
  description?: string;
  site?: string;
  category?: string;
  emoji?: string;
  fields?: AuthoredField[];
  steps?: AuthoredStep[];
  output_layout?: string;
  result_kind?: string;
  result_hint?: string;
  confidence?: number;
  refusal?: string;
}

const VALID_KINDS = new Set<ControlKind>([
  'text', 'textarea', 'number', 'email', 'select', 'combobox', 'multiselect',
  'checkbox', 'radio', 'toggle', 'date', 'time', 'datetime', 'slider',
]);

const SYSTEM = `You author browser automations for Mimic from a plain-English request.

Mimic replays your steps in a real headless browser. It finds elements by meaning — accessible name, placeholder text, ARIA role — so describe targets the way a person would, not with brittle CSS.

Rules:
1. STRONGLY prefer navigating straight to a URL that already contains the query. Most sites expose one (search pages, listing pages with filters). Put field values in with {curly_braces}: "https://example.com/search?q={query}". Mimic URL-encodes them. This is far more reliable than typing into a search box, so use it whenever you know the pattern.
2. Use ONLY parameter names you are genuinely sure about. Mimic opens your URL and checks that a real list of results comes back, so an invented parameter does not fail quietly — it fails, and you get asked again. A plain, minimal search URL that definitely works beats an elaborate one with guessed filter parameters. If you cannot express a filter in the URL with confidence, leave it out rather than inventing it.
3. If you do not know a site's URL pattern, DRIVE THE UI instead of guessing a path. Navigate to the site's normal entry page, then fill/click/press your way through exactly as a person would. Mimic replays UI plans in full and checks they produced real results, so this route is safe — a guessed deep path like /flights/index.html is not, because it loads a marketing page and scrapes navigation tiles while looking like it worked.
3a. A UI plan is the right answer for anything with several inputs that a URL cannot carry — flight searches, multi-field booking forms, sites with custom pickers. Describe each target the way a person would see it: {"role":"combobox","name":"Where from?"}, {"role":"button","name":"Search"}. Order the steps as a person would do them, and finish with the click that runs the search.
4. Every value a user would want to change must be a field. Keys are snake_case. Give each a sensible default taken from the request.
5. Use the real widget type for each field: text, number, select, date, checkbox, combobox.
6. Never invent a login, never automate anything requiring credentials or payment. If the request needs those, or you don't know the site, set "refusal" explaining why and leave steps empty.
7. Prefer well-known sites with stable, public URL patterns. If the user named a site, use it.
8. "confidence" is 0-1 for how sure you are this will actually work.
9. Say what the run should come back with in "output_layout":
   • "cards" (default) — a list of results: products, videos, hotels, search hits.
   • "detail" — the CONTENTS of one page, read as prose. Use this when the request is for an article, a page, a document, or asks to "read"/"scrape"/"print" something rather than list matches. "Search Wikipedia for football and print the article" is "detail", and the URL should go straight to the article, not to a search results page.
   • "confirmation" — a receipt or confirmation page after an action.
10. Say what kind of thing the results are in "result_kind": video, stay, product, article, discussion, repo, place, or generic.

Respond with one JSON object:
{
  "name": string,
  "description": string,
  "site": string (hostname),
  "category": string,
  "emoji": string (one emoji),
  "fields": [{"key":string,"label":string,"kind":string,"required":boolean,"default":any,"hint":string,"options":[string]}],
  "steps": [{"action":"navigate"|"fill"|"click"|"press","url":string,"target":{"role":string,"name":string,"placeholder":string,"tag":string},"value":string,"key":string}],
  "output_layout": "cards"|"detail"|"confirmation",
  "result_kind": "video"|"stay"|"product"|"article"|"discussion"|"repo"|"place"|"generic",
  "result_hint": string,
  "confidence": number,
  "refusal": string
}`;

const slug = (input: string, fallback = 'field') => {
  const s = (input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return s || fallback;
};

/** Builds a locator the semantic resolver can work with from a described target. */
function locatorFrom(target: AuthoredStep['target'], frameUrl: string): ElementLocator | undefined {
  if (!target) return undefined;

  const candidates: ElementLocator['candidates'] = [];
  if (target.css) candidates.push({ strategy: 'css', value: target.css, unique: false, score: 70 });
  if (target.role && target.name) {
    candidates.push({ strategy: 'role', value: target.role, name: target.name, unique: false, score: 85 });
  }
  if (target.name) candidates.push({ strategy: 'label', value: target.name, unique: false, score: 80 });
  if (target.placeholder) {
    candidates.push({ strategy: 'placeholder', value: target.placeholder, unique: false, score: 78 });
  }
  if (target.name) candidates.push({ strategy: 'text', value: target.name, unique: false, score: 55 });

  if (!candidates.length) return undefined;

  return {
    candidates,
    frame: { framePath: [], shadowPath: [], frameUrl },
    // The snapshot is what the semantic fallback matches against when none of
    // the candidates resolve — which is the common case for authored steps.
    snapshot: {
      tag: target.tag ?? (target.role === 'button' ? 'button' : 'input'),
      role: target.role,
      accessibleName: target.name,
      text: target.name,
      attributes: target.placeholder ? { placeholder: target.placeholder } : {},
    },
  };
}

export interface AuthorResult {
  automation?: Automation;
  refusal?: string;
  confidence: number;
}

/**
 * Substitutes field values into a templated URL.
 *
 * A placeholder with no value inside a query parameter is an optional filter
 * the model left blank — `&_udlo={min_price}` with no minimum. Dropping that
 * parameter is what a person would do; failing the whole plan over it throws
 * away an otherwise good URL. A placeholder in the *path* is different: there
 * is no sensible way to omit part of a path, so that really is unusable.
 */
function fillTemplate(template: string, fields: FormField[]): string | undefined {
  let url = template;
  for (const field of fields) {
    const value = field.defaultValue;
    if (value === null || value === undefined || value === '') continue;
    url = url.split(`{${field.key}}`).join(encodeURIComponent(String(value)));
  }

  if (!/\{[a-z0-9_]+\}/i.test(url)) return url;

  const [base, query = ''] = url.split('?');
  if (/\{[a-z0-9_]+\}/i.test(base)) return undefined;

  const kept = query
    .split('&')
    .filter((pair) => pair && !/\{[a-z0-9_]+\}/i.test(pair))
    // An empty parameter is the same omission written differently.
    .filter((pair) => !/^[^=]+=$/.test(pair));

  return kept.length ? `${base}?${kept.join('&')}` : base;
}

/** Statuses that mean "we don't serve robots", not "your URL was wrong". */
const REFUSAL_STATUS = new Set([401, 403, 407, 429, 451]);

/**
 * Runs the plan for real and reports whether it produced anything.
 *
 * Used for automations that drive the page rather than encode the request in a
 * URL. It costs a full replay, but authoring happens once and a plan that has
 * actually run is worth incomparably more than one that merely parses.
 */
async function verifyByReplay(
  automation: Automation,
  url: string,
): Promise<{ ok: boolean; url: string; reason: string; blocked?: boolean }> {
  const values = Object.fromEntries(
    automation.schema.fields
      .filter((f) => f.defaultValue !== null && f.defaultValue !== undefined)
      .map((f) => [f.key, f.defaultValue]),
  );

  const run = await runAutomation({ automation, values, maxPages: 1 }).catch((err) => ({
    status: 'failed' as const,
    error: { message: String(err).slice(0, 160) },
    output: undefined,
  }));

  if (run.status === 'needs_attention') {
    return { ok: false, blocked: true, url, reason: 'the site asked for a human before it would continue' };
  }

  if (run.status !== 'succeeded') {
    const why = run.error?.message ?? run.output?.emptyReason ?? 'it produced nothing';
    return { ok: false, url, reason: `running it did not work — ${why}` };
  }

  const found = run.output?.items.length ?? 0;
  const words = run.output?.document?.wordCount ?? 0;
  if (found < 3 && words < 120) {
    return { ok: false, url, reason: `running it returned only ${found} results` };
  }

  return { ok: true, url, reason: `${found || `${words} words`} from a real run` };
}

/**
 * Opens the automation's starting URL and decides whether real results came
 * back.
 *
 * Only URL-driven plans are checked — a UI-driven one would need a full replay,
 * and those already fall back gracefully at run time. Four ways to fail: the
 * page didn't load, the site refuses robots, the site bounced us to its home
 * page, or the page loaded fine but holds nothing resembling a result list.
 */
async function verifyAutomation(
  automation: Automation,
): Promise<{ ok: boolean; url: string; reason: string; blocked?: boolean }> {
  const navigate = automation.trace.steps.find((s) => s.type === 'navigate');
  const template = typeof navigate?.value === 'string' ? navigate.value : '';
  if (!template || !/^https?:\/\//i.test(template)) {
    return { ok: false, url: template, reason: 'the plan had no page to open' };
  }

  /* A plan that types into the page can only be judged by running it.
   *
   * Loading its first URL proves nothing — that is just the site's home page,
   * which loads fine and shows nothing relevant. Booking's flight search has no
   * URL anyone can guess, so a UI-driven plan is the only way to reach it, and
   * waving those through unchecked is how an automation that clicks the wrong
   * button gets handed over as working. Replaying it is the honest test. */
  const DRIVES_UI = new Set(['input', 'click', 'press', 'select', 'check']);
  if (automation.trace.steps.some((s) => DRIVES_UI.has(s.type))) {
    return verifyByReplay(automation, template);
  }

  const url = fillTemplate(template, automation.schema.fields);
  if (!url) {
    return { ok: false, url: template, reason: 'the URL had placeholders in its path with nothing to fill them' };
  }

  const session = await launchSession({});
  try {
    const landed = await session.page
      .goto(url, { waitUntil: 'domcontentloaded', timeout: 40_000 })
      .then((res) => res?.status() ?? 200)
      .catch(() => 0);

    if (!landed) return { ok: false, url, reason: 'the page did not load at all' };

    /* A refusal is about the visitor, not the address. Trying another URL on
       the same site is pointless, so this stops the loop and gets reported for
       what it is. */
    if (REFUSAL_STATUS.has(landed)) {
      return {
        ok: false,
        blocked: true,
        url,
        reason: `the site blocks automated visits (HTTP ${landed})`,
      };
    }
    if (landed >= 400) return { ok: false, url, reason: `the site answered ${landed}` };

    await settle(session.page, 6000);
    const cleared = await waitOutChallenge(session.page);
    const wall = await detectWall(session.page);
    if (wall.blocked) {
      return {
        ok: false,
        blocked: true,
        url,
        reason: `the site served an anti-bot challenge${cleared ? ' that did not clear' : ''} instead of the page`,
      };
    }

    /* Landing on the site's front door means the path or parameters were not
       understood — the site threw the query away and showed its home page. */
    const finalUrl = session.page.url();
    const bounced = (() => {
      try {
        const to = new URL(finalUrl);
        return to.pathname.replace(/\/$/, '') === '' && !to.search;
      } catch {
        return false;
      }
    })();
    if (bounced) {
      return { ok: false, url, reason: 'the site ignored it and redirected to its home page' };
    }

    const output = await extractOutput(session.page, {
      spec: { ...automation.schema.output, resultKind: undefined },
      maxPages: 1,
    });

    /* A document-style run has no list to count. What it needs is prose — and
       a page that redirected to a search form or an error still has none. */
    if (automation.schema.output.layout === 'detail') {
      const words = output.document?.wordCount ?? 0;
      return words >= 120
        ? { ok: true, url, reason: `${words} words of article` }
        : { ok: false, url, reason: `the page held only ${words} words — that is not the article` };
    }

    if (output.items.length < 3) {
      return {
        ok: false,
        url,
        reason: `the page loaded but held no result list (${output.items.length} blocks found)`,
      };
    }

    /* The decisive test: do the results have anything to do with the request?
     *
     * A site that didn't understand the URL still renders *something* — Google
     * Flights answers an unrecognised query with its marketing page, whose
     * sections ("Find cheap flights on popular routes", "Frequently asked
     * questions") are repeated, linked and wordy enough to pass every
     * structural check. What they never do is mention what was searched for.
     * Real results echo the query back. */
    const terms = automation.schema.fields
      .filter((f) => ['text', 'combobox', 'select', 'textarea'].includes(f.kind))
      .map((f) => String(f.defaultValue ?? '').trim())
      .filter((v) => v.length >= 3 && !/^\d{4}-\d{2}-\d{2}$/.test(v));

    if (terms.length) {
      const haystack = output.items
        .map((i) => `${i.title} ${i.subtitle ?? ''} ${i.description ?? ''}`)
        .join(' ')
        .toLowerCase();
      const echoed = terms.filter((t) => haystack.includes(t.toLowerCase()));

      if (echoed.length < Math.ceil(terms.length / 2)) {
        return {
          ok: false,
          url,
          reason: `the page came back without the search on it — nothing in ${output.items.length} blocks mentioned ${terms
            .filter((t) => !echoed.includes(t))
            .slice(0, 3)
            .join(' or ')}, so the site ignored those parameters`,
        };
      }
    }

    /* And they have to say something about themselves. Category tiles are
       repeated, linked and pictured; what they lack is prices, ratings, dates
       or a real description. */
    const substantive = output.items.filter(
      (i) =>
        i.price ||
        typeof i.rating === 'number' ||
        Object.keys(i.meta).length > 0 ||
        (i.description?.length ?? 0) > 40,
    ).length;

    if (substantive < Math.min(3, output.items.length)) {
      return {
        ok: false,
        url,
        reason: `the page showed ${output.items.length} link tiles rather than results (no prices, dates, ratings or descriptions on any of them)`,
      };
    }

    return { ok: true, url, reason: `${output.items.length} results` };
  } catch (err) {
    return { ok: false, url, reason: `checking it threw: ${String(err).slice(0, 120)}` };
  } finally {
    await session.close();
  }
}

/**
 * Authors an automation and checks it actually works before handing it over.
 *
 * A model asked for a URL pattern will produce one whether or not it knows the
 * site: `booking.com/flights/index.en.html?from=…&sort=weather` looks entirely
 * plausible and is fabricated. It loads, so nothing errors — it just shows a
 * marketing page whose navigation tiles get scraped as "60 results". The only
 * way to tell the difference is to open the page and look, so that is what
 * happens here, with the failure fed back so the next attempt is informed.
 */
/**
 * A URL shape Mimic has already seen work on a real site.
 *
 * Recordings are the best source of truth about how a site takes its inputs —
 * far better than a model's recollection. Handing these to the author is what
 * lets a spoken request reach a page nobody would guess the address of.
 */
export interface KnownTemplate {
  site: string;
  template: string;
  fields: { key: string; label: string; kind: string; example: unknown }[];
}

export async function authorAutomation(
  transcript: string,
  ownerId?: string,
  known: KnownTemplate[] = [],
  opts: { deadline?: number } = {},
): Promise<AuthorResult> {
  const attempts: string[] = [];
  let last: AuthorResult = { confidence: 0, refusal: 'No plan was produced.' };

  /**
   * When to stop and hand back what we have.
   *
   * Authoring is three tries, each writing a plan and then opening a browser to
   * check it. On a machine with no time limit that thoroughness is free. Inside
   * a serverless function it is not: the platform kills the request at sixty
   * seconds and the caller gets a 504, which is the worst of both — the work
   * was done and thrown away, and the page shows a number instead of a reason.
   *
   * So every stage asks whether there is time for it. Running out means
   * returning the plan we have, unverified and marked as such, rather than
   * nothing at all.
   */
  const deadline = opts.deadline ?? Number.POSITIVE_INFINITY;
  const timeLeft = () => deadline - Date.now();
  /* A browser check is a page load on somebody else's site. Below this there
     is no point starting one — it will be interrupted rather than answered. */
  const ENOUGH_TO_VERIFY = 20_000;
  const ENOUGH_TO_RETRY = 30_000;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0 && timeLeft() < ENOUGH_TO_RETRY) break;
    /* A model that returns truncated or malformed JSON is a bad attempt, not a
       server error. Retrying is what a person would do, and the loop is
       already here. */
    const result = await authorOnce(transcript, ownerId, attempts, known).catch((err) => {
      attempts.push(`the plan came back unusable — ${String(err).slice(0, 120)}`);
      return { confidence: 0 } as AuthorResult;
    });

    last = result;
    if (!result.automation) {
      if (result.refusal) return result; // a considered refusal is final
      continue; // a broken response — try again
    }

    /* A site we already know properly needs no guessing and no checking.
     *
     * Booking, GoZayaan and Kayak have hand-written profiles — the exact
     * fields, the exact URL shape, the exact result selector — because their
     * URLs weld several values into one string and inference cannot express
     * that. Authoring was ignoring all of it and guessing a URL from scratch,
     * then opening a browser to find out whether the guess worked. On a site
     * like Booking that is both slower than the request is allowed to take and
     * worse than the answer already written down. */
    const profile = profileFor(result.automation.site);
    if (profile) {
      return {
        automation: applyProfile(result.automation, profile),
        confidence: Math.max(result.confidence, 0.9),
      };
    }

    /* Out of time to check it. The plan is still the best answer available,
       and it is handed back honestly: no `verifiedAt`, and confidence that
       says "this has not been tried". The voice studio shows the plan before
       running anything, so the person decides. */
    if (timeLeft() < ENOUGH_TO_VERIFY) {
      return { automation: result.automation, confidence: Math.min(result.confidence, 0.6) };
    }

    const verdict = await verifyAutomation(result.automation);
    if (verdict.ok) {
      return {
        automation: { ...result.automation, verifiedAt: Date.now() },
        confidence: Math.max(result.confidence, 0.75),
      };
    }

    attempts.push(`${verdict.url} → ${verdict.reason}`);

    /* The site refuses automated visitors. No URL on it will do better, and a
       person with a browser can still do this — say that instead of grinding
       through two more identical failures. */
    if (verdict.blocked) {
      return {
        refusal:
          `That site blocks automated visits, so Mimic can't reach it on its own — ${verdict.reason}. ` +
          'Record it once with the extension while you are on the page, and the replay will use your own session.',
        confidence: 0.2,
      };
    }
  }

  /* Every guessed URL failed. Stop guessing and go look.
   *
   * Recalling a site's address only ever worked for sites everyone has
   * memorised. Opening the page and driving it is what a person does on a site
   * they have never seen, and it is the only route that generalises — so it is
   * where this ends up rather than a refusal. */
  const site = siteFromAttempts(last, attempts);
  /* Exploring is the slowest thing here — a browser, several page loads, a
     model call between each. Worth it when there is time, and guaranteed to be
     killed halfway when there is not. */
  if (site && timeLeft() > 25_000) {
    const explored = await exploreFrom(transcript, site, ownerId);
    if (explored.automation) return explored;
    attempts.push(`opening ${site} and driving it — ${explored.refusal}`);
  }

  /* Nothing verified, but a plan exists. Better than a refusal: the person
     sees what it would do and can run it or discard it. */
  if (last.automation) {
    return { automation: last.automation, confidence: Math.min(last.confidence, 0.5) };
  }

  const ranOut = timeLeft() <= 0;
  return {
    refusal: ranOut
      ? 'That took longer than this site is allowed to spend on one request. Sites it has never seen need a browser opened and driven, which does not fit in a minute — deploy the runner (see DEPLOYING.md) and it has no limit, or record the task once with the extension.'
      : `I tried ${attempts.length} ways to do that and checked each one — none worked.\n` +
        attempts.map((a) => `• ${a}`).join('\n') +
        '\nRecord it once with the extension and Mimic will replay it exactly.',
    confidence: Math.min(last.confidence, 0.2),
  };
}

/**
 * Rebuilds an authored automation around a site profile.
 *
 * The model is good at reading a request — "two adults, one child, two rooms,
 * five stars, breakfast" — and bad at remembering that Booking spells those
 * `group_adults`, `no_rooms` and a `;`-joined `nflt` bundle. So its values are
 * kept and its guesses about structure are thrown away: the profile's fields
 * and result selector replace them wholesale.
 *
 * Values transfer by key, then by label, because the model names things
 * sensibly without knowing the profile's spelling — `checkin` and `check_in`,
 * `guests` and `adults`.
 */
export function applyProfileForTest(automation: Automation, profile: SiteProfile): Automation {
  return applyProfile(automation, profile);
}

function applyProfile(automation: Automation, profile: SiteProfile): Automation {
  const authored = automation.schema.fields;
  const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

  const has = (f: FormField) => f.defaultValue != null && f.defaultValue !== '';

  const valueFor = (key: string, label: string): FormField['defaultValue'] => {
    const want = [normalise(key), normalise(label)];

    // Exactly the same name is the strongest signal, so it is asked first.
    const exact = authored.find((f) => want.includes(normalise(f.key)) || want.includes(normalise(f.label)));
    if (exact && has(exact)) return exact.defaultValue;

    /* Then by overlap, because the model names things sensibly without knowing
       this site's spelling: `star_rating` for `stars`, `breakfast_included`
       for `breakfast`, `checkin_date` for `check_in`. Substring either way,
       and the shortest name wins so `children` does not swallow `child_age`. */
    const near = authored
      .filter(has)
      .filter((f) => {
        const names = [normalise(f.key), normalise(f.label)];
        return names.some((n) => want.some((w) => w.length > 3 && (n.includes(w) || w.includes(n))));
      })
      .sort((a, b) => a.key.length - b.key.length)[0];

    return near?.defaultValue ?? null;
  };

  /** The model says 5 or "yes"; the profile wants "5" or true. */
  const coerce = (field: FormField, value: FormField['defaultValue']): FormField['defaultValue'] => {
    if (field.kind === 'toggle' || field.kind === 'checkbox') {
      return typeof value === 'boolean' ? value : /^(1|true|yes|on|included)$/i.test(String(value));
    }
    if (field.kind === 'select') {
      const asText = String(value);
      // Only if the site actually offers it — an invented option filters to nothing.
      const match = field.options.find(
        (o) => normalise(o.value) === normalise(asText) || normalise(o.label) === normalise(asText),
      );
      return match ? match.value : (field.defaultValue ?? '');
    }
    if (field.kind === 'number') {
      const n = Number(value);
      return Number.isFinite(n) ? n : field.defaultValue;
    }
    return value;
  };

  const fields: FormField[] = profile.fields.map((field) => {
    const heard = valueFor(field.key, field.label);
    return heard === null || heard === undefined ? field : { ...field, defaultValue: coerce(field, heard) };
  });

  return {
    ...automation,
    name: automation.name || profile.name,
    category: profile.category,
    emoji: profile.emoji,
    schema: {
      ...automation.schema,
      category: profile.category,
      fields,
      groups: Array.from(new Set(fields.map((f) => f.group))),
      output: profile.output,
      /* The engine builds this site's URL from the profile rather than from a
         template, so a guessed one here could only ever disagree with it. */
      urlTemplate: undefined,
      compiledBy: `${automation.schema.compiledBy} + ${profile.id} profile`,
    },
    /* Written down as checked: a profile is a hand-verified description of the
       site, which is a better warrant than one successful page load. */
    verifiedAt: Date.now(),
  };
}

/** The site the model kept aiming at, so exploration starts somewhere sensible. */
function siteFromAttempts(last: AuthorResult, attempts: string[]): string | undefined {
  const fromPlan = last.automation?.site;
  if (fromPlan) return `https://${fromPlan.replace(/^https?:\/\//, '')}`;

  for (const attempt of attempts) {
    const url = attempt.match(/https?:\/\/[^\s]+/)?.[0];
    if (!url) continue;
    try {
      return new URL(url).origin;
    } catch {
      /* not a URL we can read */
    }
  }
  return undefined;
}

/**
 * Builds an automation by operating the site rather than guessing its URL.
 *
 * The exploration already proved the steps work — it only stops when the
 * results are on screen — so what comes back needs no separate verification.
 */
async function exploreFrom(
  transcript: string,
  startUrl: string,
  ownerId?: string,
): Promise<AuthorResult> {
  const explored = await exploreSite(transcript, startUrl);

  if (explored.failure || explored.steps.length < 2) {
    return { refusal: explored.failure ?? 'nothing came of it', confidence: 0.2 };
  }

  let origin = startUrl;
  try {
    origin = new URL(startUrl).hostname;
  } catch {
    /* keep what we were given */
  }

  const now = Date.now();
  const name = `${transcript.slice(0, 70).trim()}`;

  const trace: Trace = {
    id: `tr_${nanoid(10)}`,
    version: 1,
    createdAt: now,
    startUrl,
    finalUrl: explored.finalUrl,
    origin,
    title: name,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    steps: explored.steps,
    requests: [],
    domSnapshots: [],
  };

  return {
    confidence: 0.8,
    automation: {
      id: `au_${nanoid(12)}`,
      ownerId,
      name: name.slice(0, 120),
      description: `Worked out by opening ${origin} and doing the task once.`,
      site: origin,
      category: 'general',
      emoji: '🧭',
      createdAt: now,
      updatedAt: now,
      trace,
      schema: {
        id: `fs_${nanoid(10)}`,
        traceId: trace.id,
        version: 1,
        name: name.slice(0, 120),
        description: '',
        site: origin,
        category: 'general',
        fields: explored.fields,
        groups: ['Details'],
        output: {
          layout: 'cards',
          containerLocator: undefined,
          itemLocator: undefined,
          itemLocatorPinned: false,
          fields: [],
          emptyStateHints: ['no results', 'no results found', 'nothing found', '0 results'],
          unavailableHints: ['sold out', 'out of stock', 'unavailable', 'not available'],
        },
        estimatedDurationMs: 45_000,
        compiledBy: `${config.deepseek.model} (authored)`,
        compiledAt: now,
        heuristicOnly: false,
      },
      stats: { runs: 0, successes: 0, failures: 0 },
      visibility: 'private',
      refining: false,
      verifiedAt: now,
    },
  };
}

async function authorOnce(
  transcript: string,
  ownerId: string | undefined,
  failedAttempts: string[],
  known: KnownTemplate[] = [],
): Promise<AuthorResult> {
  const authored = await chatJson<AuthoredAutomation>(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          request: transcript,
          today: new Date().toISOString().slice(0, 10),
          /* URL shapes taken from recordings that actually ran. Far more
             reliable than recalling a site's parameters, and the reason a
             request can reach a page whose address nobody would guess. */
          ...(known.length
            ? {
                url_patterns_known_to_work: known,
                instruction_patterns:
                  'These came from real recordings on these sites and are known to work. If the request is for one of these sites, build on the matching pattern — keep its parameter names exactly, change only the values, and drop parameters the request does not need.',
              }
            : {}),
          // What already failed, so the model stops proposing variations of it.
          ...(failedAttempts.length
            ? {
                already_tried_and_failed: failedAttempts,
                instruction:
                  'Those URLs did not return a list of results. Do not use them or minor variations of them. Use a simpler, more certain URL — or a different site you are sure about.',
              }
            : {}),
        }),
      },
    ],
    /* A UI-driven plan is several times longer than a one-line URL — each step
       carries a described target. Truncating it half-way through produces
       unparseable JSON, which used to surface as a 500 rather than a retry. */
    { temperature: failedAttempts.length ? 0.5 : 0.2, maxTokens: 6000, timeoutMs: 120_000 },
  );

  const confidence = Math.max(0, Math.min(1, Number(authored.confidence) || 0.5));

  if (authored.refusal || !authored.steps?.length) {
    return {
      refusal:
        authored.refusal?.trim() ||
        "I couldn't work out a reliable way to do that on the open web. Record it once and I'll take it from there.",
      confidence,
    };
  }

  const startUrl = authored.steps.find((s) => s.action === 'navigate')?.url;
  if (!startUrl || !/^https?:\/\//i.test(startUrl)) {
    return { refusal: 'The plan had no valid starting URL.', confidence };
  }

  let origin = authored.site ?? '';
  try {
    origin = new URL(startUrl.replace(/\{[^}]+\}/g, 'x')).hostname;
  } catch {
    /* keep whatever the model said */
  }

  // ── fields ───────────────────────────────────────────────────────────
  const usedKeys = new Set<string>();
  const fields: FormField[] = (authored.fields ?? []).map((f, i) => {
    let key = slug(f.key || f.label || `field_${i + 1}`);
    while (usedKeys.has(key)) key = `${key}_${i}`;
    usedKeys.add(key);

    const kind = (VALID_KINDS.has(f.kind as ControlKind) ? f.kind : 'text') as ControlKind;
    return {
      key,
      label: f.label || key.replace(/_/g, ' '),
      hint: f.hint,
      kind,
      group: 'Details',
      order: i,
      required: Boolean(f.required),
      defaultValue: f.default ?? null,
      placeholder: undefined,
      options: (f.options ?? []).map((o) => ({ label: String(o), value: String(o), disabled: false })),
      dynamicOptions: undefined,
      validation: {},
      bindsTo: [],
      exposure: 'variable' as const,
    };
  });

  const fieldByKey = new Map(fields.map((f) => [f.key, f]));

  // ── steps ────────────────────────────────────────────────────────────
  const steps: RecordedStep[] = [];
  const now = Date.now();

  authored.steps.forEach((s, i) => {
    const id = `au_${nanoid(8)}`;
    const base = {
      id,
      seq: steps.length,
      ts: now + i * 1000,
      url: startUrl,
      delayBefore: i === 0 ? 0 : 600,
      hints: {},
      causedNavigation: false,
      meta: { kind: 'unknown' as ControlKind, options: [], required: false },
    };

    // Which field does this step carry the value of?
    const referenced =
      s.key ??
      (typeof s.value === 'string' ? s.value.match(/^\{([a-z0-9_]+)\}$/i)?.[1] : undefined) ??
      (s.action === 'navigate' ? s.url?.match(/\{([a-z0-9_]+)\}/i)?.[1] : undefined);
    const field = referenced ? fieldByKey.get(slug(referenced)) : undefined;

    switch (s.action) {
      case 'navigate': {
        if (!s.url) return;
        steps.push({ ...base, type: 'navigate', value: s.url });

        /* Every placeholder in the URL, not just the first.
         *
         * A field with nothing bound to it is dropped from the form as
         * unwired — so binding only one of `{origin}/{destination}/{date}`
         * silently deleted the other two, and the run then navigated to a URL
         * with the braces still in it. */
        for (const match of s.url.matchAll(/\{([a-z0-9_]+)\}/gi)) {
          const bound = fieldByKey.get(slug(match[1]));
          if (bound && !bound.bindsTo.includes(id)) bound.bindsTo.push(id);
        }
        return;
      }
      case 'fill': {
        const target = locatorFrom(s.target, startUrl);
        if (!target) return;
        steps.push({
          ...base,
          type: 'input',
          target,
          value: field ? String(field.defaultValue ?? '') : (s.value ?? ''),
          meta: {
            kind: field?.kind ?? 'text',
            label: s.target?.name ?? field?.label,
            options: [],
            required: false,
          },
        });
        if (field) field.bindsTo.push(id);
        return;
      }
      case 'click': {
        const target = locatorFrom(s.target, startUrl);
        if (!target) return;
        steps.push({
          ...base,
          type: 'click',
          target,
          value: s.target?.name,
          causedNavigation: true,
          meta: { kind: 'button', label: s.target?.name, options: [], required: false },
        });
        return;
      }
      case 'press': {
        steps.push({ ...base, type: 'press', value: s.value || 'Enter' });
        return;
      }
      default:
        return;
    }
  });

  if (!steps.length) {
    return { refusal: 'The plan had no steps Mimic could carry out.', confidence };
  }

  // Fields the model declared but never wired up would silently do nothing.
  const wired = fields.filter((f) => f.bindsTo.length);

  const trace: Trace = {
    id: `tr_${nanoid(10)}`,
    version: 1,
    createdAt: now,
    startUrl,
    finalUrl: undefined,
    origin,
    title: authored.name || `Task on ${origin}`,
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    steps,
    requests: [],
    domSnapshots: [],
  };

  const automation: Automation = {
    id: `au_${nanoid(12)}`,
    ownerId,
    name: (authored.name || `Task on ${origin}`).slice(0, 120),
    description: (authored.description || `Authored from a spoken request.`).slice(0, 600),
    site: origin,
    category: authored.category || 'general',
    emoji: authored.emoji || '✨',
    createdAt: now,
    updatedAt: now,
    trace,
    schema: {
      id: `fs_${nanoid(10)}`,
      traceId: trace.id,
      version: 1,
      name: authored.name || `Task on ${origin}`,
      description: authored.description || '',
      site: origin,
      category: authored.category || 'general',
      fields: wired.length ? wired : fields,
      groups: ['Details'],
      output: {
        layout: (['cards', 'detail', 'confirmation', 'list', 'table'].includes(
          authored.output_layout ?? '',
        )
          ? authored.output_layout
          : 'cards') as 'cards',
        resultKind: (
          ['video', 'stay', 'product', 'article', 'discussion', 'repo', 'place', 'generic'] as const
        ).find((k) => k === authored.result_kind),
        containerLocator: undefined,
        itemLocator: undefined,
        itemLocatorPinned: false,
        fields: [],
        emptyStateHints: ['no results', 'no results found', 'nothing found', 'we could not find', '0 results'],
        unavailableHints: ['sold out', 'out of stock', 'unavailable', 'not available'],
      },
      estimatedDurationMs: 20_000,
      compiledBy: `${config.deepseek.model} (authored)`,
      compiledAt: now,
      heuristicOnly: false,
    },
    stats: { runs: 0, successes: 0, failures: 0 },
    visibility: 'private',
    refining: false,
  };

  return { automation, confidence };
}

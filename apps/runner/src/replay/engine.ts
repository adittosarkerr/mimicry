import { nanoid } from 'nanoid';
import type { Locator, Page } from 'playwright';
import type {
  Automation,
  FormField,
  RecordedStep,
  Run,
  RunEvent,
  RunOutput,
  RunPhase,
} from '@mimic/schema';
import { config } from '../config.js';
import { saveScreenshot } from '../store.js';
import { detectWall, launchSession, settle, waitOutChallenge, type Session } from './browser.js';
import { describeTarget, resolve } from './resolve.js';
import { pickDate } from './calendar.js';
import { fillCombobox } from './combobox.js';
import { setStepper } from './stepper.js';
import { extractOutput, looksLikeNavigation, waitForContent } from './extract.js';
import { normalizeTrace } from './normalize.js';
import { inferUrlTemplate } from '../compile/heuristics.js';
import { profileFor } from '../sites/profiles.js';

/** `level` defaults to info, so callers only set it when it isn't. */
export type Emit = (
  event: Omit<RunEvent, 'runId' | 'seq' | 'ts' | 'level'> & { level?: RunEvent['level'] },
) => void;

export interface RunOptions {
  automation: Automation;
  values: Record<string, unknown>;
  runId?: string;
  userId?: string;
  /** Receives each fully-formed event, sequence number included. */
  emit?: (event: RunEvent) => void;
  /** Force a visible browser — used by the headful retry after a bot wall. */
  headless?: boolean;
  /** How many pages of results to walk before stopping. */
  maxPages?: number;
}

/** Steps that are scaffolding, not intent. Failing them shouldn't kill a run. */
const SOFT_STEPS = new Set(['scroll', 'press', 'hover', 'waitFor', 'extract']);

/**
 * URLs that only ever exist mid-flight. Recording one is normal; navigating to
 * one directly is not — you land on a page that bounces you somewhere else, or
 * nowhere at all, and every following step then fails to find its element.
 */
const INTERSTITIAL =
  /(RotateCookiesPage|\/sorry\/|consent\.|\/gen_204|accounts\.[^/]+\/(signin|ServiceLogin|RotateCookies)|\/oauth2?\/|\/checkcookie|\/cdn-cgi\/)/i;

/**
 * Decides which recorded navigations to actually perform.
 *
 * The recorder sees every committed navigation, including the ones the *site*
 * performed: redirect chains, cookie bounces, auth hops. Replaying those is
 * what breaks otherwise-perfect traces — a YouTube recording replays
 * `accounts.youtube.com/RotateCookiesPage` and then can't find the search box,
 * because the search box was never on that page.
 *
 * Only user-intended navigations survive: the first one, and any that follow a
 * real pause without a preceding action that already moves the page.
 */
function planNavigations(steps: RecordedStep[]): Set<string> {
  const skip = new Set<string>();
  let seenFirstNavigation = false;

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    if (step.type !== 'navigate') continue;

    if (!seenFirstNavigation) {
      seenFirstNavigation = true; // the starting URL is always ours to open
      continue;
    }

    if (step.hints?.redirect) {
      skip.add(step.id);
      continue;
    }

    if (INTERSTITIAL.test(String(step.value ?? step.url))) {
      skip.add(step.id);
      continue;
    }

    // Walk back past scrolls to find what actually preceded this.
    let prev: RecordedStep | undefined;
    for (let j = i - 1; j >= 0; j -= 1) {
      if (steps[j].type === 'scroll') continue;
      prev = steps[j];
      break;
    }
    if (!prev) continue;

    // A click that navigates gets us there on its own.
    if (prev.causedNavigation) {
      skip.add(step.id);
      continue;
    }

    // Back-to-back navigations with no pause between them are a redirect chain,
    // whatever the browser labelled them.
    if (prev.type === 'navigate' && step.delayBefore < 3000) {
      skip.add(step.id);
      continue;
    }

    // Any action immediately before a navigation probably caused it.
    if (['click', 'press', 'waitFor'].includes(prev.type) && step.delayBefore < 2500) {
      skip.add(step.id);
    }
  }

  return skip;
}

/**
 * Does this page look like it actually holds results?
 *
 * The bar is deliberately low — several repeated blocks with links. It only
 * has to separate "the shortcut worked" from "the site bounced us to a home
 * page or an error", because the alternative is replaying the recording, which
 * costs time but is never wrong to do.
 */
async function pageHasResults(page: Page): Promise<boolean> {
  return page
    .evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width >= 40 && r.height >= 12;
      };
      for (const container of Array.from(document.querySelectorAll('*'))) {
        const kids = Array.from(container.children).filter(visible);
        if (kids.length < 4) continue;
        const byTag = new Map<string, Element[]>();
        for (const kid of kids) {
          const list = byTag.get(kid.tagName) ?? [];
          list.push(kid);
          byTag.set(kid.tagName, list);
        }
        for (const family of byTag.values()) {
          if (family.length < 4) continue;
          const linked = family.filter((m) => {
            const href = m.querySelector('a[href]')?.getAttribute('href') ?? '';
            return href && !href.startsWith('#');
          }).length;
          if (linked >= 4) return true;
        }
      }
      return false;
    })
    .catch(() => false);
}

/**
 * Fills a recorded results URL in with this run's values.
 *
 * Returns undefined when the template can't honestly express the request —
 * a placeholder with nothing to put in it, or a field the user changed that
 * the URL has no room for. Getting that wrong would run a different search
 * from the one asked for and report it as a success, so the check is strict
 * and the step-by-step replay takes over whenever it fails.
 */
function resolveUrlTemplate(
  automation: Automation,
  values: Record<string, unknown>,
  steps: RecordedStep[],
): string | undefined {
  /* A site we know properly builds its own URL.
   *
   * Only for sites whose URL cannot be expressed as one value per parameter —
   * a route and two dates inside a single path segment. Everything else goes
   * through the inference below, which is where new sites keep arriving. */
  const profile = profileFor(automation.site);
  if (profile) {
    /* Defaults fill the gaps, but an explicitly emptied box beats them.
     *
     * `resolvedValues` treats "" as "nothing supplied, use the recorded value",
     * which is right for a search term and wrong for a return date: clearing it
     * is how a person says one-way, and handing back the recorded return date
     * silently books them a round trip. */
    const input: Record<string, unknown> = resolvedValues(automation, values);
    for (const [key, value] of Object.entries(values)) {
      if (value === '' || value === null) input[key] = '';
    }

    const built = profile.buildUrl(input);
    // No code for the city, no date — better to drive the page than to guess.
    if (built) return built;
  }

  /* Worked out on the fly when the schema predates this shortcut, so every
     automation already saved gets it without being recorded again. The repaired
     steps are what gets inspected, not the raw ones — a recording whose typing
     step was recovered only has its query there. */
  const inferred = inferUrlTemplate({ ...automation.trace, steps }, automation.schema.fields);
  const template = automation.schema.urlTemplate ?? inferred?.template;
  if (!template) return undefined;

  const placeholders = new Set(Array.from(template.matchAll(/\{([a-z0-9_]+)\}/gi)).map((m) => m[1]));
  const resolved = resolvedValues(automation, values);
  /* Placeholders the URL declares but the saved form never had — the guest
     counts and filters this compiler learned to read off the URL. Their
     recorded values keep the shortcut usable on an older schema. */
  for (const extra of inferred?.extraFields ?? []) {
    if (resolved[extra.key] === undefined && extra.defaultValue != null) {
      resolved[extra.key] = extra.defaultValue;
    }
  }
  for (const patch of inferred?.patches ?? []) {
    const supplied = resolved[patch.key];
    if ((supplied === undefined || supplied === null || supplied === '') && patch.defaultValue != null) {
      resolved[patch.key] = patch.defaultValue;
    }
  }

  let url = template;
  const unfilled: string[] = [];
  for (const key of placeholders) {
    const value = resolved[key];
    if (value === undefined || value === null || value === '') {
      unfilled.push(key);
      continue;
    }
    url = url.split(`{${key}}`).join(encodeURIComponent(String(value)));
  }

  /* A placeholder with nothing to put in it is an omitted parameter, not a
     reason to abandon the shortcut.
     One `{language}` left over from a schema that no longer has that field was
     enough to send every run down the slow UI path — and straight into the
     date picker that the URL existed to avoid. Drop the parameter and go. */
  if (unfilled.length) {
    const [base, query = ''] = url.split('?');
    // A placeholder in the path really is unusable — there is nothing to omit.
    if (/\{[a-z0-9_]+\}/i.test(base)) return undefined;
    const kept = query.split('&').filter((pair) => pair && !/\{[a-z0-9_]+\}/i.test(pair));
    url = kept.length ? `${base}?${kept.join('&')}` : base;
  }

  /* Anything the user changed that the URL cannot carry — a filter toggle, a
     sort order applied through the UI — means the fast path would quietly drop
     it. Fall back and replay the recording properly. */
  for (const field of automation.schema.fields) {
    if (placeholders.has(field.key)) continue;
    if (field.exposure === 'constant') continue;
    const supplied = values[field.key];
    if (supplied === undefined || supplied === null || supplied === '') continue;
    if (String(supplied) === String(field.defaultValue ?? '')) continue;

    /* Switching a filter OFF costs the URL nothing — a URL without the
       parameter is already the unfiltered search. Treating that as "the
       shortcut can't express this" meant every spoken request, which turns off
       the filters nobody asked for, fell back to driving the page by hand and
       died in the date picker the URL existed to avoid. Only turning something
       ON is a change the URL might not carry. */
    const switchingOff =
      (field.kind === 'checkbox' || field.kind === 'toggle') &&
      (supplied === false || supplied === 'false' || supplied === 0);
    if (switchingOff) continue;

    return undefined;
  }

  /* The URL carries values the form thinks it controls.
   *
   * Kayak records as `/flights/DAC-KUL/2026-08-25/2026-09-02/2adults`, GoZayaan
   * as `trips=KUL,DAC,2026-08-19,DAC,KUL,2026-09-20` — route, dates and
   * passenger counts welded into one path segment or one compound parameter,
   * where no `{placeholder}` can reach them. The form still shows From, To and
   * both dates, because those were really recorded; they just drive steps that
   * the shortcut skips. So the run silently searches the recorded trip whatever
   * the person typed, and reports success.
   *
   * Falling back to replaying the page is slower and less certain, but it is
   * the only path that honours what was filled in. A fast wrong answer is the
   * worst outcome available here. */
  const shadowed = automation.schema.fields.find((field) => {
    if (field.exposure === 'constant') return false;
    if (placeholders.has(field.key)) return false;
    if (field.kind !== 'date' && field.kind !== 'combobox') return false;
    if (!field.bindsTo.length) return false;

    // A date literal anywhere in the URL means the dates are baked in.
    return /\d{4}-\d{2}-\d{2}|\/\d{2}-\d{2}-\d{4}/.test(url);
  });

  if (shadowed) return undefined;

  url = stripUnaskedFilters(url, automation, values);
  return /^https?:\/\//i.test(url) ? url : undefined;
}

/** Filter clause keys that mean the same thing as a form field's name. */
const FILTER_ALIASES: Record<string, RegExp> = {
  mealplan: /breakfast|meal|board/i,
  stay_type: /property\s*type|stay\s*type|hotels?\s*only/i,
  ht_id: /property\s*type|accommodation/i,
  class: /star|rating/i,
  review_score: /review|score|guest\s*rating/i,
  price: /price|budget/i,
  popular_nr: /popular/i,
  fc: /free\s*cancel/i,
  pri: /price/i,
};

/**
 * Removes filters that were switched on the day of the recording and never
 * asked for since.
 *
 * A recorded search URL carries the person's filters as literal text —
 * booking's `nflt=stay_type=1;mealplan=1`. Because it is literal rather than a
 * `{placeholder}`, no form field can turn it off: the "Breakfast included"
 * toggle in the form binds to a click on the page, and the fast path never
 * clicks anything. So every future run inherits both filters silently.
 *
 * It is not a cosmetic problem. Cox's Bazar for those dates returns 26
 * properties; with the two inherited filters still attached it returns zero,
 * and the run correctly but uselessly reports that the site found nothing.
 *
 * The rule matches the one already applied to form values: a filter survives
 * only if a field the user can see is switched on for it.
 */
function stripUnaskedFilters(
  url: string,
  automation: Automation,
  values: Record<string, unknown>,
): string {
  if (!/[?&]n?flt=/i.test(url)) return url;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  const wanted = (clauseKey: string): boolean =>
    automation.schema.fields.some((field) => {
      if (field.exposure === 'constant') return false;
      if (field.kind !== 'checkbox' && field.kind !== 'toggle') return false;

      const alias = FILTER_ALIASES[clauseKey.toLowerCase()];
      const named = alias
        ? alias.test(field.label) || alias.test(field.key)
        : new RegExp(clauseKey.replace(/[^a-z0-9]/gi, '.?'), 'i').test(`${field.key} ${field.label}`);
      if (!named) return false;

      const supplied = values[field.key];
      const effective = supplied === undefined || supplied === '' ? field.defaultValue : supplied;
      return effective === true || effective === 'true' || effective === 1 || effective === '1';
    });

  for (const param of ['nflt', 'flt']) {
    const bundle = parsed.searchParams.get(param);
    if (!bundle) continue;

    const kept = bundle
      .split(';')
      .map((clause) => clause.trim())
      .filter(Boolean)
      .filter((clause) => wanted(clause.split(/[=:]/)[0]));

    if (kept.length) parsed.searchParams.set(param, kept.join(';'));
    else parsed.searchParams.delete(param);
  }

  return parsed.toString();
}

export async function runAutomation(opts: RunOptions): Promise<Run> {
  const { automation, values } = opts;
  const runId = opts.runId ?? `run_${nanoid(12)}`;
  const startedAt = Date.now();
  const events: RunEvent[] = [];
  let seq = 0;

  const emit: Emit = (partial) => {
    const event: RunEvent = { runId, seq: seq++, ts: Date.now(), level: 'info', ...partial };
    events.push(event);
    opts.emit?.(event);
  };

  const run: Run = {
    id: runId,
    automationId: automation.id,
    userId: opts.userId,
    status: 'starting',
    startedAt,
    input: values,
    events,
  };

  // Normalising again here is deliberate: automations recorded by an older
  // extension build get repaired at run time instead of needing a re-record.
  const steps = normalizeTrace(automation.trace.steps);
  const bindings = buildBindings(automation, values, steps);
  const skipNav = planNavigations(steps);
  /** Carries what happened during the run to the checks that follow it. */
  const ctx: StepContext = {
    lastFilled: null,
    lastValue: '',
    urlAfterFill: '',
    filledSomething: false,
    values: resolvedValues(automation, values),
    comboboxes: [],
  };
  let session: Session | null = null;

  try {
    emit({ phase: 'boot', message: 'Starting a clean browser session', progress: 1 });
    session = await launchSession({
      headless: opts.headless ?? config.browser.headless,
      trace: automation.trace,
    });
    const { page } = session;
    run.status = 'running';

    /* Straight to the results when the recording told us how.
     *
     * Everything the person did to a search box existed to build one URL. Going
     * there directly removes the whole class of failures this replay used to
     * hit — a suggestion list that opens too slowly, a submit the site handles
     * in JavaScript, an application that renders half a page when driven. If
     * the shortcut lands somewhere without results, the recording is replayed
     * properly instead. */
    const directUrl = resolveUrlTemplate(automation, values, steps);
    let tookShortcut = false;
    /** Optional inputs the page wouldn't accept — reported, never hidden. */
    const skippedRefinements: string[] = [];

    if (directUrl) {
      emit({
        phase: 'navigate',
        message: 'Going straight to the results',
        detail: directUrl.slice(0, 200),
        progress: 8,
      });
      const landed = await page
        .goto(directUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
        .then(() => true)
        .catch(() => false);

      if (landed) {
        await settle(page, 6000);
        await waitOutChallenge(page);
        /* Give it the same grace the extractor does before deciding it is
           empty. A slow site that hadn't finished painting was being judged as
           "nothing here" and sent down the UI path — the very path the URL
           existed to avoid, and the one that gets the dates approximately
           right instead of exactly right. */
        await waitForContent(page, 15_000);
        tookShortcut = await pageHasResults(page);
        if (!tookShortcut) {
          emit({
            phase: 'wait',
            level: 'warn',
            message: 'That page had nothing on it — replaying the recording instead',
            progress: 10,
          });
        }
      }
    }

    for (let i = 0; tookShortcut === false && i < steps.length; i += 1) {
      const step = steps[i];
      const progress = Math.min(96, 3 + Math.round((i / Math.max(steps.length, 1)) * 90));
      const binding = bindings.get(step.id);

      /* A field the user left empty is a field they didn't want to set.
       *
       * The step exists because the recording touched that control, but with
       * nothing to put in it the only options are to type "null" into the page
       * or to leave the control alone. Leaving it alone lets the site apply its
       * own default, which is what an empty box means everywhere else. */
      if (binding && (binding.value === null || binding.value === undefined || binding.value === '')) {
        emit({
          phase: 'act',
          level: 'debug',
          stepId: step.id,
          message: `Left ${binding.field.label} alone — nothing was filled in for it`,
          progress,
        });
        continue;
      }

      /* About to submit. Last chance to notice the destination went missing. */
      if (step.type === 'click' && step.causedNavigation && ctx.comboboxes.length) {
        await reassertComboboxes(page, ctx, emit);
      }

      // Redirects and site-driven hops were recorded, but they are not ours to
      // repeat — the click before them already gets us there.
      if (step.type === 'navigate' && skipNav.has(step.id)) {
        emit({
          phase: 'navigate',
          level: 'debug',
          stepId: step.id,
          message: 'Skipped a redirect the site performed on its own',
          detail: String(step.value ?? step.url).slice(0, 160),
          progress,
        });
        continue;
      }

      try {
        try {
          await executeStep(page, step, binding, emit, progress, ctx);
        } catch (first) {
          // Pages settle late, dialogs open over the target, lists re-render
          // mid-action. One patient retry converts a lot of spurious failures
          // into successes; a second would just be waiting.
          emit({
            phase: 'wait',
            level: 'debug',
            stepId: step.id,
            message: 'That did not take — letting the page settle and trying once more',
            detail: first instanceof Error ? cleanErrorMessage(first.message) : undefined,
            progress,
          });
          await settle(page, 4000);
          await dismissConsent(page);
          await executeStep(page, step, binding, emit, progress, ctx);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        /* An optional refinement that can't be applied should cost you the
           refinement, not the whole run.

           A "Traveling with pets" toggle lives behind a panel that may not be
           open, and its control genuinely may not exist this time. Abandoning a
           hotel search over it throws away the search the person actually asked
           for. Required fields are different: without those the run would be
           answering a different question, so they still stop it. */
        const optionalRefinement = Boolean(binding) && !binding!.field.required;
        const soft =
          SOFT_STEPS.has(step.type) || optionalRefinement || (!binding && !step.causedNavigation);

        if (soft) {
          if (binding) skippedRefinements.push(binding.field.label);
          emit({
            phase: 'act',
            level: 'warn',
            stepId: step.id,
            message: `Skipped a step that no longer applies${step.note ? ` (${step.note})` : ''}`,
            detail: message.slice(0, 300),
            progress,
          });
          continue;
        }

        // A hard failure — but check whether the site is the reason first.
        const wall = await detectWall(page);
        const screenshot = await capture(page, runId, `fail_${i}`);
        run.status = wall.blocked ? 'needs_attention' : 'failed';
        run.error = wall.blocked
          ? {
              code: wall.kind === 'login_required' ? 'login_required' : wall.kind === 'captcha' ? 'captcha' : 'bot_wall',
              message:
                wall.kind === 'login_required'
                  ? 'The site asked for a login before it would continue.'
                  : 'The site served an anti-bot challenge instead of the page.',
              stepId: step.id,
              screenshot,
              suggestion:
                wall.kind === 'login_required'
                  ? 'Re-record this automation while already signed in, or run it with a visible browser and sign in once.'
                  : 'Retry with a visible browser so you can clear the challenge, then the rest of the run continues automatically.',
            }
          : {
              code: 'element_not_found',
              message: `Step ${i + 1} failed: ${cleanErrorMessage(message)}`,
              stepId: step.id,
              screenshot,
              suggestion:
                'The page has probably changed since you recorded it. Re-record this task to refresh the selectors.',
            };

        emit({
          phase: 'error',
          level: 'error',
          stepId: step.id,
          message: run.error.message,
          detail: run.error.suggestion,
          screenshot,
          progress,
        });

        run.finishedAt = Date.now();
        run.durationMs = run.finishedAt - startedAt;
        return run;
      }
    }

    // ── results ──────────────────────────────────────────────────────────
    // Nothing to submit when the results were loaded directly.
    if (!tookShortcut) await ensureSubmitted(page, automation.trace, ctx, emit);

    emit({ phase: 'wait', message: 'Waiting for the page to settle', progress: 96 });
    await settle(page, 8000);

    emit({ phase: 'extract', message: 'Reading the results off the page', progress: 97 });
    const output: RunOutput = await extractOutput(page, {
      spec: automation.schema.output,
      summaryHint: summarize(automation, values),
      maxPages: opts.maxPages ?? 10,
      onProgress: (message, detail) =>
        emit({ phase: 'extract', message, detail, progress: 98 }),
    });

    output.finalScreenshot = await capture(page, runId, 'final');
    output.finalUrl = page.url();

    /* Say which filters didn't make it. These results are answering a slightly
       broader question than was asked, and quietly presenting them as though
       they weren't is the kind of small dishonesty that makes a tool
       untrustworthy. */
    if (skippedRefinements.length) {
      const unique = Array.from(new Set(skippedRefinements));
      output.summary = [output.summary, `couldn't apply ${unique.join(', ')}`]
        .filter(Boolean)
        .join(' · ');
    }

    /* Repeated, linked, pictured — and meaningless. A strip of category tiles
       satisfies every structural test for a result list, so counting it as a
       successful run is how an automation that has never worked goes on being
       offered as the answer to a spoken request. */
    const navigationOnly = looksLikeNavigation(output.items);
    if (navigationOnly) {
      output.emptyReason =
        'The page did show a repeating block, but the entries carry no prices, dates, ratings or descriptions — ' +
        "that is the site's own navigation, not results. The automation is probably pointing at the wrong page.";
    }

    if (output.items.length && !navigationOnly) {
      const unavailable = output.items.filter((it) => it.unavailable).length;
      emit({
        phase: 'extract',
        message: `Found ${output.items.length} result${output.items.length === 1 ? '' : 's'}${
          unavailable ? ` · ${unavailable} unavailable` : ''
        }`,
        progress: 99,
      });
    } else if (output.emptyReason) {
      emit({ phase: 'extract', level: 'warn', message: output.emptyReason, progress: 99 });
    }

    run.output = output;
    /* A run succeeded if it came back with something worth showing — a list, a
       confirmation, or an article. Judging that on `items.length` alone told
       someone looking at eleven thousand words of Wikipedia that the site had
       returned nothing. */
    const gotSomething =
      (output.items.length > 0 && !navigationOnly) ||
      Boolean(output.confirmation?.ok) ||
      (output.document?.wordCount ?? 0) >= 40;
    run.status = gotSomething ? 'succeeded' : 'partial';
    emit({
      phase: 'done',
      message: run.status === 'succeeded' ? 'Done' : 'Finished, but the site returned nothing to show',
      progress: 100,
      url: output.finalUrl,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // Internal failures are our bug, not the site's — keep the stack server-side.
    console.error(`[run ${runId}]`, err);
    run.status = 'failed';
    run.error = {
      code: /timeout/i.test(message) ? 'timeout' : 'internal',
      message: message.slice(0, 400),
      suggestion: 'Check that the site is reachable and try again.',
    };
    emit({ phase: 'error', level: 'error', message: run.error.message, progress: 100 });
  } finally {
    await session?.close();
  }

  run.finishedAt = Date.now();
  run.durationMs = run.finishedAt - startedAt;
  return run;
}

// ── step execution ─────────────────────────────────────────────────────────

interface Binding {
  field: FormField;
  value: unknown;
}

/** Every field's effective value: what the user supplied, else what was recorded. */
function resolvedValues(
  automation: Automation,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of automation.schema.fields) {
    const provided = values[field.key];
    out[field.key] =
      provided === undefined || provided === '' ? (field.defaultValue ?? '') : provided;
  }
  return { ...values, ...out };
}

function buildBindings(
  automation: Automation,
  values: Record<string, unknown>,
  steps: RecordedStep[],
): Map<string, Binding> {
  // A field compiled before normalisation may point at a step that has since
  // been folded into another. Follow the trail so the binding survives.
  const alias = new Map<string, string>();
  for (const step of steps) {
    alias.set(step.id, step.id);
    for (const merged of step.hints?.mergedFrom ?? []) alias.set(merged, step.id);
  }

  const map = new Map<string, Binding>();
  for (const field of automation.schema.fields) {
    const provided = values[field.key];
    const value = provided === undefined || provided === '' ? field.defaultValue : provided;
    for (const stepId of field.bindsTo) {
      const resolved = alias.get(stepId);
      if (resolved) map.set(resolved, { field, value });
    }
  }
  return map;
}

export interface StepContext {
  /** The last field we typed into — the one Enter should be sent to. */
  lastFilled: Locator | null;
  /** What we put in it, so an emptied field can be refilled before submitting. */
  lastValue: string;
  /** URL at the moment of the last fill — if it changed, a submit happened. */
  urlAfterFill: string;
  filledSomething: boolean;
  /** All field values, for URL templates like `?q={query}`. */
  values: Record<string, unknown>;
  /**
   * Comboboxes that have been filled, and what they should read.
   *
   * Booking's occupancy panel closing, a modal being dismissed, a re-render —
   * any of these can quietly blank a destination box that was filled correctly
   * three steps earlier. The site then searches its own default and the run
   * reports success on results for the wrong city, which is worse than an
   * error. Checking again just before the search goes in catches it.
   */
  comboboxes: { locator: Locator; expected: string; label: string }[];
}

/** Replaces `{field_key}` in a URL with the run's values, URL-encoded. */
function fillUrlTemplate(url: string, values: Record<string, unknown>): string {
  if (!url.includes('{')) return url;
  return url.replace(/\{([a-z0-9_]+)\}/gi, (whole, key: string) => {
    const value = values[key];
    return value === undefined || value === null ? whole : encodeURIComponent(String(value));
  });
}

async function executeStep(
  page: Page,
  step: RecordedStep,
  binding: Binding | undefined,
  emit: Emit,
  progress: number,
  ctx: StepContext,
): Promise<void> {
  const phaseFor = (): RunPhase =>
    step.type === 'navigate' ? 'navigate' : binding ? 'fill' : 'act';

  // Pace slightly — instant robotic input trips naive rate heuristics and
  // starves sites that debounce their own handlers.
  if (step.delayBefore > 400) {
    await page.waitForTimeout(Math.min(step.delayBefore * 0.25, 1200));
  }

  switch (step.type) {
    case 'navigate': {
      // Authored automations navigate straight to a search URL with the user's
      // values in it — far more reliable than driving a search box, when the
      // site supports it.
      const url = fillUrlTemplate(String(step.value ?? step.url), ctx.values);
      if (samePage(page.url(), url)) return;
      emit({ phase: 'navigate', message: `Opening ${hostOf(url)}`, detail: url, progress, url });
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.browser.stepTimeoutMs + 15_000 });
      await settle(page, 6000);

      // Sites behind a security interstitial serve the challenge first and the
      // real page a few seconds later. Every step after this fails if we start
      // looking for elements while the challenge is still up.
      const cleared = await waitOutChallenge(page);
      if (cleared) {
        emit({
          phase: 'wait',
          stepId: step.id,
          message: 'Waited out the site’s security check',
          progress,
        });
      }

      await dismissConsent(page);
      return;
    }

    case 'input': {
      if (step.meta.kind === 'date' || step.hints?.isoDate) {
        const value = binding ? binding.value : step.value;
        emit({
          phase: 'fill',
          stepId: step.id,
          message: `Setting ${binding?.field.label ?? 'date'} to ${String(value)}`,
          progress,
        });
        const res = await pickDate(page, step, value);
        if (!res.ok) throw new Error(res.detail ?? 'Could not set the date');
        emit({
          phase: 'fill',
          stepId: step.id,
          level: 'debug',
          message: `Date set via ${res.strategy}`,
          detail: res.detail,
          progress,
        });
        return;
      }

      if (step.hints?.secret) {
        // The recorder never captured this value, and we won't invent one.
        if (!binding || binding.value === undefined || binding.value === null || binding.value === '') {
          throw new Error('This automation needs a value for a sensitive field that was not recorded.');
        }
      }

      const value = binding ? binding.value : step.value;
      const target = step.target;
      if (!target) return;

      const found = await resolve(page, target, { timeoutMs: config.browser.stepTimeoutMs });
      if (!found) throw new Error(`Could not find ${describeTarget(target)}`);

      emit({
        phase: 'fill',
        stepId: step.id,
        message: `Filling ${binding?.field.label ?? describeTarget(target)}${
          step.hints?.secret ? '' : ` with “${truncate(String(value ?? ''), 40)}”`
        }`,
        detail: found.fallbackDepth > 0 ? `Matched on a fallback selector (${found.candidate.strategy})` : undefined,
        progress,
      });

      await found.locator.scrollIntoViewIfNeeded().catch(() => {});
      // Keep the element that actually received the text, not the wrapper we
      // resolved — Enter sent to a wrapper div submits nothing.
      ctx.lastFilled = await fillField(page, found.locator, String(value ?? ''));
      ctx.lastValue = String(value ?? '');
      ctx.urlAfterFill = page.url();
      ctx.filledSomething = true;
      return;
    }

    case 'select': {
      const value = binding ? binding.value : step.meta.resolvedOptionText ?? step.value;

      if (step.meta.kind === 'combobox') {
        emit({
          phase: 'resolve',
          stepId: step.id,
          message: `Searching ${binding?.field.label ?? 'options'} for “${truncate(String(value ?? ''), 40)}”`,
          progress,
        });
        const res = await fillCombobox(page, step, value);
        if (!res.ok) throw new Error(res.detail ?? 'Could not resolve the search field');
        emit({
          phase: 'resolve',
          stepId: step.id,
          message: `Matched “${truncate(res.chosen ?? '', 60)}”`,
          detail: res.detail,
          progress,
        });

        // Remember it so it can be checked again just before the search runs.
        if (res.input) {
          ctx.comboboxes = ctx.comboboxes.filter((c) => c.label !== (binding?.field.label ?? step.id));
          ctx.comboboxes.push({
            locator: res.input,
            expected: String(value ?? ''),
            label: binding?.field.label ?? 'the search box',
          });
        }
        return;
      }

      const target = step.target;
      if (!target) return;
      const found = await resolve(page, target, { timeoutMs: config.browser.stepTimeoutMs });
      if (!found) throw new Error(`Could not find ${describeTarget(target)}`);

      emit({
        phase: 'fill',
        stepId: step.id,
        message: `Choosing “${truncate(String(value ?? ''), 40)}” for ${binding?.field.label ?? 'a dropdown'}`,
        progress,
      });

      const wanted = Array.isArray(value) ? value.map(String) : [String(value ?? '')];
      try {
        await found.locator.selectOption(wanted, { timeout: 10_000 });
      } catch {
        // Not a native <select> after all — fall back to label matching.
        await found.locator.selectOption({ label: wanted[0] }, { timeout: 10_000 });
      }
      return;
    }

    case 'stepper': {
      const label = step.meta.label ?? 'the counter';
      const value = Number(binding ? binding.value : step.value);
      if (!Number.isFinite(value)) return;

      emit({
        phase: 'fill',
        stepId: step.id,
        message: `Setting ${binding?.field.label ?? label} to ${value}`,
        progress,
      });

      const result = await setStepper(page, label, value);
      if (!result.ok) {
        /* A count that would not move is worth saying out loud and carrying on
           from. The search still runs, with the site's own default — which is
           a partial answer, and far better than no answer at all. */
        emit({
          phase: 'fill',
          level: 'warn',
          stepId: step.id,
          message: `Left ${label} as the site had it — ${result.detail}`,
          progress,
        });
      }
      return;
    }

    case 'check': {
      const target = step.target;
      if (!target) return;
      const found = await resolve(page, target, { timeoutMs: config.browser.stepTimeoutMs });
      if (!found) throw new Error(`Could not find ${describeTarget(target)}`);

      const desired = binding ? toBool(binding.value) : Boolean(step.value);
      emit({
        phase: 'fill',
        stepId: step.id,
        message: `${desired ? 'Enabling' : 'Disabling'} ${binding?.field.label ?? describeTarget(target)}`,
        progress,
      });
      if (desired) await found.locator.check({ timeout: 10_000, force: true });
      else await found.locator.uncheck({ timeout: 10_000, force: true });
      return;
    }

    case 'click':
    case 'dblclick': {
      const target = step.target;
      if (!target) return;

      // A consent banner that isn't shown this time is not an error.
      if (step.hints?.inConsent) {
        const found = await resolve(page, target, { timeoutMs: 3000, waitForFirst: false });
        if (!found) return;
        await found.locator.click({ timeout: 5000 }).catch(() => {});
        emit({ phase: 'act', level: 'debug', stepId: step.id, message: 'Dismissed a consent banner', progress });
        return;
      }

      const found = await resolve(page, target, { timeoutMs: config.browser.stepTimeoutMs });
      if (!found) throw new Error(`Could not find ${describeTarget(target)}`);

      emit({
        phase: 'act',
        stepId: step.id,
        message: `Clicking ${describeTarget(target)}`,
        detail: found.fallbackDepth > 0 ? `Matched on a fallback selector (${found.candidate.strategy})` : undefined,
        progress,
      });

      await found.locator.scrollIntoViewIfNeeded().catch(() => {});

      if (step.causedNavigation) {
        await Promise.all([
          page.waitForLoadState('domcontentloaded', { timeout: config.browser.stepTimeoutMs }).catch(() => {}),
          found.locator.click({ timeout: config.browser.stepTimeoutMs }),
        ]);
        await settle(page, 8000);
        await dismissConsent(page);

        const wall = await detectWall(page);
        if (wall.blocked) throw new Error(`Blocked by the site (${wall.evidence ?? wall.kind}).`);
      } else {
        await clickStubbornly(page, found.locator);
        await page.waitForTimeout(config.browser.humanDelayMs);
      }
      return;
    }

    case 'press': {
      const key = String(step.value ?? 'Enter');
      emit({ phase: 'act', level: 'debug', stepId: step.id, message: `Pressing ${key}`, progress });

      /* Send the key to the element it was pressed on. A bare
         `keyboard.press` goes to whatever happens to hold focus, which after a
         re-render is usually the document — so the Enter that submits a search
         quietly goes nowhere and the run scrapes the page it started on. */
      /* Enter belongs to the field we just typed in. The recorded target for
         the keypress is often the wrapper the event bubbled to, and pressing
         Enter on a div does nothing at all. */
      if (key === 'Enter' && ctx.lastFilled) {
        await ctx.lastFilled.press(key).catch(() => {});
        await settle(page, 6000);
        return;
      }

      const target = step.target ? await resolve(page, step.target, { timeoutMs: 6000 }) : null;
      if (target) {
        await target.locator.press(key).catch(async () => {
          await target.locator.click({ timeout: 3000 }).catch(() => {});
          await page.keyboard.press(key).catch(() => {});
        });
      } else if (ctx.lastFilled) {
        await ctx.lastFilled.press(key).catch(() => {});
      } else {
        await page.keyboard.press(key);
      }

      if (key === 'Enter') await settle(page, 6000);
      return;
    }

    case 'scroll': {
      const y = Number(step.value ?? 0);
      await page.evaluate((top) => window.scrollTo({ top, behavior: 'instant' as ScrollBehavior }), y);
      await page.waitForTimeout(250);
      return;
    }

    case 'upload': {
      const target = step.target;
      if (!target || !binding?.value) return;
      const found = await resolve(page, target, { timeoutMs: 10_000 });
      if (!found) throw new Error('Could not find the file input');
      const files = Array.isArray(binding.value) ? binding.value.map(String) : [String(binding.value)];
      emit({ phase: 'fill', stepId: step.id, message: `Attaching ${files.length} file(s)`, progress });
      await found.locator.setInputFiles(files);
      return;
    }

    case 'waitFor': {
      await settle(page, 6000);
      return;
    }

    case 'extract':
      return; // a marker, not an action

    default:
      return;
  }
}

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Clears whatever is sitting on top of the page.
 *
 * Consent banners are only half of it: sign-in nags, newsletter overlays and
 * app-install interstitials all intercept pointer events, which surfaces as a
 * click that resolves the right element and then times out because something
 * invisible to us is in front of it.
 */
export async function dismissConsent(page: Page): Promise<void> {
  const accept = [
    '#onetrust-accept-btn-handler',
    '[data-testid="cookie-accept"]',
    '[aria-label="Accept cookies"]',
    'button:has-text("Accept all")',
    'button:has-text("Accept All")',
    'button:has-text("I agree")',
    'button:has-text("Got it")',
    'button:has-text("Accept")',
  ];

  const dismiss = [
    '[role="dialog"] [aria-label*="close" i]',
    '[role="dialog"] [aria-label*="dismiss" i]',
    '[aria-label="Dismiss sign-in info."]',
    '[data-testid*="close" i]',
    '[class*="modal" i] [aria-label*="close" i]',
    // Focus-trap wrappers: the container is not a dialog by role, but it still
    // swallows every click aimed at the page underneath it.
    '[data-bui-trap-root] [aria-label*="close" i]',
    '[data-bui-trap-root] [aria-label*="dismiss" i]',
    '[class*="overlay" i] [aria-label*="close" i]',
    'button[aria-label="Close"]',
    'button:has-text("No thanks")',
    'button:has-text("Not now")',
    'button:has-text("Maybe later")',
  ];

  for (const sel of [...accept, ...dismiss]) {
    const loc = page.locator(sel).first();
    if (await loc.isVisible({ timeout: 250 }).catch(() => false)) {
      await loc.click({ timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(200);
    }
  }

  // Some overlays only close on Escape.
  const stillBlocked = await page
    .locator('[role="dialog"]:visible, [aria-modal="true"]:visible, [data-bui-trap-root]:visible')
    .count()
    .catch(() => 0);
  if (stillBlocked > 0) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }

  await clearBlockingOverlay(page);
}

/**
 * Removes anything still standing between the automation and the page.
 *
 * Named close buttons and Escape handle most overlays, but not all: Booking's
 * sign-in prompt is a focus trap with no dialog role, and while it is up every
 * click lands on it instead of the search box. The failure is silent and
 * bizarre — the destination reports as filled, then the site searches somewhere
 * else entirely, because it never saw the selection at all.
 *
 * So this asks the browser the only question that matters: at the middle of the
 * page, what would actually receive a click? If the answer is a fixed panel
 * covering most of the viewport, and it is not the page's own content, it goes.
 */
/**
 * Puts back anything a combobox lost since it was filled.
 *
 * Between filling a destination and pressing Search, a site can close a panel,
 * re-render, or dismiss a modal — and any of those can blank the box. The site
 * then falls back to its own default, and the run returns hotels in the wrong
 * country while reporting that it matched the right city. Checking immediately
 * before the search goes in is the last moment this is still fixable.
 */
async function reassertComboboxes(page: Page, ctx: StepContext, emit: Emit): Promise<void> {
  for (const combo of ctx.comboboxes) {
    const current = await combo.locator.inputValue().catch(() => null);
    if (current === null) continue; // gone from the page — nothing to restore

    const wanted = combo.expected.trim();
    if (!wanted) continue;
    const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    if (normal(current).includes(normal(wanted).split(' ')[0] ?? '')) continue;

    emit({
      phase: 'fill',
      level: 'warn',
      message: `${combo.label} had been cleared — putting “${truncate(wanted, 40)}” back`,
      detail: `the box read “${current || 'empty'}” just before the search`,
    });

    await combo.locator.click({ timeout: 4000 }).catch(() => {});
    await combo.locator.fill(wanted).catch(() => {});
    await page.waitForTimeout(700);
    // Take the site's own first suggestion — it is the one bound to a real id.
    await page.keyboard.press('ArrowDown').catch(() => {});
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(400);
  }
}

async function clearBlockingOverlay(page: Page): Promise<void> {
  await page
    .evaluate(() => {
      const viewport = window.innerWidth * window.innerHeight;
      const midpoint = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      if (!midpoint) return false;

      // Walk up from whatever is on top, looking for the pane it belongs to.
      let node: Element | null = midpoint;
      for (let depth = 0; node && depth < 8; depth += 1) {
        const style = getComputedStyle(node);
        const box = node.getBoundingClientRect();
        const covers = (box.width * box.height) / viewport;

        const floating = style.position === 'fixed' || style.position === 'absolute';
        const onTop = Number.parseInt(style.zIndex || '0', 10) > 0;

        if (floating && onTop && covers > 0.4 && node !== document.body) {
          /* Don't mistake the page for an overlay.
             Judging that by "does it contain an input" was wrong — a sign-in
             prompt contains inputs too, and refusing to remove it left every
             click landing on the modal. Links are the better tell: a real page
             has hundreds, a modal has a handful. */
          const totalLinks = document.querySelectorAll('a[href]').length;
          const insideLinks = node.querySelectorAll('a[href]').length;
          const isThePage = totalLinks > 0 && insideLinks / totalLinks > 0.4;

          if (!isThePage) {
            node.remove();
            return true;
          }
        }
        node = node.parentElement;
      }
      return false;
    })
    .catch(() => false);
}

/**
 * Makes sure the search actually ran.
 *
 * A recording can end up missing its submit — the user pressed Enter on a key
 * the recorder didn't capture, or the site submitted from a handler that left
 * no click behind. Replay then types the query, never submits, and happily
 * scrapes whatever page it is still sitting on. That is how a search for one
 * thing returns two unrelated blog posts.
 *
 * The recorded final URL is the evidence: if it carried a query string that the
 * live page doesn't have, the submit never happened.
 */
async function ensureSubmitted(
  page: Page,
  trace: Automation['trace'],
  ctx: StepContext,
  emit: Emit,
): Promise<void> {
  if (!ctx.filledSomething) return;

  /* A click on the submit button may still be navigating. Deciding "nothing
     happened" while the navigation is in flight is how a Wikipedia search ends
     up pressing Enter a second time and landing on an article. */
  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(700);

  // The surest evidence a submit happened: the page moved after we typed.
  if (ctx.urlAfterFill && page.url() !== ctx.urlAfterFill) return;

  let current: URL;
  // The recorded final URL is a useful hint but not always present — an
  // interrupted recording has none, and requiring it disabled this check
  // exactly where it was needed.
  let recorded: URL | null = null;
  try {
    current = new URL(page.url());
    if (trace.finalUrl) recorded = new URL(trace.finalUrl);
  } catch {
    return;
  }

  // Deliberately not comparing origins: a recording that ended on a consent or
  // auth hop has a different origin from the site itself, and requiring a match
  // silently disabled this check on exactly those traces.
  const recordedHadQuery = Boolean(
    recorded && recorded.origin === current.origin && recorded.search.length > 1,
  );
  const currentHasQuery = current.search.length > 1;

  let startPath = '/';
  try {
    startPath = new URL(trace.startUrl).pathname;
  } catch {
    /* keep the default */
  }

  /* Two ways to tell the submit never happened:
     the recording ended on a URL carrying a query and we have none, or we typed
     into the page and are still sitting on the page we started from. The second
     catches sites whose search lives on the home page, where the recorded final
     URL looks identical to the start. */
  const missedQuery = recordedHadQuery && !currentHasQuery;
  const neverMoved = current.pathname === startPath && !currentHasQuery;

  emit({
    phase: 'wait',
    level: 'debug',
    message: 'Checking whether the search was submitted',
    detail: `at ${current.pathname}${current.search} · start ${startPath} · missedQuery=${missedQuery} neverMoved=${neverMoved}`,
  });

  if (!missedQuery && !neverMoved) return;

  emit({
    phase: 'act',
    level: 'warn',
    message: 'The search was never submitted — pressing Enter',
    detail: recorded
      ? `Expected a page like ${recorded.pathname}${recorded.search.slice(0, 60)}`
      : `Still on ${current.pathname} after typing`,
  });

  const before = page.url();

  /* Collapsible search overlays clear themselves when they lose focus, so by
     the time we submit the box can be empty — which submits an empty query and
     returns the site's "no search term" page. Put the value back first. */
  if (ctx.lastFilled && ctx.lastValue) {
    const present = await ctx.lastFilled.inputValue().catch(() => ctx.lastValue);
    if (!present.trim()) {
      await fillField(page, ctx.lastFilled, ctx.lastValue).catch(() => {});
    }
  }

  if (ctx.lastFilled) {
    await ctx.lastFilled.press('Enter').catch(() => {});
  } else {
    await page.keyboard.press('Enter').catch(() => {});
  }
  await page.waitForURL((url) => url.toString() !== before, { timeout: 6000 }).catch(() => {});

  /* Enter only submits when the field is inside a form and still focused.
     Overlay search boxes lose focus the moment the suggestion panel closes, so
     ask the form itself. */
  if (page.url() === before && ctx.lastFilled) {
    const submitted = await ctx.lastFilled
      .evaluate((el, wanted) => {
        const form = (el as HTMLElement).closest('form');
        if (!form) return false;
        // Never submit a form whose field went empty on us.
        const field = el as HTMLInputElement;
        if ('value' in field && !String(field.value).trim()) field.value = wanted;
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
        return true;
      }, ctx.lastValue)
      .catch(() => false);

    if (submitted) {
      await page.waitForURL((url) => url.toString() !== before, { timeout: 6000 }).catch(() => {});
    }
  }

  await settle(page, 5000);
}

/**
 * Types into a field, drilling down to the thing that can actually hold text.
 *
 * Recorded targets are frequently the wrapper rather than the control — a
 * styled `<div id="search-input">`, a `<label>`, a container the click bubbled
 * up to. `fill()` on one of those doesn't fail fast; it waits the entire
 * timeout for an element that is never going to become editable, which is what
 * a "locator.fill: Timeout 15000ms exceeded" really means.
 */
async function fillField(page: Page, locator: Locator, value: string): Promise<Locator> {
  const editable = await locator
    .evaluate((el) => {
      const tag = el.tagName.toLowerCase();
      return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable;
    })
    .catch(() => false);

  const target = editable
    ? locator
    : locator.locator('input, textarea, [contenteditable="true"]').first();

  const usable = (await target.count().catch(() => 0)) > 0 ? target : locator;

  try {
    await usable.fill(value, { timeout: Math.min(config.browser.stepTimeoutMs, 8000) });
    return usable;
  } catch {
    /* not fillable — fall back to typing at the keyboard */
  }

  await usable.click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press('Control+A').catch(() => {});
  await page.keyboard.type(value, { delay: 30 });
  return usable;
}

/**
 * Clicks that refuse to land.
 *
 * The element resolves fine but something invisible sits in front of it — a
 * sticky header, a cookie shim, a modal backdrop — and Playwright waits the
 * full timeout for actionability before giving up. Escalate instead: clear
 * overlays, then bypass the actionability checks, then dispatch the event
 * directly.
 */
async function clickStubbornly(page: Page, locator: Locator): Promise<void> {
  try {
    await locator.click({ timeout: Math.min(config.browser.stepTimeoutMs, 12_000) });
    return;
  } catch {
    /* something is in the way */
  }

  await dismissConsent(page);
  try {
    await locator.click({ timeout: 6000 });
    return;
  } catch {
    /* still blocked */
  }

  try {
    await locator.click({ timeout: 5000, force: true });
    return;
  } catch {
    /* force ignores hit-testing but still needs the element attached */
  }

  // Last resort: fire the click on the element itself.
  await locator.evaluate((el) => (el as HTMLElement).click());
}

/**
 * Playwright appends its whole call log to timeout errors. Useful in a
 * terminal, unreadable in a run console.
 */
function cleanErrorMessage(message: string): string {
  const cut = message.split(/\n?Call log:/i)[0];
  return cut.replace(/\s+/g, ' ').trim().slice(0, 220);
}

async function capture(page: Page, runId: string, tag: string): Promise<string | undefined> {
  try {
    const buf = await page.screenshot({ fullPage: false, type: 'png', timeout: 8000 });
    const key = `${runId}_${tag}`.replace(/[^\w-]/g, '');
    await saveScreenshot(key, buf);
    return key;
  } catch {
    return undefined;
  }
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url.slice(0, 40);
  }
};

/** Ignore query-string churn when deciding whether we're already there. */
function samePage(a: string, b: string): boolean {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
}

const toBool = (v: unknown): boolean =>
  typeof v === 'boolean' ? v : /^(1|true|yes|on|checked)$/i.test(String(v ?? ''));

/** One-line description of what this run was asked to do. */
function summarize(automation: Automation, values: Record<string, unknown>): string | undefined {
  const parts = automation.schema.fields
    .filter((f) => f.exposure === 'variable')
    .slice(0, 4)
    .map((f) => {
      const v = values[f.key] ?? f.defaultValue;
      if (v === null || v === undefined || v === '') return null;
      return `${f.label}: ${truncate(String(v), 24)}`;
    })
    .filter(Boolean);
  return parts.length ? parts.join(' · ') : undefined;
}

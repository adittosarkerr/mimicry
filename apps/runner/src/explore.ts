import { nanoid } from 'nanoid';
import type { Page } from 'playwright';
import type { ControlKind, ElementLocator, FormField, RecordedStep } from '@mimic/schema';
import { chatJson } from './deepseek';
import { launchSession, settle, waitOutChallenge } from './replay/browser';
import { dismissConsent } from './replay/engine';
import { waitForContent } from './replay/extract';
import { readSteppers, setStepper } from './replay/stepper';
import { setDate } from './replay/calendar';

/**
 * Working out how to do a task by opening the site and looking at it.
 *
 * The other way to author an automation is to ask a model for a URL and hope
 * it remembers the site. That works for Wikipedia and YouTube and fails for
 * everything else — and it fails silently, because a guessed URL still loads
 * *something*. It cannot ever handle a site nobody has memorised, which is
 * most of the web, so "record it once yourself" became the answer to every
 * interesting request.
 *
 * This does what a person does instead: open the page, see what is on it,
 * decide the next single action, do it, look again. The model never invents an
 * element — it chooses from the controls actually present, one step at a time.
 * What comes out is a recording, indistinguishable from one a person made, and
 * replayable by the same engine.
 */

/** One control on the page, as offered to the model. */
interface Control {
  ref: number;
  tag: string;
  type?: string;
  role?: string;
  name?: string;
  placeholder?: string;
  value?: string;
  options?: string[];
}

interface Decision {
  action?: 'fill' | 'click' | 'select' | 'press' | 'set_count' | 'set_date' | 'done' | 'give_up';
  ref?: number;
  /** For set_count: which counter — "Adults", "Rooms". */
  label?: string;
  value?: string;
  /** Set when this value is something a rerun would change. */
  field?: { key?: string; label?: string; kind?: string };
  reason?: string;
}

/**
 * Reads the page's interactive controls.
 *
 * Runs in the page, so it stays self-contained. Each control is tagged with a
 * ref the caller can click on, and described the way a person perceives it —
 * its visible label, not its markup — because that is what the model can
 * reason about and what replay can find again later.
 */
function readControls(): Control[] {
  const MARK = 'data-mimic-ref';
  document.querySelectorAll(`[${MARK}]`).forEach((n) => n.removeAttribute(MARK));

  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    if (r.bottom < -200 || r.top > window.innerHeight + 1200) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
  };

  /** What a screen reader would call this control. */
  const nameOf = (el: Element): string => {
    const aria = clean(el.getAttribute('aria-label'));
    if (aria) return aria;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const named = labelledBy
        .split(/\s+/)
        .map((id) => clean((document.getElementById(id) as HTMLElement | null)?.innerText))
        .filter(Boolean)
        .join(' ');
      if (named) return named;
    }

    const id = el.getAttribute('id');
    if (id) {
      const label = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      const text = clean((label as HTMLElement | null)?.innerText);
      if (text) return text;
    }

    const wrapping = el.closest('label');
    if (wrapping) {
      const text = clean((wrapping as HTMLElement).innerText);
      if (text && text.length < 80) return text;
    }

    const own = clean((el as HTMLElement).innerText);
    if (own && own.length < 80) return own;

    return clean(el.getAttribute('title') ?? el.getAttribute('name'));
  };

  const SELECTOR =
    'input:not([type="hidden"]), textarea, select, button, [role="button"], [role="combobox"], ' +
    '[role="searchbox"], [role="textbox"], [role="checkbox"], [role="radio"], [role="switch"], ' +
    '[role="tab"], [role="link"], [contenteditable="true"], a[href], ' +
    /* Calendar days and dropdown items are not buttons and were invisible here
       — so a model that opened a date picker saw the same page it had just
       clicked, clicked it again, and did that until it ran out of turns. */
    '[role="gridcell"], [role="option"], [role="menuitem"], [role="menuitemradio"], ' +
    'td[data-date], [data-date], [data-selenium*="checkIn" i], [data-selenium*="checkOut" i]';

  /* When something is open over the page, that thing IS the page: a person
     picking a date cannot click anything behind the calendar, and neither can
     we. Listing the overlay on its own keeps the choice small and correct. */
  const OVERLAY =
    '[role="dialog"], [aria-modal="true"], [role="listbox"], [role="menu"], ' +
    '[class*="calendar" i], [class*="datepicker" i], [data-selenium*="calendar" i]';
  // What makes it a picker rather than the page: a set of choices inside it.
  const CHOICES = '[role="gridcell"], [role="option"], [role="menuitem"], [data-date]';

  const overlay =
    Array.from(document.querySelectorAll(OVERLAY))
      .filter((el) => visible(el) && el.querySelectorAll(CHOICES).length >= 3)
      .sort((a, b) => a.querySelectorAll(CHOICES).length - b.querySelectorAll(CHOICES).length)[0] ?? null;

  const scope = overlay ?? document;
  // A calendar is 40-odd cells before anything else — it needs the headroom.
  const limit = overlay ? 130 : 70;

  const out: Control[] = [];
  let ref = 0;

  for (const el of Array.from(scope.querySelectorAll(SELECTOR))) {
    if (out.length >= limit) break;
    if (!visible(el)) continue;

    const tag = el.tagName.toLowerCase();
    const input = el as HTMLInputElement;
    const name = nameOf(el);

    /* A page has hundreds of links and none of them are the task. Keep only the
       ones that say something — and never at the expense of a real control. */
    if ((tag === 'a' || el.getAttribute('role') === 'link') && (!name || name.length > 60)) continue;

    const type = tag === 'input' ? input.type || 'text' : undefined;
    if (type === 'hidden') continue;
    if (!name && !input.placeholder && tag !== 'input' && tag !== 'select' && tag !== 'textarea') {
      continue;
    }

    ref += 1;
    el.setAttribute(MARK, String(ref));

    const control: Control = {
      ref,
      tag,
      type,
      role: el.getAttribute('role') ?? undefined,
      name: name || undefined,
      placeholder: input.placeholder || undefined,
      value: typeof input.value === 'string' && input.value ? input.value.slice(0, 60) : undefined,
    };

    if (tag === 'select') {
      control.options = Array.from((el as HTMLSelectElement).options)
        .slice(0, 25)
        .map((o) => clean(o.textContent))
        .filter(Boolean);
    }

    out.push(control);
  }

  return out;
}

const SYSTEM = `You are operating a real web browser to carry out one task, one action at a time.

Each turn you are shown the page's visible controls, each with a "ref" number. Choose the SINGLE next action, using only refs that are actually listed. You cannot invent elements.

Rules:
1. Work like a person: fill the search box, set the options that were asked for, then press the button that runs the search.
2. Only do what the task asks. Do not change settings nobody mentioned, do not accept offers, never sign in, never pay.
3. When a value is one a future run would want to change — a destination, a date, a number of people, a search term — attach "field" so it becomes an input on the form. Use the same key every time you refer to it.
4. Dates are set with "set_date": "ref" is the check-in / departure / date box, and "value" is the date as YYYY-MM-DD. It opens the picker, pages it to the right month and clicks the day for you. Never click day cells yourself, and never click the same date box twice.
5. Counters — adults, children, rooms, passengers — are set with "set_count": ONE counter per action. "label" is that counter's name on its own ("Adults"), "value" is a bare number ("2"). Never combine them ("2 adults, 1 child" is not a label and not a value). Any counters currently readable are listed under "counters"; if the one you want is not listed, name it anyway and it will be looked for. Do not click "+" or "−" and do not open the panel first. Attach "field" like any other value.
6. Set EVERY value the task named — destination, both dates, every count — BEFORE you run the search. Running it early throws the rest away: the results are for whatever the site had by default, and going back afterwards to fix a date does not change the results already on screen. Once the search has run, you are done; answer "done".
7. Answer "give_up" if the task cannot be done here — a login wall, a site that has no such feature. Say why in "reason".
8. One action per turn. Nothing else.

Respond with a single JSON object:
{"action":"fill"|"click"|"select"|"press"|"set_count"|"set_date"|"done"|"give_up","ref":number,"label":string,"value":string,"field":{"key":string,"label":string,"kind":string},"reason":string}`;

export interface ExploreResult {
  steps: RecordedStep[];
  fields: FormField[];
  finalUrl?: string;
  failure?: string;
}

/** A locator built from what a person sees, so replay can find it again. */
function locatorFor(control: Control, frameUrl: string): ElementLocator {
  const candidates: ElementLocator['candidates'] = [];
  const role = control.role ?? implicitRole(control);

  if (role && control.name) {
    candidates.push({ strategy: 'role', value: role, name: control.name, unique: false, score: 88 });
  }
  if (control.name) candidates.push({ strategy: 'label', value: control.name, unique: false, score: 80 });
  if (control.placeholder) {
    candidates.push({ strategy: 'placeholder', value: control.placeholder, unique: false, score: 78 });
  }
  if (control.name) candidates.push({ strategy: 'text', value: control.name, unique: false, score: 55 });

  return {
    candidates,
    frame: { framePath: [], shadowPath: [], frameUrl },
    snapshot: {
      tag: control.tag,
      type: control.type,
      role,
      accessibleName: control.name,
      text: control.name,
      attributes: control.placeholder ? { placeholder: control.placeholder } : {},
    },
  };
}

function implicitRole(control: Control): string | undefined {
  if (control.tag === 'button') return 'button';
  if (control.tag === 'a') return 'link';
  if (control.tag === 'select') return 'combobox';
  if (control.tag === 'textarea') return 'textbox';
  if (control.tag === 'input') {
    if (control.type === 'checkbox') return 'checkbox';
    if (control.type === 'radio') return 'radio';
    if (control.type === 'search') return 'searchbox';
    return 'textbox';
  }
  return undefined;
}

const VALID_KINDS = new Set<ControlKind>([
  'text', 'textarea', 'number', 'email', 'select', 'combobox', 'checkbox', 'date', 'time', 'datetime',
]);

/**
 * Drives the site to work out how the task is done.
 *
 * `onProgress` reports each action as it happens, because this takes a minute
 * and silence for a minute reads as a hang.
 */
export async function exploreSite(
  goal: string,
  startUrl: string,
  onProgress?: (message: string) => void,
): Promise<ExploreResult> {
  const session = await launchSession({});
  const steps: RecordedStep[] = [];
  const fields = new Map<string, FormField>();
  const history: string[] = [];
  const now = Date.now();

  try {
    const { page } = session;
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, 6000);
    await waitOutChallenge(page);
    /* A sign-in prompt or cookie wall covers the very controls we came to read,
       and reading none of them looks identical to a site with nothing on it. */
    await waitForContent(page, 15_000);
    await dismissConsent(page);

    steps.push({
      id: `ex_${nanoid(8)}`,
      seq: 0,
      ts: now,
      type: 'navigate',
      value: startUrl,
      url: startUrl,
      delayBefore: 0,
      hints: {},
      causedNavigation: false,
      meta: { kind: 'unknown', options: [], required: false },
    });

    /* An agent that can't tell its action had no effect will do it forever.
       Watching for a repeat and saying so explicitly is what turns "click the
       guests button five times" into "click it, then use the panel it opened". */
    let stuckOn: string | undefined;
    /* Telling a model not to repeat itself works about half the time. Taking
       the control away works every time, and the page is no worse off: three
       goes at the same button have already established it does nothing here. */
    const exhausted = new Set<string>();

    /* Setting a count or a date is idempotent: once it holds the right value,
       doing it again is a turn spent on nothing. The model cannot always tell —
       it asked for two rooms fourteen times, each one reporting success — so
       the count is kept here and the second attempt is refused outright. */
    const failures = new Map<string, number>();
    let datesSet = 0;
    const timesDone = new Map<string, number>();
    const alreadyDone = (record: string) => (timesDone.get(record) ?? 0) >= 1;
    const markDone = (record: string) => timesDone.set(record, (timesDone.get(record) ?? 0) + 1);

    for (let turn = 0; turn < 26; turn += 1) {
      const all = await page.evaluate(readControls).catch(() => [] as Control[]);
      const controls = all.filter((c) => !exhausted.has(c.name ?? ''));
      // Passive read — never opens anything, so it costs the page nothing.
      const counters = await readSteppers(page);
      if (!controls.length) {
        /* Nothing to operate. Say which kind of nothing — a page that refused
           to serve us reads exactly like a page that failed to load, and
           "no controls" tells the user neither. */
        const where = page.url();
        const title = await page.title().catch(() => '');
        const dead = /not-available|unavailable|unsupported|blocked|error/i.test(where);

        /* Unless we already got there. Having no controls left is the normal
           state of a finished job — the search ran, the page is full of
           results, and there is nothing more to operate. Calling that a
           failure threw away a completed run that had done everything asked. */
        const text = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0);
        if (!dead && steps.length > 1 && where !== startUrl && text > 1500) {
          return { steps, fields: [...fields.values()], finalUrl: where };
        }
        return {
          steps,
          fields: [...fields.values()],
          failure: dead
            ? `the site answered with “${title || where}” — it does not offer this here`
            : `nothing on ${where} could be operated (the page may not have loaded for us)`,
        };
      }

      const decision = await chatJson<Decision>(
        [
          { role: 'system', content: SYSTEM },
          {
            role: 'user',
            content: JSON.stringify({
              task: goal,
              today: new Date().toISOString().slice(0, 10),
              page: { url: page.url(), title: await page.title().catch(() => '') },
              done_so_far: history,
              /* Counters read straight off the page, so the model names one
                 that exists instead of inventing "Guests and rooms" from the
                 summary box and spending its turns being told no. */
              ...(counters.length
                ? { counters: counters.map((c) => ({ label: c.label, value: c.value })) }
                : {}),
              ...(stuckOn
                ? {
                    warning: `You have already done "${stuckOn}" and the page did not change in a way that helped. Do NOT do it again. Look at the controls below for what appeared as a result of it — a panel that opened will have its own buttons in this list — and act on one of those instead. If nothing useful is there, answer "done" or "give_up".`,
                  }
                : {}),
              controls,
            }),
          },
        ],
        { temperature: 0.1, maxTokens: 900, timeoutMs: 90_000 },
      ).catch(
        (err) =>
          ({
            action: 'give_up',
            reason: `could not decide what to do next — ${String(err).slice(0, 140)}`,
          }) as Decision,
      );

      if (decision.action === 'done') {
        return { steps, fields: [...fields.values()], finalUrl: page.url() };
      }
      if (decision.action === 'give_up' || !decision.action) {
        return {
          steps,
          fields: [...fields.values()],
          failure: decision.reason ?? 'it could not work out how to do this here',
        };
      }

      const fieldKeyOf = (fallback: string) =>
        (decision.field?.key || fallback)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '_')
          .replace(/^_+|_+$/g, '');

      /* Counters are a whole widget, not an element: the number lives in text
         between two buttons, often inside a panel that has to be opened first.
         Handled here rather than by the model, which otherwise spends its turns
         clicking "+" and re-opening a panel that closed. */
      if (decision.action === 'set_count') {
        const label = decision.label || decision.field?.label || '';
        const wanted = Number(decision.value);
        const record = `set ${label} = ${decision.value}`;
        if (alreadyDone(record)) {
          history.push(`${record} is already done — it does not need doing twice`);
          stuckOn = record;
          continue;
        }
        onProgress?.(`set ${label} to ${decision.value}`);

        const result = await setStepper(page, label, wanted);
        if (!result.ok) {
          /* Counters fail for a reason that does not change between turns —
             the panel holding them will not open, usually because the site's
             scripts never ran for us. Retrying is the same failure again, and
             booking.com spent every turn it had on exactly that. */
          const fails = (failures.get(record) ?? 0) + 1;
          failures.set(record, fails);
          if (fails >= 2) markDone(record);

          history.push(
            `${record} didn't work: ${result.detail}` +
              (fails >= 2 ? ' — leave this count alone and run the search' : ''),
          );
          stuckOn = record;
          await settle(page, 2500);
          continue;
        }

        const stepId = `ex_${nanoid(8)}`;
        steps.push({
          id: stepId,
          seq: steps.length,
          ts: now + steps.length * 1000,
          type: 'stepper',
          value: wanted,
          url: page.url(),
          delayBefore: 400,
          hints: {},
          causedNavigation: false,
          meta: { kind: 'number', label, options: [], required: false },
        });

        const key = fieldKeyOf(label);
        const existing = fields.get(key);
        if (existing) existing.bindsTo.push(stepId);
        else {
          fields.set(key, {
            key,
            label: decision.field?.label || label,
            kind: 'number',
            group: 'Guests',
            order: fields.size,
            required: false,
            defaultValue: wanted,
            options: [],
            validation: { min: 0, max: 30 },
            bindsTo: [stepId],
            exposure: 'variable',
          });
        }

        markDone(record);
        history.push(record);
        stuckOn = undefined;
        await settle(page, 3000);
        continue;
      }

      const control = controls.find((c) => c.ref === decision.ref);
      if (!control) {
        history.push(`tried to use a control that wasn't there (${decision.ref})`);
        continue;
      }

      const target = page.locator(`[data-mimic-ref="${control.ref}"]`).first();
      const label = control.name ?? control.placeholder ?? `control ${control.ref}`;

      /* "Never click day cells" is in the rules and gets ignored anyway, so it
         is enforced here instead. A clicked day is a date half-set — the site
         is now waiting for the second half — and the next turn sees a calendar
         and clicks another one. Ten turns go this way and the search never
         runs. Refusing costs one turn and says what to do instead. */
      const looksLikeADay =
        control.role === 'gridcell' ||
        /^\s*\d{1,2}\s*$/.test(label) ||
        /^[A-Z][a-z]+day,\s|\b\d{1,2}\s+\w+\s+20\d{2}\b/.test(label);

      /* Reopening the date box after the dates are in resets them: booking's
         range picker takes the next click as a new check-in, and a run that
         had September 18–22 correct ended up with the 22nd to the 23rd. */
      const isDateBox = /check-?in|check-?out|select dates|\bdates?\b/i.test(label);
      if (decision.action === 'click' && isDateBox && datesSet > 0) {
        history.push(
          `clicking “${label}” was refused — the dates are already set and reopening that box clears them. Run the search.`,
        );
        stuckOn = `click “${label}”`;
        continue;
      }

      if (decision.action === 'click' && looksLikeADay) {
        history.push(
          `clicking “${label}” was refused — days are not clicked one at a time. ` +
            'Use set_date on the check-in or check-out box with a YYYY-MM-DD value, or run the search.',
        );
        stuckOn = `click “${label}”`;
        continue;
      }

      // Same rule for dates: one that is already set stays set.
      const dateRecord = `set date ${decision.value}`;
      if (decision.action === 'set_date' && alreadyDone(dateRecord)) {
        history.push(`${dateRecord} is already done — pick the other date, or search`);
        stuckOn = dateRecord;
        continue;
      }

      onProgress?.(`${decision.action} “${label}”${decision.value ? ` with “${decision.value}”` : ''}`);

      /* Remember the value as a form field, so the finished automation is
         editable rather than frozen at whatever this one request asked for. */
      const fieldKey = decision.field?.key ? fieldKeyOf(decision.field.key) : undefined;

      const stepId = `ex_${nanoid(8)}`;
      const kind = (
        VALID_KINDS.has(decision.field?.kind as ControlKind)
          ? decision.field?.kind
          : control.tag === 'select'
            ? 'select'
            : control.role === 'combobox'
              ? 'combobox'
              : control.type === 'checkbox'
                ? 'checkbox'
                : 'text'
      ) as ControlKind;

      try {
        switch (decision.action) {
          case 'fill':
            await target.fill(decision.value ?? '', { timeout: 10_000 });
            break;
          case 'select':
            await target.selectOption({ label: decision.value ?? '' }, { timeout: 10_000 });
            break;
          case 'press':
            await target.press(decision.value || 'Enter', { timeout: 10_000 });
            break;
          case 'set_date': {
            /* A calendar is not a control you click — it is a month to page to
               and a cell to find. Left to itself the model clicks the date box,
               sees the same page, and clicks it again until its turns are gone. */
            const res = await setDate(page, target, decision.value);
            if (!res.ok) throw new Error(res.detail ?? 'the date would not go in');
            break;
          }
          default:
            await target.click({ timeout: 10_000 });
        }
      } catch (err) {
        /* An action that fails is retried by the model as readily as one that
           does nothing — and a date the site will not accept failed thirteen
           times in a row, ten minutes of it, before the turn budget ran out.
           Two goes is a fair test; after that the control is off the table. */
        const fails = (failures.get(label) ?? 0) + 1;
        failures.set(label, fails);
        if (fails >= 2 && control.name) exhausted.add(control.name);

        history.push(
          `${decision.action} on “${label}” didn't work: ${String(err).slice(0, 90)}` +
            (fails >= 2 ? ' — stop trying this one and use another way' : ''),
        );
        continue;
      }

      steps.push({
        id: stepId,
        seq: steps.length,
        ts: now + steps.length * 1000,
        type:
          decision.action === 'fill' || decision.action === 'set_date'
            ? 'input'
            : decision.action === 'select'
              ? 'select'
              : decision.action === 'press'
                ? 'press'
                : 'click',
        target: locatorFor(control, page.url()),
        value: decision.value,
        url: page.url(),
        delayBefore: 600,
        hints: decision.action === 'set_date' ? { isoDate: decision.value } : {},
        causedNavigation: decision.action === 'click',
        meta: {
          kind: decision.action === 'set_date' ? 'date' : kind,
          label: control.name,
          options: [],
          required: false,
        },
      });

      if (fieldKey && decision.value) {
        const existing = fields.get(fieldKey);
        if (existing) existing.bindsTo.push(stepId);
        else {
          fields.set(fieldKey, {
            key: fieldKey,
            label: decision.field?.label || control.name || fieldKey.replace(/_/g, ' '),
            kind,
            group: 'Details',
            order: fields.size,
            required: false,
            defaultValue: decision.value,
            options: [],
            validation: {},
            bindsTo: [stepId],
            exposure: 'variable',
          });
        }
      }

      if (decision.action === 'set_date') {
        markDone(dateRecord);
        datesSet += 1;
      }

      const record = `${decision.action} “${label}”${decision.value ? ` = “${decision.value}”` : ''}`;
      const repeats = history.filter((h) => h === record).length;
      stuckOn = repeats >= 1 ? record : undefined;
      if (repeats >= 2 && control.name) exhausted.add(control.name);
      history.push(record);

      await settle(page, 5000);
      await waitOutChallenge(page);
      // Acting often opens a panel or a modal over the next thing we need.
      await dismissConsent(page);

      /* The search has run. Stop here — anything done now happens on the
         results page and cannot change them, and the model does try: one run
         set the check-out date after searching, so the recording claimed a
         date the results were never for. */
      /* Only once the search has actually been run. Picking a city from an
         autocomplete can land on the results URL by itself, with none of the
         dates or counts applied — stopping there ends the run four steps in
         and calls the site's defaults an answer. */
      const ranSearch =
        decision.action === 'press' ||
        (decision.action === 'click' && /search|find|go\b|submit|show (results|homes|stays)/i.test(label));

      const landedOn = page.url();
      if (ranSearch && landedOn !== startUrl && /search|result|\/s\?|\bsrp\b/i.test(landedOn) && steps.length > 2) {
        return { steps, fields: [...fields.values()], finalUrl: landedOn };
      }
    }

    return {
      steps,
      fields: [...fields.values()],
      finalUrl: page.url(),
      failure: 'it ran out of steps before reaching the results',
    };
  } catch (err) {
    return { steps, fields: [...fields.values()], failure: String(err).slice(0, 160) };
  } finally {
    await session.close();
  }
}

import type { Page } from 'playwright';

/**
 * Counters — "2 adults, 1 child, 2 rooms".
 *
 * These are the single most common thing every other part of Mimic gets wrong,
 * for the same reason each time: there is no value to read or write. A stepper
 * is a number rendered as text between two buttons, so the recorder captures
 * four anonymous clicks, the compiler sees no input to make a field from, and
 * replay has nothing to set. The count silently stays at the site's default and
 * a search for a family of five returns rooms for one.
 *
 * Treating the whole widget as one control fixes all three at once: it can be
 * found by its label, read, and set to a number by clicking until it says so.
 */

export interface StepperInfo {
  /** Index in scan order — matches the `data-mimic-step` tag left on the page. */
  idx: number;
  label: string;
  value: number;
  canIncrease: boolean;
  canDecrease: boolean;
}

/**
 * Finds counter widgets by their shape rather than any site's markup.
 *
 * A "+" on its own is meaningless — pages are full of them. A + and a − sharing
 * a small ancestor with a number between them is a counter almost every time,
 * on every site, with no per-site knowledge at all.
 */
function scanSteppers(): StepperInfo[] {
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  const PLUS = /(^\s*[+＋]\s*$|increase|increment|\badd\b|\bplus\b|more)/i;
  const MINUS = /(^\s*[-−–—]\s*$|decrease|decrement|subtract|\bminus\b|\bless\b|remove)/i;

  const describe = (el: Element) =>
    clean(
      el.getAttribute('aria-label') ??
        el.getAttribute('title') ??
        el.getAttribute('data-testid') ??
        el.textContent,
    );

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
  };

  const disabled = (el: Element) =>
    (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true';

  document
    .querySelectorAll('[data-mimic-step],[data-mimic-plus],[data-mimic-minus]')
    .forEach((n) => {
      n.removeAttribute('data-mimic-step');
      n.removeAttribute('data-mimic-plus');
      n.removeAttribute('data-mimic-minus');
    });

  const BUTTONS = 'button, [role="button"], input[type="button"], a[role="button"]';
  const all = Array.from(document.querySelectorAll(BUTTONS)).filter(visible);
  const plusButtons = all.filter((b) => PLUS.test(describe(b)));

  const out: StepperInfo[] = [];
  const seen = new Set<Element>();

  for (const plus of plusButtons) {
    if (out.length >= 12) break;

    // Climb until an ancestor holds the matching "−" as well. Stop early: a
    // large ancestor holds every counter on the page and tells us nothing.
    let group: Element | null = null;
    let minus: Element | null = null;
    let node: Element | null = plus.parentElement;

    for (let up = 0; up < 5 && node; up += 1, node = node.parentElement) {
      const text = clean((node as HTMLElement).innerText);
      if (text.length > 220) break;
      const candidate = all.find((b) => b !== plus && node!.contains(b) && MINUS.test(describe(b)));
      if (candidate) {
        group = node;
        minus = candidate;
        break;
      }
    }

    if (!group || !minus || seen.has(group)) continue;
    seen.add(group);

    // The number itself: a numeric input, or the deepest element whose entire
    // text is a small integer.
    let value: number | null = null;
    let valueEl: Element | null = null;

    const numeric = group.querySelector('input[type="number"], input[inputmode="numeric"]');
    if (numeric && (numeric as HTMLInputElement).value !== '') {
      value = Number((numeric as HTMLInputElement).value);
      valueEl = numeric;
    } else {
      for (const el of Array.from(group.querySelectorAll('*'))) {
        if (el.children.length) continue;
        if (el === plus || el === minus || plus.contains(el) || minus.contains(el)) continue;
        const text = clean(el.textContent);
        if (/^\d{1,3}$/.test(text)) {
          value = Number(text);
          valueEl = el;
          break;
        }
      }
    }

    if (value === null) continue;

    /* The label is whatever the widget says once the machinery is taken out:
       "Adults 1 − +" is "Adults". Sites that put the label outside the group
       get it from the nearest preceding text instead. */
    let label = clean((group as HTMLElement).innerText);
    for (const button of [plus, minus]) {
      for (const part of [
        clean((button as HTMLElement).innerText),
        clean(button.getAttribute('aria-label')),
        clean(button.getAttribute('title')),
      ]) {
        if (part) label = label.split(part).join(' ');
      }
    }
    // The count itself, and any duplicate of it left by an off-screen copy.
    label = clean(label.replace(/\d+/g, ' ')).replace(/^[^\p{L}]+/u, '').slice(0, 60);

    /* Failing that, the increment button says what it increments: "Add adult",
       "Increase number of Rooms". Stripping the verb leaves the noun, which is
       exactly the name a person would use for the counter. */
    if (!label) {
      label = clean(describe(plus))
        .replace(/^(add|increase|increment|plus|more)\b/i, '')
        .replace(/\bnumber of\b/i, '')
        .replace(/\d+/g, ' ');
      label = clean(label).slice(0, 60);
    }

    if (!label) {
      let probe: Element | null = group.previousElementSibling ?? group.parentElement;
      for (let i = 0; i < 3 && probe && !label; i += 1) {
        const text = clean((probe as HTMLElement).innerText);
        if (text && text.length < 60) label = text;
        probe = probe.previousElementSibling;
      }
    }
    if (!label) continue;

    const idx = out.length;
    group.setAttribute('data-mimic-step', String(idx));
    plus.setAttribute('data-mimic-plus', String(idx));
    minus.setAttribute('data-mimic-minus', String(idx));
    if (valueEl) valueEl.setAttribute('data-mimic-count', String(idx));

    out.push({
      idx,
      label,
      value,
      canIncrease: !disabled(plus),
      canDecrease: !disabled(minus),
    });
  }

  return out;
}

/**
 * Clicks whatever opens an occupancy panel, so its counters exist to be read.
 *
 * `skip` steps past candidates already tried: the first thing on the page that
 * mentions guests is often a heading or a filter, and giving up after one wrong
 * guess is how a site with a perfectly ordinary occupancy panel gets reported
 * as having no counters at all.
 */
function clickCounterTrigger(skip: number): boolean {
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const WANTED =
    /(adult|child|infant|guest|room|passenger|travell?er|occupan|who\b|people|\d\s*(guest|room|adult|passenger))/i;

  const candidates = Array.from(
    document.querySelectorAll(
      'button, [role="button"], [data-testid*="occupancy" i], [data-testid*="guest" i], ' +
        '[data-testid*="passenger" i], [aria-haspopup]',
    ),
  ).filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 12) return false;
    const st = getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const text = clean(el.getAttribute('aria-label') ?? (el as HTMLElement).innerText);
    // Not the search button, and not a link off the page.
    return WANTED.test(text) && !/^(search|submit|go|apply|done)$/i.test(text);
  });

  /* Document order is already a decent ranking — the search box comes before
     the results — so this only lifts the things that announce themselves as
     the occupancy control, and leaves the rest alone. */
  const score = (el: Element) =>
    (el.hasAttribute('aria-haspopup') ? 2 : 0) +
    (/occupancy|guest|passenger|traveller|traveler/i.test(el.getAttribute('data-testid') ?? '') ? 2 : 0) +
    (el.closest('form') ? 1 : 0);
  candidates.sort((a, b) => score(b) - score(a));

  const target = candidates[skip] as HTMLElement | undefined;
  if (!target) return false;
  target.click();
  return true;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

/** Does this counter's label mean the thing we were asked to set? */
function labelMatches(label: string, wanted: string): boolean {
  const a = norm(label);
  const b = norm(wanted);
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  // "Children" vs "child", "Rooms" vs "room".
  const stem = (s: string) => s.replace(/(ren|s|es)$/, '');
  return stem(a) === stem(b) || stem(a).includes(stem(b)) || stem(b).includes(stem(a));
}

export async function readSteppers(page: Page): Promise<StepperInfo[]> {
  return page.evaluate(scanSteppers).catch(() => [] as StepperInfo[]);
}

/**
 * Makes counters visible, opening the panel that holds them if needed.
 *
 * Sites hide occupancy behind a summary box, and the panel closes again the
 * moment anything else is clicked — so this is checked every time rather than
 * once at the start.
 */
export async function revealSteppers(page: Page, wanted?: string): Promise<StepperInfo[]> {
  /* "Some counters are showing" is not the same as "the counter we need is
     showing". A page can have a rooms stepper in a filter sidebar and adults
     only inside the occupancy panel, so stopping at the first one found leaves
     the guest count untouched — silently, which is the whole problem. */
  const enough = (found: StepperInfo[]) =>
    found.length > 0 && (!wanted || found.some((s) => labelMatches(s.label, wanted)));

  let found = await readSteppers(page);
  if (enough(found)) return found;

  for (let attempt = 0; attempt < 4 && !enough(found); attempt += 1) {
    const clicked = await page.evaluate(clickCounterTrigger, attempt).catch(() => false);
    if (!clicked) break;
    await page.waitForTimeout(800);
    found = await readSteppers(page);
  }
  return found;
}

export interface StepperResult {
  ok: boolean;
  value?: number;
  detail: string;
}

/**
 * Sets a counter to an exact number.
 *
 * Every click is verified against a fresh read, because half these widgets
 * re-render on change and the button we just used no longer exists. Clicking
 * blind N times is what produces "3 adults" that is really 1.
 */
export async function setStepper(page: Page, label: string, target: number): Promise<StepperResult> {
  if (!Number.isFinite(target) || target < 0) return { ok: false, detail: `“${target}” is not a count` };

  let steppers = await revealSteppers(page, label);
  if (!steppers.length) return { ok: false, detail: 'no counters on this page' };

  let match = steppers.find((s) => labelMatches(s.label, label));
  if (!match) {
    return {
      ok: false,
      detail: `no counter called “${label}” (saw ${steppers.map((s) => s.label).join(', ') || 'none'})`,
    };
  }

  let stalled = 0;

  for (let i = 0; i < 20; i += 1) {
    if (match.value === target) return { ok: true, value: match.value, detail: `${label} = ${target}` };

    const up = match.value < target;
    if (up && !match.canIncrease) {
      return { ok: false, value: match.value, detail: `${label} will not go above ${match.value}` };
    }
    if (!up && !match.canDecrease) {
      return { ok: false, value: match.value, detail: `${label} will not go below ${match.value}` };
    }

    const before = match.value;
    const button = page.locator(`[data-mimic-${up ? 'plus' : 'minus'}="${match.idx}"]`).first();
    await button.click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(280);

    steppers = await revealSteppers(page, label);
    const next = steppers.find((s) => labelMatches(s.label, label));
    if (!next) return { ok: false, value: before, detail: `“${label}” disappeared while being set` };
    match = next;

    if (match.value === before) {
      stalled += 1;
      if (stalled >= 2) {
        return { ok: false, value: before, detail: `${label} stayed at ${before} — the site refused` };
      }
    } else {
      stalled = 0;
    }
  }

  return { ok: false, value: match.value, detail: `gave up with ${label} at ${match.value}` };
}

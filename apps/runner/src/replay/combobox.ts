import type { Locator, Page } from 'playwright';
import type { RecordedStep } from '@mimic/schema';
import { resolve } from './resolve.js';

/**
 * Typeahead handling.
 *
 * "Dhaka" is not a value a site accepts — it's a query. The user typed it, the
 * site offered "Dhaka, Bangladesh — Hazrat Shahjalal Intl (DAC)", and the user
 * clicked that. Replay has to do the same dance and, crucially, pick the right
 * suggestion for a value the recording never saw.
 */

const OPTION_SELECTOR =
  '[role="option"], [role="menuitem"], li, [class*="option" i], [class*="item" i], [class*="suggestion" i]';

/**
 * Finds the suggestion list that just opened, wherever the site chose to put it.
 *
 * Class-name matching alone misses too much — plenty of sites label the panel
 * only with a `data-testid`, or nothing at all. So this scores every visible
 * container by what it *is*: a box near the input holding several option-shaped
 * rows. The winner is tagged so Playwright can click inside it.
 */
const FIND_DROPDOWN = function findDropdown(inputRect: { x: number; y: number; w: number; h: number } | null) {
  const MARK = 'data-mimic-dropdown';
  document.querySelectorAll(`[${MARK}]`).forEach((n) => n.removeAttribute(MARK));

  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 24) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
  };

  const OPTIONS = '[role="option"], [role="menuitem"], li, [class*="option" i], [class*="item" i], [class*="suggestion" i]';

  let best: { el: Element; score: number; texts: string[] } | null = null;

  for (const el of Array.from(document.querySelectorAll('ul, ol, div, section, [role="listbox"], [role="menu"]'))) {
    if (!visible(el)) continue;

    // Prefer rows the site explicitly marked as options. Grouped dropdowns put
    // section headings ("Domestic cities") in the same markup as the entries,
    // and only the role tells them apart.
    const explicit = Array.from(el.querySelectorAll('[role="option"]')).filter(visible);
    const rows = explicit.length
      ? explicit
      : Array.from(el.querySelectorAll(OPTIONS)).filter(
          (o) =>
            visible(o) &&
            !o.querySelector(OPTIONS) &&
            // A heading labels a list; it never contains something to click.
            (o.querySelector('a, button, [role="option"], input') !== null ||
              o.getAttribute('role') === 'option' ||
              (o as HTMLElement).onclick !== null ||
              o.tagName === 'LI' ||
              o.tagName === 'OPTION'),
        );
    if (rows.length < 2 || rows.length > 60) continue;

    const texts = rows.map((r) => clean((r as HTMLElement).innerText)).filter((t) => t && t.length < 120);
    if (texts.length < 2) continue;

    const rect = el.getBoundingClientRect();
    let score = Math.min(rows.length, 12);

    const role = el.getAttribute('role');
    if (role === 'listbox' || role === 'menu') score += 6;

    const hint = `${el.className} ${el.id} ${el.getAttribute('data-testid') ?? ''}`.toLowerCase();
    if (/autocomplete|suggestion|typeahead|dropdown|combobox|results|options/.test(hint)) score += 5;

    // A suggestion panel sits right under the box you typed in.
    if (inputRect) {
      const below = rect.top >= inputRect.y - 8 && rect.top < inputRect.y + inputRect.h + 260;
      const aligned = Math.abs(rect.left - inputRect.x) < 220;
      if (below) score += 5;
      if (aligned) score += 3;
    }

    // Site navigation also looks like a list of rows; it just isn't near us.
    if (el.closest('nav, header, footer, [role="navigation"]')) score -= 8;

    if (!best || score > best.score) best = { el, score, texts };
  }

  if (!best || best.score < 6) return null;
  best.el.setAttribute(MARK, '1');
  return best.texts;
};

export interface ComboResult {
  ok: boolean;
  chosen?: string;
  detail?: string;
  /** The box that was filled, so the caller can check it again before submitting. */
  input?: Locator;
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Clicks the option by its visible text, anywhere on screen below the input.
 *
 * This is the escape hatch for dropdowns whose structure defeats enumeration:
 * grouped lists, virtualised rows, custom widgets with no roles. It finds the
 * smallest visible element whose text matches, marks it, and clicks that.
 */
async function clickOptionByText(
  page: Page,
  want: string,
  inputRect: { x: number; y: number; w: number; h: number } | null,
): Promise<string | null> {
  const found = await page
    .evaluate(
      ({ wanted, rect }) => {
        const MARK = 'data-mimic-option';
        document.querySelectorAll(`[${MARK}]`).forEach((n) => n.removeAttribute(MARK));

        const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
        const target = wanted.toLowerCase();

        const visible = (el: Element) => {
          const r = el.getBoundingClientRect();
          if (r.width < 30 || r.height < 12) return false;
          const st = getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
        };

        let best: { el: Element; text: string; area: number } | null = null;

        for (const el of Array.from(document.querySelectorAll('li, a, button, div, span, p, td'))) {
          if (!visible(el)) continue;
          // The smallest element containing the text is the row itself, not its
          // container — so skip anything whose child also matches.
          const text = clean((el as HTMLElement).innerText);
          if (!text || text.length > 140) continue;

          const lower = text.toLowerCase();
          if (!lower.includes(target)) continue;

          const r = el.getBoundingClientRect();
          // Must be part of the panel that opened, not a heading elsewhere.
          if (rect && (r.top < rect.y - 20 || r.top > rect.y + rect.h + 420)) continue;

          const area = r.width * r.height;
          if (!best || area < best.area) best = { el, text, area };
        }

        if (!best) return null;
        best.el.setAttribute(MARK, '1');
        return best.text;
      },
      { wanted: want, rect: inputRect },
    )
    .catch(() => null);

  if (!found) return null;

  const clicked = await page
    .locator('[data-mimic-option="1"]')
    .first()
    .click({ timeout: 5000 })
    .then(() => true)
    .catch(() => false);

  return clicked ? found : null;
}

/** Score how well an option matches what the user asked for. */
function scoreOption(optionText: string, want: string): number {
  const o = optionText.toLowerCase().trim();
  const w = want.toLowerCase().trim();
  if (!o) return -1;
  if (o === w) return 100;
  if (o.startsWith(w)) return 90;
  // Airport/city pickers hide the code in brackets — "(DAC)".
  if (new RegExp(`\\(${w}\\)`, 'i').test(o)) return 88;
  if (new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(o)) return 80;
  if (o.includes(w)) return 70;

  // Fall back to token overlap so "Bangkok Thailand" still matches "Bangkok".
  const wTokens = w.split(/\s+/).filter(Boolean);
  const hits = wTokens.filter((t) => o.includes(t)).length;
  return hits ? 40 + (hits / wTokens.length) * 20 : -1;
}

/**
 * Polls until the suggestion panel reflects the query.
 *
 * Returning the first panel that appears is a race: on a slow fetch that panel
 * is still the focus-time default (trending, recent searches), and matching
 * against it silently picks the wrong thing — or nothing.
 */
async function waitForDropdownTexts(
  page: Page,
  inputRect: { x: number; y: number; w: number; h: number } | null,
  timeoutMs: number,
  want: string,
  initialTexts: string[],
): Promise<string[] | null> {
  const deadline = Date.now() + timeoutMs;
  const before = initialTexts.join('|');
  const target = want.toLowerCase();
  let latest: string[] | null = null;

  while (Date.now() < deadline) {
    const texts = await page.evaluate(FIND_DROPDOWN, inputRect).catch(() => null);
    if (texts && texts.length) {
      latest = texts;
      // Best case: something in the panel is clearly an answer to the query.
      if (texts.some((t) => t.toLowerCase().includes(target))) return texts;
      // Good enough: the panel changed, so it is this query's result.
      if (before && texts.join('|') !== before) return texts;
      // No default panel existed, so anything here is the query's result —
      // but give a slow fetch a moment to replace a first partial render.
      if (!before && Date.now() > deadline - timeoutMs + 1800) return texts;
    }
    await page.waitForTimeout(250);
  }
  return latest;
}

export async function fillCombobox(
  page: Page,
  step: RecordedStep,
  value: unknown,
): Promise<ComboResult> {
  const want = String(value ?? '').trim();
  if (!want) return { ok: false, detail: 'No value supplied for this field.' };
  if (!step.target) return { ok: false, detail: 'The recording has no input element for this field.' };

  const found = await resolve(page, step.target, { timeoutMs: 12_000 });
  if (!found) return { ok: false, detail: 'Could not find the search box on the page.' };

  const input = found.locator;
  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ timeout: 8000 }).catch(() => {});

  // Many boxes open a default panel on focus — recent searches, trending
  // destinations. Remember it, so we can tell when the query's own results
  // have actually replaced it.
  const box0 = await input.boundingBox().catch(() => null);
  const initialTexts =
    (await page
      .evaluate(FIND_DROPDOWN, box0 ? { x: box0.x, y: box0.y, w: box0.width, h: box0.height } : null)
      .catch(() => null)) ?? [];

  // Clear whatever the site pre-filled, then type like a person so the
  // site's own debounce and suggestion fetch actually fire.
  await input.fill('').catch(async () => {
    await input.press('Control+a').catch(() => {});
    await input.press('Backspace').catch(() => {});
  });
  await input.pressSequentially(want, { delay: 55 }).catch(async () => {
    await input.fill(want).catch(() => {});
  });

  // Confirm the text landed. Controlled React inputs, overlays stealing focus
  // and duplicate hidden fields all cause silent no-ops here — and a query that
  // never arrived means a suggestion list that never updates.
  const settled = await input.inputValue().catch(() => '');
  if (!settled.toLowerCase().includes(want.toLowerCase().slice(0, Math.min(4, want.length)))) {
    await input.click({ timeout: 4000 }).catch(() => {});
    await page.keyboard.press('Control+A').catch(() => {});
    await page.keyboard.type(want, { delay: 70 }).catch(() => {});
  }

  // Suggestions are fetched, not instant.
  await page.waitForTimeout(400);

  // Where the box sits, so a panel below it can be recognised as *its* panel.
  const box = await input.boundingBox().catch(() => null);
  const inputRect = box ? { x: box.x, y: box.y, w: box.width, h: box.height } : null;

  // Give the site time to fetch suggestions — and specifically, time for the
  // results of *this* query to replace whatever was showing on focus.
  const texts = await waitForDropdownTexts(page, inputRect, 9000, want, initialTexts);
  if (!texts) {
    // Plenty of comboboxes accept a plain value plus Enter.
    await input.press('Enter').catch(() => {});
    return { ok: true, chosen: want, input, detail: 'No suggestion list appeared — submitted the typed value.' };
  }

  let best: { index: number; score: number; text: string } | null = null;
  for (let index = 0; index < texts.length; index += 1) {
    const score = scoreOption(texts[index], want);
    if (!best || score > best.score) best = { index, score, text: texts[index] };
  }

  if (!best || best.score < 0) {
    // The rows we enumerated weren't the real entries — grouped dropdowns nest
    // the clickable ones deeper than any row scan reaches. Fall back to what a
    // person would do: click the words on screen.
    const byText = await clickOptionByText(page, want, inputRect);
    if (byText) {
      await page.waitForTimeout(300);
      return { ok: true, chosen: byText, input, detail: 'Matched by the option text on screen.' };
    }

    await input.press('Enter').catch(() => {});
    return {
      ok: true,
      chosen: want,
      input,
      detail: `None of the ${texts.length} suggestions matched — submitted the typed value. Saw: ${texts
        .slice(0, 4)
        .map((t) => `“${t.slice(0, 110)}”`)
        .join(' / ')}`,
    };
  }

  const chosen: { index: number; score: number; text: string } = best;
  const options = page
    .locator('[data-mimic-dropdown="1"]')
    .locator(OPTION_SELECTOR)
    .filter({ hasNot: page.locator(OPTION_SELECTOR) });

  const target = options.nth(chosen.index);
  const clicked = await target
    .click({ timeout: 6000 })
    .then(() => true)
    .catch(() => false);

  if (!clicked) {
    // Fall back to matching the option by its text.
    await page
      .locator('[data-mimic-dropdown="1"]')
      .getByText(chosen.text, { exact: false })
      .first()
      .click({ timeout: 5000 })
      .catch(async () => {
        await input.press('Enter').catch(() => {});
      });
  }

  await page.waitForTimeout(300);

  /* Did the site actually take it?
   *
   * Clicking a suggestion can land on a wrapper that looks right and does
   * nothing — the panel closes, the value never binds, and the box is left
   * empty. Nothing errors, so the run reports a confident match and the site
   * then searches somewhere else entirely: a hotel search for Cox's Bazar
   * coming back with New Delhi. The only way to know is to read the box. */
  const after = (await input.inputValue().catch(() => '')).trim();
  const took = valueLooksApplied(after, want, chosen.text);

  if (!took) {
    /* Keyboard selection is what the widget is built for, and it binds through
       the site's own handlers rather than a synthetic click. */
    await input.click({ timeout: 4000 }).catch(() => {});
    for (let i = 0; i <= chosen.index && i < 12; i += 1) {
      await page.keyboard.press('ArrowDown').catch(() => {});
      await page.waitForTimeout(60);
    }
    await page.keyboard.press('Enter').catch(() => {});
    await page.waitForTimeout(400);

    const retried = (await input.inputValue().catch(() => '')).trim();
    if (!valueLooksApplied(retried, want, chosen.text)) {
      return {
        ok: false,
        chosen: chosen.text,
        detail:
          `Picked “${chosen.text}” but the box still reads “${retried || 'empty'}” — ` +
          'the site did not accept the selection.',
      };
    }
    return { ok: true, chosen: chosen.text, input, detail: 'Selected with the keyboard.' };
  }

  return {
    ok: true,
    chosen: chosen.text,
    input,
    detail: chosen.score >= 80 ? undefined : `Closest match to “${want}” out of ${texts.length} suggestions.`,
  };
}

/**
 * Does the box now hold the thing that was picked?
 *
 * Deliberately lenient about form: sites rewrite "Cox's Bazar" into "Cox's
 * Bazar, Bangladesh", and some move the value into a chip and blank the input
 * entirely. What it will not accept is a box that has gone back to empty while
 * the dropdown is closed, which is the failure that matters.
 */
function valueLooksApplied(current: string, want: string, chosen: string): boolean {
  if (!current) return false;
  const normal = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const box = normal(current);
  const first = normal(want).split(' ')[0] ?? '';
  return box.includes(first) || normal(chosen).includes(box) || box.includes(normal(chosen));
}

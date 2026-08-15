import type { Locator, Page } from 'playwright';
import type { RecordedStep } from '@mimic/schema';
import { resolve } from './resolve';

/**
 * Date picking.
 *
 * Almost no travel or booking site uses <input type="date">. They render a
 * custom grid, so replaying "the user clicked 12 September" with a different
 * date means finding the right cell — which usually means paging the calendar
 * to the right month first.
 *
 * Three strategies, cheapest first:
 *   1. Rewrite the recorded selector's date (`[data-date="2025-09-12"]`).
 *   2. Match the cell by its accessible name ("12 September 2025").
 *   3. Page the month header until it matches, then click the day number.
 */

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

export interface DateTarget {
  iso: string;
  year: number;
  monthIndex: number; // 0-based
  day: number;
}

export function parseDate(input: unknown): DateTarget | null {
  if (input === null || input === undefined || input === '') return null;
  const raw = String(input).trim();

  // Relative shorthands are genuinely useful for scheduled reruns.
  const relative = raw.match(/^today([+-]\d+)?$/i);
  let d: Date;
  if (relative) {
    d = new Date();
    d.setDate(d.getDate() + Number.parseInt(relative[1] ?? '0', 10));
  } else {
    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return null;
    d = new Date(parsed);
  }

  return {
    iso: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    year: d.getFullYear(),
    monthIndex: d.getMonth(),
    day: d.getDate(),
  };
}

/** Every ISO-ish date string embedded in a recorded selector. */
function isoInSelector(value: string): string | null {
  const m = value.match(/\d{4}-\d{2}-\d{2}/);
  return m ? m[0] : null;
}

/** Strategy 1 — swap the date inside the selector the recorder captured. */
async function bySelectorRewrite(page: Page, step: RecordedStep, want: DateTarget): Promise<Locator | null> {
  const target = step.secondaryTarget ?? step.target;
  if (!target) return null;

  for (const c of target.candidates) {
    const recordedIso = isoInSelector(c.value);
    if (!recordedIso || !['css', 'testid', 'id', 'name'].includes(c.strategy)) continue;

    const rewritten = c.value.replaceAll(recordedIso, want.iso);
    const loc = page.locator(rewritten);
    if ((await loc.count().catch(() => 0)) > 0) return loc.first();
  }

  return byDateAttribute(page, want);
}

/**
 * Any attribute anywhere whose value is the date we want.
 *
 * Pickers label their cells in their own dialect — `data-date`, `data-selenium-date`,
 * `data-testid="2026-09-18"`, `datetime`. Rather than collect dialects forever,
 * look for the date itself: an element carrying "2026-09-18" in an attribute is
 * that day, on every site, and it is exact — which the fallbacks are not. Paging
 * a calendar and clicking the cell that reads "18" gets the 18th of whatever
 * month happened to be on screen.
 */
async function byDateAttribute(page: Page, want: DateTarget): Promise<Locator | null> {
  const marked = await page
    .evaluate((iso: string) => {
      document.querySelectorAll('[data-mimic-day]').forEach((n) => n.removeAttribute('data-mimic-day'));
      const slashed = iso.replace(/-/g, '/');
      for (const el of Array.from(document.querySelectorAll('*'))) {
        for (const attr of Array.from(el.attributes)) {
          if (attr.name === 'data-mimic-day') continue;
          const v = attr.value.trim();
          if (v !== iso && v !== slashed) continue;
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          if (el.getAttribute('aria-disabled') === 'true') continue;
          el.setAttribute('data-mimic-day', '1');
          return true;
        }
      }
      return false;
    }, want.iso)
    .catch(() => false);

  return marked ? page.locator('[data-mimic-day]').first() : null;
}

/** Strategy 2 — the cell's accessible name usually spells the date out. */
async function byAccessibleName(page: Page, want: DateTarget): Promise<Locator | null> {
  const month = MONTHS[want.monthIndex];
  const monthTitle = month[0].toUpperCase() + month.slice(1);
  const short = monthTitle.slice(0, 3);

  const patterns = [
    new RegExp(`\\b${want.day}\\b[^0-9]{0,12}${monthTitle}[^0-9]{0,12}${want.year}`, 'i'),
    new RegExp(`${monthTitle}[^0-9]{0,12}\\b${want.day}\\b[^0-9]{0,12}${want.year}`, 'i'),
    new RegExp(`\\b${want.day}\\b[^0-9]{0,12}${short}[^0-9]{0,12}${want.year}`, 'i'),
  ];

  for (const re of patterns) {
    const loc = page.getByLabel(re);
    if ((await loc.count().catch(() => 0)) > 0) return loc.first();
    const byTitle = page.getByTitle(re);
    if ((await byTitle.count().catch(() => 0)) > 0) return byTitle.first();
    const byRole = page.getByRole('gridcell', { name: re });
    if ((await byRole.count().catch(() => 0)) > 0) return byRole.first();
  }
  return null;
}

/** Reads whatever month/year the calendar is currently showing. */
async function currentMonth(page: Page): Promise<{ monthIndex: number; year: number } | null> {
  const text = await page
    .locator(
      '[class*="calendar" i] [class*="month" i], [class*="datepick" i] [class*="month" i], ' +
        '[role="grid"] [aria-live], [class*="calendar" i] h2, [class*="calendar" i] h3, ' +
        '[class*="DayPicker" i] [class*="caption" i]',
    )
    .first()
    .innerText()
    .catch(() => '');

  /* No caption matched a known class name. Read the picker itself: the month
     and year are written on it somewhere, and "September 2026" in the visible
     text is unambiguous however the site names its elements. */
  const haystack =
    text ||
    (await page
      .locator('[role="grid"], [class*="calendar" i], [class*="datepick" i], [aria-modal="true"]')
      .first()
      .innerText()
      .catch(() => ''));

  if (!haystack) return null;

  const lower = haystack.toLowerCase();
  const pair = lower.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(20\d{2})\b/,
  );
  if (pair) {
    const monthIndex = MONTHS.findIndex((m) => m.startsWith(pair[1].slice(0, 3)));
    if (monthIndex !== -1) return { monthIndex, year: Number.parseInt(pair[2], 10) };
  }

  const monthIndex = MONTHS.findIndex((m) => lower.includes(m) || lower.includes(m.slice(0, 3)));
  const yearMatch = lower.match(/\b(20\d{2})\b/);
  if (monthIndex === -1 || !yearMatch) return null;
  return { monthIndex, year: Number.parseInt(yearMatch[1], 10) };
}

/** Strategy 3 — page the calendar to the right month, then click the day. */
async function byPaging(page: Page, want: DateTarget): Promise<Locator | null> {
  const nextBtn = page
    .locator(
      'button[aria-label*="next" i], [class*="next" i][role="button"], button[class*="next" i], ' +
        '[data-testid*="next" i], [aria-label*="forward" i]',
    )
    .first();
  const prevBtn = page
    .locator(
      'button[aria-label*="prev" i], [class*="prev" i][role="button"], button[class*="prev" i], ' +
        '[data-testid*="prev" i], [aria-label*="back" i]',
    )
    .first();

  const wantOrdinal = want.year * 12 + want.monthIndex;
  let onRightMonth = false;

  for (let i = 0; i < 24; i += 1) {
    const now = await currentMonth(page);
    if (!now) break;
    const nowOrdinal = now.year * 12 + now.monthIndex;
    if (nowOrdinal === wantOrdinal) {
      onRightMonth = true;
      break;
    }

    const btn = nowOrdinal < wantOrdinal ? nextBtn : prevBtn;
    if (!(await btn.isVisible().catch(() => false))) break;
    await btn.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(220);

    // Paging may have rendered the month we want with a date attribute on it.
    const exact = await byDateAttribute(page, want);
    if (exact) return exact;
  }

  /* Refuse rather than guess. This strategy finds "the cell that says 18" —
     which in the wrong month is the wrong day, and a booking made for the
     wrong month is worse than one that reported it could not set the date. */
  if (!onRightMonth) return null;

  // Click the day number, but only inside the calendar and never on a
  // disabled/outside-month cell.
  const dayCell = page
    .locator(
      `[role="gridcell"]:not([aria-disabled="true"]), td:not([class*="disabled" i]), ` +
        `[class*="day" i]:not([class*="disabled" i]):not([class*="outside" i])`,
    )
    .filter({ hasText: new RegExp(`^\\s*${want.day}\\s*$`) });

  if ((await dayCell.count().catch(() => 0)) > 0) return dayCell.first();
  return null;
}

/**
 * Makes sure a calendar is actually on screen before looking for a day in it.
 *
 * Every cell-finding strategy assumes the picker is open. The recorded target
 * is the day cell the person clicked — an element that no longer exists — so
 * resolving it fails, nothing gets clicked, and the search for "12 September"
 * happens against a page with no calendar on it at all. Opening the thing
 * first is the step that was missing.
 */
async function ensurePickerOpen(page: Page): Promise<boolean> {
  const calendar = page.locator(
    '[role="grid"]:visible, [class*="calendar" i]:visible, [class*="datepick" i]:visible, ' +
      '[data-testid*="datepicker" i]:visible, [class*="DayPicker" i]:visible',
  );
  if ((await calendar.count().catch(() => 0)) > 0) return true;

  // Whatever a person would click to bring one up.
  const openers = [
    '[data-testid*="date" i]',
    '[data-testid*="searchbox-dates" i]',
    'button[aria-label*="date" i]',
    '[class*="date" i][role="button"]',
    'input[name*="checkin" i]',
    'input[name*="depart" i]',
    '[placeholder*="date" i]',
  ];

  for (const selector of openers) {
    const opener = page.locator(selector).first();
    if (!(await opener.isVisible({ timeout: 200 }).catch(() => false))) continue;
    await opener.click({ timeout: 4000 }).catch(() => {});
    await page.waitForTimeout(500);
    if ((await calendar.count().catch(() => 0)) > 0) return true;
  }
  return false;
}

/**
 * Types the date instead of picking it.
 *
 * Works on a plain text box wearing a picker, and it is the only thing left
 * when the picker will not open at all — which happens whenever a site's
 * scripts do not run for us, however well the page appears to have loaded.
 */
async function typeDate(
  page: Page,
  locator: Locator | null,
  want: DateTarget,
): Promise<PickDateResult | null> {
  if (!locator) return null;

  const display = [
    want.iso,
    `${String(want.day).padStart(2, '0')}/${String(want.monthIndex + 1).padStart(2, '0')}/${want.year}`,
    `${String(want.monthIndex + 1).padStart(2, '0')}/${String(want.day).padStart(2, '0')}/${want.year}`,
  ];

  for (const text of display) {
    const typed = await locator
      .fill(text, { timeout: 5000 })
      .then(() => true)
      .catch(() => false);
    if (!typed) continue;

    await page.waitForTimeout(400);
    const held = await locator.inputValue().catch(() => '');
    if (!held.trim()) continue;

    // A picker that opened on focus needs dismissing, or it covers the page.
    await page.keyboard.press('Escape').catch(() => {});
    return { ok: true, strategy: 'typed', detail: `${want.iso} (typed as “${text}”)` };
  }

  return null;
}

export interface PickDateResult {
  ok: boolean;
  strategy?: 'native' | 'selector' | 'accessible-name' | 'paging' | 'typed' | 'recorded';
  detail?: string;
}

/**
 * Set a date field to `value`, whatever widget the site uses.
 * `opener` is the recorded step that opened the picker, if there was one.
 */
export async function pickDate(
  page: Page,
  step: RecordedStep,
  value: unknown,
): Promise<PickDateResult> {
  const found = step.target ? await resolve(page, step.target, { timeoutMs: 4000 }) : null;
  return setDate(page, found?.locator ?? null, value, step);
}

/**
 * The same date logic, driven by a live locator instead of a recording.
 *
 * The explorer has an element in its hand and no recorded step to rewrite, so
 * it could not use any of this — and re-implementing "page the calendar to
 * September" a second time would have meant two date pickers to keep working.
 */
export async function setDate(
  page: Page,
  opener: Locator | null,
  value: unknown,
  step?: RecordedStep,
): Promise<PickDateResult> {
  const want = parseDate(value);
  if (!want) return { ok: false, detail: `“${String(value)}” is not a date I can read.` };

  // Native input — by far the easiest path.
  const nativeTarget = opener ? { locator: opener } : null;
  if (nativeTarget) {
    const isNative = await nativeTarget.locator
      .evaluate((el) => (el as HTMLInputElement).type === 'date')
      .catch(() => false);
    if (isNative) {
      await nativeTarget.locator.fill(want.iso);
      return { ok: true, strategy: 'native', detail: want.iso };
    }
    // Open the picker before hunting for cells.
    await nativeTarget.locator.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(350);
  }

  const opened = await ensurePickerOpen(page);

  /* No calendar came up. Every strategy below hunts for cells inside one, and
     on a page whose scripts never ran there are none to find — so they each
     run their timeouts out in turn and a single date costs a minute. Typing it
     is the only thing that can still work here. */
  if (!opened) {
    const typed = await typeDate(page, nativeTarget?.locator ?? null, want);
    if (typed) return typed;
    return { ok: false, detail: `No date picker opened, and ${want.iso} could not be typed in.` };
  }

  const rewritten = step ? await bySelectorRewrite(page, step, want) : await byDateAttribute(page, want);
  if (rewritten) {
    await rewritten.click({ timeout: 6000 });
    return { ok: true, strategy: 'selector', detail: want.iso };
  }

  const named = await byAccessibleName(page, want);
  if (named) {
    await named.click({ timeout: 6000 });
    return { ok: true, strategy: 'accessible-name', detail: want.iso };
  }

  const paged = await byPaging(page, want);
  if (paged) {
    await paged.click({ timeout: 6000 });
    return { ok: true, strategy: 'paging', detail: want.iso };
  }

  /* Last resort: type it. The cell hunt can fail even with a calendar open —
     an unfamiliar layout, a month it will not page to — and the site usually
     accepts the date perfectly well as text. */
  const typed = await typeDate(page, nativeTarget?.locator ?? null, want);
  if (typed) return typed;

  return { ok: false, detail: `Could not find ${want.iso} in the date picker.` };
}

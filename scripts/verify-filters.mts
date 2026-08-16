/**
 * Confirms what a filter code actually does, by letting the site say so.
 *
 * Reading codes off the page pairs them with whatever label happens to sit
 * nearby, which is a guess. Applying one and asking the site which box it
 * ticked is not. An invented `nflt` token does not fail loudly — it returns an
 * unfiltered page that looks perfectly correct — so every code shipped in a
 * profile is checked here first.
 *
 *   npx tsx scripts/verify-filters.mts
 */
import { launchSession, settle } from '../apps/runner/src/replay/browser.ts';

const BASE =
  'https://www.booking.com/searchresults.html?ss=Cox%27s+Bazar&checkin=2026-08-27&checkout=2026-09-07&group_adults=2&group_children=0&no_rooms=1';

const CANDIDATES = [
  'hotelfacility=433',
  'hotelfacility=107',
  'hotelfacility=2',
  'hotelfacility=146',
  'hotelfacility=54',
  'roomfacility=11',
  'roomfacility=38',
  'roomfacility=17',
  'mealplan=1',
  'fc=2',
  'oos=1',
  'class=5',
  'class=4',
  'ht_id=204',
  'ht_id=206',
  'review_score=80',
  'review_score=90',
];

const session = await launchSession({});

for (const code of CANDIDATES) {
  const url = `${BASE}&nflt=${encodeURIComponent(code)}`;
  await session.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {});
  await settle(session.page).catch(() => {});
  await session.page.waitForTimeout(2500);

  const answer = await session.page
    .evaluate(() => {
      const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      /* The site marks the applied filter itself. Whatever it checked is what
         the code means — no inference on our side. */
      const checked = Array.from(
        document.querySelectorAll('input[type="checkbox"]:checked, [aria-checked="true"]'),
      )
        .map((el) => clean((el.closest('label') as HTMLElement | null)?.innerText))
        .filter((t) => t && t.length < 60);

      const count = clean(
        (document.querySelector('h1, [data-testid="stays-title"], [aria-live]') as HTMLElement | null)
          ?.innerText,
      ).slice(0, 70);

      return { checked: Array.from(new Set(checked)).slice(0, 4), count };
    })
    .catch(() => ({ checked: [] as string[], count: '' }));

  console.log(`${code.padEnd(20)} → ${answer.checked.join(' | ') || '(nothing ticked)'}`);
  console.log(`${''.padEnd(20)}   ${answer.count}`);
}

await session.close();

/**
 * Reads a site's own filter codes off its results page.
 *
 * Booking expresses every filter as an `nflt` token — `class=5`,
 * `hotelfacility=433` — and inventing one does not fail loudly: it returns an
 * empty page, or worse, an unfiltered one that looks right. So the codes come
 * from the site rather than from memory.
 *
 *   npx tsx scripts/probe-filters.mts booking
 *   npx tsx scripts/probe-filters.mts gozayaan
 */
import { launchSession, settle } from '../apps/runner/src/replay/browser.ts';

const which = (process.argv[2] ?? 'booking').toLowerCase();

const URLS: Record<string, string> = {
  booking:
    'https://www.booking.com/searchresults.html?ss=Cox%27s+Bazar&checkin=2026-08-27&checkout=2026-09-07&group_adults=2&group_children=0&no_rooms=1',
  gozayaan: 'https://gozayaan.com/flight/list?adult=1&child=0&infant=0&cabin_class=Economy&trips=DAC,BKK,2026-10-05',
};

const session = await launchSession({});
await session.page.goto(URLS[which], { waitUntil: 'domcontentloaded', timeout: 60_000 });
await settle(session.page).catch(() => {});
await session.page.waitForTimeout(6000);

const found = await session.page.evaluate(() => {
  const out: { label: string; code: string; where: string }[] = [];
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().slice(0, 60);

  /* Booking puts the token in the checkbox id or in the filter link's href.
     Both are read, because which one is present varies by session. */
  for (const el of Array.from(document.querySelectorAll('[data-filters-item], [id*="filter" i] input, a[href*="nflt"]'))) {
    const id = el.getAttribute('data-filters-item') || el.getAttribute('id') || '';
    const href = el.getAttribute('href') || '';
    const fromHref = href.match(/nflt=([^&]+)/)?.[1];

    const labelEl =
      el.closest('label') ??
      el.parentElement?.querySelector('[data-testid="filters-group-label-content"]') ??
      el.parentElement;
    const label = clean((labelEl as HTMLElement | null)?.innerText);

    const code = fromHref ? decodeURIComponent(fromHref) : id.replace(/^filter_/, '');
    if (!code || !label) continue;
    out.push({ label, code, where: fromHref ? 'href' : 'id' });
  }

  // Anything with a readable name and a query-ish value, as a fallback.
  for (const el of Array.from(document.querySelectorAll('input[type="checkbox"][name], select[name]'))) {
    const name = el.getAttribute('name') ?? '';
    const label = clean((el.closest('label') as HTMLElement | null)?.innerText);
    if (name && label) out.push({ label, code: name, where: 'name' });
  }

  const seen = new Set<string>();
  return out.filter((r) => {
    const k = `${r.label}::${r.code}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
});

console.log(`${which}: ${found.length} filter controls\n`);
for (const row of found.slice(0, 70)) {
  console.log(`  ${row.code.padEnd(40)} ${row.where.padEnd(5)} ${row.label}`);
}

await session.close();

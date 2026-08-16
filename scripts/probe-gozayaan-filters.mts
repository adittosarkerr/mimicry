/** What can actually be narrowed on GoZayaan's results page, and how. */
import { launchSession, settle } from '../apps/runner/src/replay/browser.ts';

const session = await launchSession({});
await session.page.goto(
  'https://gozayaan.com/flight/list?adult=1&child=0&infant=0&cabin_class=Economy&trips=DAC,BKK,2026-10-05',
  { waitUntil: 'domcontentloaded', timeout: 60_000 },
);
await settle(session.page).catch(() => {});
await session.page.waitForTimeout(7000);

const report = await session.page.evaluate(() => {
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
  const side = document.querySelector('aside, [class*="filter" i], [class*="sidebar" i]');
  return {
    sidebar: clean((side as HTMLElement | null)?.innerText).slice(0, 700),
    checkboxes: Array.from(document.querySelectorAll('input[type="checkbox"]'))
      .map((el) => clean((el.closest('label') as HTMLElement | null)?.innerText))
      .filter(Boolean)
      .slice(0, 30),
  };
});

console.log('--- sidebar ---\n' + report.sidebar);
console.log('\n--- checkbox labels ---');
report.checkboxes.forEach((c) => console.log('  ' + c));

await session.close();

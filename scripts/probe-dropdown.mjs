/**
 * Dumps the structure of a site's autocomplete panel so dropdown detection can
 * be reasoned about instead of guessed at.
 *
 *   node scripts/probe-dropdown.mjs <url> <inputAccessibleNameOrPlaceholder> <query>
 */
import { chromium } from 'playwright';

const url = process.argv[2] ?? 'https://www.booking.com/';
const query = process.argv[4] ?? 'Kuala';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

// Dismiss consent so the field is reachable.
for (const sel of ['#onetrust-accept-btn-handler', 'button:has-text("Accept")']) {
  const b = page.locator(sel).first();
  if (await b.isVisible({ timeout: 800 }).catch(() => false)) {
    await b.click().catch(() => {});
    break;
  }
}

const input = page.locator('input[name="ss"], input[placeholder*="going" i], input[type="search"]').first();
await input.click({ timeout: 8000 });
await input.fill(query);
await page.waitForTimeout(2500);

const report = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 60 && r.height > 20 && st.display !== 'none' && st.visibility !== 'hidden';
  };

  const roleOptions = Array.from(document.querySelectorAll('[role="option"]')).filter(visible);
  const listboxes = Array.from(document.querySelectorAll('[role="listbox"]')).filter(visible);

  const describe = (el) => ({
    tag: el.tagName,
    role: el.getAttribute('role'),
    testid: el.getAttribute('data-testid'),
    cls: (el.className || '').toString().slice(0, 70),
    kids: el.children.length,
    text: clean(el.innerText).slice(0, 70),
  });

  // Any visible container holding 3+ rows that mention a city-ish string.
  const panels = Array.from(document.querySelectorAll('ul,div,section'))
    .filter(visible)
    .map((el) => {
      const rows = Array.from(el.children).filter(visible);
      return { el, rows };
    })
    .filter((p) => p.rows.length >= 3 && p.rows.length <= 30)
    .slice(-6)
    .map((p) => ({
      container: describe(p.el),
      rows: p.rows.slice(0, 6).map(describe),
    }));

  return {
    roleOptionCount: roleOptions.length,
    roleOptionSample: roleOptions.slice(0, 6).map(describe),
    listboxCount: listboxes.length,
    listboxSample: listboxes.slice(0, 2).map(describe),
    panels,
  };
});

console.log(JSON.stringify(report, null, 1).slice(0, 4000));
await browser.close();

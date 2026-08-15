/**
 * Drives a real run through the web UI to verify the websocket console and the
 * rendered output. Requires the runner and `next dev` to both be up.
 *
 *   node scripts/ui-run-test.mjs <automationId> <fieldKey> <value>
 */
import { chromium } from 'playwright';

const [id, key = 'search', value = 'solar rooftop'] = process.argv.slice(2);
if (!id) {
  console.error('usage: node scripts/ui-run-test.mjs <automationId> [fieldKey] [value]');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 2 });

page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [browser error]', m.text().slice(0, 200));
});
page.on('pageerror', (e) => console.log('  [page error]', e.message.slice(0, 200)));

await page.goto(`http://localhost:3000/automations/${id}`, { waitUntil: 'networkidle' });
await page.waitForSelector('text=Run automation', { timeout: 20000 });

const input = page.locator(`#${key}`);
if (await input.count()) {
  await input.fill(value);
  console.log(`filled ${key} = "${value}"`);
}

await page.getByRole('button', { name: 'Run automation' }).click();
console.log('clicked run — waiting for the console…');

await page.waitForSelector('text=Starting a clean browser session', { timeout: 30000 });
console.log('console is streaming');

// Wait for the output section to appear.
// The results heading names what came back — "17 videos", "26 stays" — so the
// wait has to cover every result kind, not just the old generic wording.
await page.waitForSelector(
  'text=/\\d+ (results?|videos?|stays?|products?|articles?|threads?|repositor(y|ies)|places?)$' +
    // A document-style run reports a word count instead of a result count.
    '|[\\d,]+ words|Nothing came back|The run stopped/',
  { timeout: 180000 },
);
await page.waitForTimeout(2000);

const summary = await page.evaluate(() => {
  const lines = Array.from(document.querySelectorAll('p')).map((p) => p.textContent?.trim() ?? '');
  return {
    consoleLines: lines.filter((t) => /Starting|Opening|Filling|Clicking|Reading|Found|Waiting/.test(t)),
    resultCount: document.querySelectorAll('a[target="_blank"][rel*="noreferrer"]').length,
    heading: Array.from(document.querySelectorAll('h3')).map((h) => h.textContent?.trim())[0],
  };
});

console.log('heading:', summary.heading);
console.log('result links:', summary.resultCount);
console.log('console lines:');
summary.consoleLines.forEach((l) => console.log('   ', l));

await page.screenshot({ path: process.argv[5] ?? 'run-result.png', fullPage: false });
console.log('screenshot written');
await browser.close();

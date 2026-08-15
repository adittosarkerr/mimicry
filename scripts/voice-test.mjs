/**
 * Exercises the voice flow through the typed fallback: request → plan → run.
 *   node scripts/voice-test.mjs "search wikipedia for monsoon flooding"
 */
import { chromium } from 'playwright';

const request = process.argv[2] ?? 'search wikipedia for monsoon flooding in bangladesh';
const out = process.argv[3] ?? 'voice-run.png';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('  [page error]', e.message.slice(0, 160)));

await page.goto('http://localhost:3000/voice', { waitUntil: 'networkidle' });
await page.locator('textarea').fill(request);
await page.getByRole('button', { name: 'Work out the plan' }).click();
console.log('asked for a plan…');

await page.waitForSelector('button:has-text("Run it")', { timeout: 90000 });
const planText = await page.locator('p.font-display').first().innerText();
console.log('plan:', planText);

await page.getByRole('button', { name: 'Run it' }).click();
console.log('running…');

// The results heading names what came back — "17 videos", "26 stays".
await page.waitForSelector(
  'text=/\\d+ (results?|videos?|stays?|products?|articles?|threads?|repositor(y|ies)|places?)$|Nothing came back|The run stopped/',
  { timeout: 180000 },
);
await page.waitForTimeout(1500);

const heading = await page
  .locator('h3')
  .first()
  .innerText()
  .catch(() => '(none)');
console.log('output heading:', heading);

await page.screenshot({ path: out, fullPage: false });
console.log('screenshot written');
await browser.close();

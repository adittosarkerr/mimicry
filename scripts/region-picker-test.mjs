/**
 * Exercises the results picker: run an automation, open the picker, choose a
 * different block, and confirm the choice is saved to the automation.
 *
 *   node scripts/region-picker-test.mjs <automationId> [fieldKey] [value] [out.png]
 */
import { chromium } from 'playwright';

const [id, key = 'search', value = 'lofi hip hop radio', out = 'region-picker.png'] =
  process.argv.slice(2);
if (!id) {
  console.error('usage: node scripts/region-picker-test.mjs <automationId>');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 2 });
page.on('pageerror', (e) => console.log('  [page error]', e.message.slice(0, 140)));

await page.goto(`http://localhost:3000/automations/${id}`, { waitUntil: 'networkidle' });

const input = page.locator(`#${key}`);
if (await input.count()) await input.fill(value);

await page.getByRole('button', { name: 'Run automation' }).click();
console.log('running…');
await page.waitForSelector('text=/result[s]?$|Nothing came back|The run stopped/', { timeout: 180_000 });
await page.waitForTimeout(1500);

const toggle = page.getByRole('button', { name: /Not the right results|Pick the results block/ });
if (!(await toggle.count())) {
  console.log('FAIL: picker did not render');
  await page.screenshot({ path: out, fullPage: false });
  await browser.close();
  process.exit(1);
}

await toggle.scrollIntoViewIfNeeded();
await toggle.click();
await page.waitForTimeout(600);

const options = page.locator('code.font-mono');
const count = await options.count();
console.log('candidates listed:', count);
for (let i = 0; i < Math.min(count, 4); i += 1) {
  console.log('  -', (await options.nth(i).innerText()).slice(0, 50));
}

// Choose the second block and confirm it sticks.
if (count > 1) {
  const second = await options.nth(1).innerText();
  await options.nth(1).click();
  await page.waitForTimeout(2500);

  const saved = await fetch(`http://localhost:8787/api/automations/${id}`).then((r) => r.json());
  console.log('picked:      ', second.trim());
  console.log('saved on api:', saved.schema?.output?.itemLocator);
  console.log(saved.schema?.output?.itemLocator === second.trim() ? 'PASS — choice persisted' : 'FAIL — not saved');
}

await page.screenshot({ path: out, fullPage: false });
console.log('screenshot written');
await browser.close();

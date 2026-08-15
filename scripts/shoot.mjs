/**
 * Screenshot helper for design review.
 *   node scripts/shoot.mjs <path> <out.png> [width] [fullPage]
 */
import { chromium } from 'playwright';

const path = process.argv[2] ?? '/';
const out = process.argv[3] ?? 'shot.png';
const width = Number(process.argv[4] ?? 1440);
const fullPage = process.argv[5] === 'full';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 2 });
await page.goto(`http://localhost:3000${path}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(2200); // let entrance animations settle
await page.screenshot({ path: out, fullPage });
console.log('wrote', out);
await browser.close();

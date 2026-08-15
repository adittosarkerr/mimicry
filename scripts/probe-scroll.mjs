/**
 * How many result blocks a page actually yields as you scroll.
 * Tells you whether "only 19 results" is a scraping limit or the site's own.
 *
 *   node scripts/probe-scroll.mjs <url> <itemSelector>
 */
import { chromium } from 'playwright';

const url = process.argv[2];
const selector = process.argv[3] ?? 'ytd-video-renderer';

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2500);

for (let i = 0; i < 12; i += 1) {
  const info = await page.evaluate((sel) => {
    const scrollable = (el) => {
      const s = getComputedStyle(el);
      return /(auto|scroll|overlay)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 40;
    };
    let scroller = null;
    const root = document.scrollingElement ?? document.documentElement;
    if (root && root.scrollHeight > root.clientHeight + 40) scroller = root;
    else {
      let bestArea = 0;
      for (const el of document.querySelectorAll('div, main, section, [role="main"]')) {
        if (!scrollable(el)) continue;
        const r = el.getBoundingClientRect();
        if (r.width * r.height > bestArea) {
          bestArea = r.width * r.height;
          scroller = el;
        }
      }
    }
    if (scroller) scroller.scrollTop += scroller.clientHeight * 0.9;
    return {
      count: document.querySelectorAll(sel).length,
      scroller: scroller ? scroller.tagName + '.' + String(scroller.className).slice(0, 30) : 'none',
      h: scroller ? scroller.scrollHeight : 0,
      top: scroller ? Math.round(scroller.scrollTop) : 0,
    };
  }, selector);
  console.log(`pass ${i}: ${info.count} items | scroller=${info.scroller} h=${info.h} top=${info.top}`);
  await page.waitForTimeout(1300);
}

await browser.close();

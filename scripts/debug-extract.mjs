/**
 * Debug helper for the results detector.
 * Loads a URL and prints the repeated-block candidates it scores, so you can
 * see why a page did or didn't yield items.
 *
 *   node scripts/debug-extract.mjs "https://example.com/search?q=foo"
 */
import { chromium } from 'playwright';

const url = process.argv[2];
if (!url) {
  console.error('usage: node scripts/debug-extract.mjs <url>');
  process.exit(1);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1500);

const report = await page.evaluate(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 40 || r.height < 24) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  };
  const sig = (el) => {
    const cls = Array.from(el.classList)
      .filter((c) => c.length > 2 && c.length < 40 && !/^(css|sc|jsx)-/.test(c))
      .slice(0, 3)
      .join('.');
    return el.tagName + (cls ? '.' + cls : '');
  };

  const containers = Array.from(document.querySelectorAll('main, [role="main"], section, ul, ol, div'));
  const scored = [];
  let examined = 0;
  const rejected = { tooFewKids: 0, noRepeat: 0, textLen: 0 };

  for (const c of containers) {
    examined++;
    const kids = Array.from(c.children).filter(visible);
    if (kids.length < 3 || kids.length > 200) { rejected.tooFewKids++; continue; }
    const counts = new Map();
    kids.forEach((k) => counts.set(sig(k), (counts.get(sig(k)) || 0) + 1));
    const top = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (!top || top[1] < 3) { rejected.noRepeat++; continue; }
    const members = kids.filter((k) => sig(k) === top[0]);
    const textLen = members.reduce((s, m) => s + clean(m.innerText).length, 0) / members.length;
    if (textLen < 15 || textLen > 4000) { rejected.textLen++; continue; }
    const hasLink = members.filter((m) => m.querySelector('a[href]')).length;
    scored.push({
      container: sig(c),
      itemSig: top[0],
      count: top[1],
      avgTextLen: Math.round(textLen),
      withLinks: hasLink,
      score: Math.round(top[1] * 2 + hasLink * 3 + Math.min(textLen / 40, 20)),
      sample: clean(members[0].innerText).slice(0, 90),
    });
  }

  scored.sort((a, b) => b.score - a.score);

  return {
    title: document.title,
    containersExamined: examined,
    rejected,
    top: scored.slice(0, 8),
    // Wikipedia-specific sanity probe
    knownList: document.querySelectorAll('ul.mw-search-results > li').length,
  };
});

console.log(JSON.stringify(report, null, 1));
await browser.close();

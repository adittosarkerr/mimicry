/**
 * Extraction test suite.
 *
 * Runs the real extractor against a spread of sites — search engines, video,
 * shops, travel, reference, forums — and reports what came back. Screenshots
 * every failure so the page can be looked at rather than guessed about.
 *
 *   node scripts/extract-suite.mjs            # all sites
 *   node scripts/extract-suite.mjs youtube    # only matching sites
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const RUNNER = process.env.RUNNER_URL || 'http://localhost:8787';
const OUT = process.env.SUITE_OUT || path.join(process.cwd(), 'suite-shots');
const filter = process.argv[2]?.toLowerCase();

const SITES = [
  { name: 'youtube', url: 'https://www.youtube.com/results?search_query=premier+league' },
  { name: 'wikipedia', url: 'https://en.wikipedia.org/w/index.php?search=solar+rooftop&fulltext=1' },
  { name: 'bing', url: 'https://www.bing.com/search?q=wireless+keyboard' },
  { name: 'duckduckgo', url: 'https://duckduckgo.com/?q=wireless+keyboard' },
  { name: 'booking', url: 'https://www.booking.com/searchresults.html?ss=Kuala+Lumpur' },
  { name: 'ebay', url: 'https://www.ebay.com/sch/i.html?_nkw=mechanical+keyboard' },
  { name: 'hackernews', url: 'https://news.ycombinator.com/' },
  { name: 'reddit', url: 'https://www.reddit.com/r/programming/' },
  { name: 'github', url: 'https://github.com/search?q=playwright&type=repositories' },
  { name: 'stackoverflow', url: 'https://stackoverflow.com/questions/tagged/playwright' },
  { name: 'fitgirl', url: 'https://fitgirl-repacks.site/?s=hogwarts' },
  { name: 'imdb', url: 'https://www.imdb.com/find/?q=inception' },
  { name: 'googlenews', url: 'https://news.google.com/search?q=renewable+energy' },
  { name: 'amazon', url: 'https://www.amazon.com/s?k=usb+c+cable' },
];

const chosen = filter ? SITES.filter((s) => s.name.includes(filter)) : SITES;
mkdirSync(OUT, { recursive: true });

const rows = [];

for (const site of chosen) {
  const started = Date.now();
  process.stdout.write(`${site.name.padEnd(14)} `);

  try {
    const res = await fetch(`${RUNNER}/api/debug/extract`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: site.url }),
    });

    const data = await res.json();
    const seconds = ((Date.now() - started) / 1000).toFixed(0);

    if (!res.ok) {
      console.log(`ERROR  ${String(data.error).slice(0, 70)}  (${seconds}s)`);
      rows.push({ site: site.name, items: 0, verdict: 'error', note: data.error });
      continue;
    }

    const withImages = data.items.filter((i) => i.hasImage).length;
    const withUrls = data.items.filter((i) => i.hasUrl).length;
    const sample = data.items[0]?.title ?? '';

    // A result list should have several items, most of them linking somewhere.
    const verdict =
      data.itemCount >= 5 && withUrls >= Math.min(3, data.items.length)
        ? 'ok'
        : data.itemCount > 0
          ? 'weak'
          : 'empty';

    // Which meta facts actually came back, so a silent regression in one of
    // them (thumbnails, durations, prices) shows up here rather than in the UI.
    const metaKeys = new Set();
    data.items.forEach((i) => Object.keys(i.meta ?? {}).forEach((k) => metaKeys.add(k)));

    console.log(
      `${verdict.padEnd(5)} items=${String(data.itemCount).padStart(3)} ` +
        `img=${withImages}/${data.items.length} url=${withUrls}/${data.items.length} ` +
        `kind=${String(data.resultKind).padEnd(10)} (${seconds}s)  ${sample.slice(0, 36)}`,
    );
    if (metaKeys.size) console.log(`               meta: ${Array.from(metaKeys).join(', ')}`);

    if (verdict !== 'ok') {
      console.log(`               candidates considered:`);
      (data.candidates ?? []).slice(0, 4).forEach((c) => {
        console.log(
          `                 ${c.chosen ? '→' : ' '} ${String(c.score).padStart(3)}  ` +
            `${c.selector.padEnd(34)} ×${c.count}  ${(c.samples[0] ?? '').slice(0, 40)}`,
        );
      });
      if (data.screenshot) {
        const file = path.join(OUT, `${site.name}.png`);
        writeFileSync(file, Buffer.from(data.screenshot, 'base64'));
        console.log(`               screenshot → ${file}`);
      }
    }

    rows.push({ site: site.name, items: data.itemCount, verdict, sample });
  } catch (err) {
    console.log(`FAILED ${String(err.message).slice(0, 70)}`);
    rows.push({ site: site.name, items: 0, verdict: 'failed', note: err.message });
  }
}

const ok = rows.filter((r) => r.verdict === 'ok').length;
const weak = rows.filter((r) => r.verdict === 'weak').length;
console.log(
  `\n${ok}/${rows.length} good · ${weak} weak · ${rows.length - ok - weak} empty or failed`,
);

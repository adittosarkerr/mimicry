/**
 * Daraz, end to end, against the live site.
 *
 * The DOM path returns the site's own top bar for this host — "SAVE MORE ON
 * APP", "BECOME A SELLER", a QR code — because the product grid never hydrates
 * for a headless browser. This checks the JSON reader that replaces it, and
 * that the profile builds the URL it reads.
 *
 *   npx tsx scripts/daraz-test.mts [query]
 */
import { chromium } from 'playwright';
import { readDarazResults } from '../apps/runner/src/sites/daraz';
import { profileFor } from '../apps/runner/src/sites/profiles';

const query = process.argv[2] ?? 'mouse';
const MAX_PAGES = 3;

const profile = profileFor('www.daraz.com.bd');
if (!profile) throw new Error('no Daraz profile — profileFor() did not match the host');

console.log(`profile: ${profile.name} (${profile.id})`);
console.log(`fields:  ${profile.fields.map((f) => f.key).join(', ')}`);
if (profile.fields.some((f) => /spm/i.test(f.key)))
  throw new Error('the tracking parameter is still a form field');

const url = profile.buildUrl({ query, sort: 'priceasc', min_price: 200, max_price: 5000 });
console.log(`built:   ${url}`);
if (!url) throw new Error('buildUrl returned nothing for a filled form');

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

const output = await readDarazResults(page, {
  maxPages: MAX_PAGES,
  summaryHint: `Search: ${query}`,
  onProgress: (m, d) => console.log(`  · ${m}${d ? ` (${d})` : ''}`),
});

if (!output) throw new Error('reader declined the page — it fell back to the DOM scanner');

const items = output.items;
console.log(`\nsummary: ${output.summary}`);
console.log(`items:   ${items.length} across ${new Set(items.map((i) => i.page)).size} pages`);

const withPrice = items.filter((i) => i.price).length;
const withUrl = items.filter((i) => i.url?.startsWith('https://')).length;
const withImage = items.filter((i) => i.image?.startsWith('http')).length;
const rated = items.filter((i) => typeof i.rating === 'number').length;
const unique = new Set(items.map((i) => i.id)).size;

console.log(`price:   ${withPrice}/${items.length}`);
console.log(`url:     ${withUrl}/${items.length}`);
console.log(`image:   ${withImage}/${items.length}`);
console.log(`rated:   ${rated}/${items.length} (unrated is normal)`);
console.log(`unique:  ${unique}/${items.length}`);

console.log('\nfirst three:');
for (const i of items.slice(0, 3)) {
  console.log(`  ${i.title.slice(0, 62)}`);
  console.log(`    ${i.price?.formatted ?? 'no price'} · ${i.meta.author ?? '?'} · ${i.meta.location ?? '?'}`);
}

/* The exact failure this replaces: the top bar scored as a product list. */
const NAV = /save more on app|become a seller|help & support|ভাষা|download app/i;
const navHits = items.filter((i) => NAV.test(i.title));

const problems: string[] = [];
if (navHits.length) problems.push(`navigation leaked in: ${navHits.map((i) => i.title).join(', ')}`);
if (items.length < 100) problems.push(`expected ~${MAX_PAGES * 40} items, got ${items.length}`);
if (unique !== items.length) problems.push('duplicate items across pages');
if (withPrice / items.length < 0.9) problems.push('most items have no price');
if (withUrl !== items.length) problems.push('some items have no absolute url');
if (items.some((i) => i.rating === 0)) problems.push('an unrated product came back as a 0 rating');

// A query nothing matches must say so, not return the shop's furniture.
await page.goto('https://www.daraz.com.bd/catalog/?q=zzzqqqxxnothinghere123', {
  waitUntil: 'domcontentloaded',
  timeout: 60_000,
});
const empty = await readDarazResults(page, { maxPages: 1 });
console.log(`\nempty state: ${empty?.items.length} items — ${empty?.emptyReason ?? 'no reason given'}`);
if (empty?.items.length) problems.push('a nonsense query returned items');
if (!empty?.emptyReason) problems.push('empty result carried no explanation');

await browser.close();

if (problems.length) {
  console.log(`\nFAIL\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  process.exit(1);
}
console.log('\nPASS');

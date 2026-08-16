import type { Page } from 'playwright';
import type { ResultItem, RunOutput } from '@mimic/schema';

/**
 * Daraz — read the results the site's own page reads.
 *
 * Every other site in this codebase is scraped from the DOM, because the DOM is
 * what the person recorded. Daraz cannot be, and the reason is worth writing
 * down: `https://www.daraz.com.bd/catalog/?q=mouse` answers a headless browser
 * with HTTP 200 and a complete page — header, category rail, footer, the lot —
 * and no product grid at all. Nothing errors. Nothing says it refused. The
 * markup simply never hydrates.
 *
 * What the structural scanner then finds is the only repeated block left on the
 * page: the top bar. "SAVE MORE ON APP", "BECOME A SELLER", "HELP & SUPPORT",
 * "ভাষা" — four uniform blocks, each with an icon, which is enough images to
 * clear `looksLikeNavigation`'s picture test. So a run reported eight products
 * and showed the reader a QR code and a Google Play badge.
 *
 * The grid is drawn from a JSON document the page fetches from its own URL with
 * `ajax=true`. That endpoint answers headless perfectly: 40 items a page, with
 * prices, ratings, sellers, stock and image URLs already parsed — better data
 * than scraping the rendered card would have given us, and it paginates
 * honestly. So for this host we ask the page to fetch its own JSON and read
 * that.
 *
 * The URL is not rebuilt here. Whatever the automation navigated to — a form
 * replay, a voice-authored search, a category browse — is taken as given and
 * only `ajax` and `page` are set on it. That way every parameter the rest of
 * the system decided on (`q`, `sort`, `price`, filters we have never heard of)
 * survives without this module needing to know what any of them mean.
 */

/** Daraz runs one storefront per country, all on the same platform. */
export const DARAZ_HOST = /(^|\.)daraz\.(com\.bd|com\.np|lk|pk|com\.mm)$/i;

export const isDarazHost = (host: string | undefined): boolean =>
  !!host && DARAZ_HOST.test(host.replace(/^https?:\/\//i, '').split('/')[0]);

/** The storefront's currency. `priceShow` carries the symbol; JSON wants a code. */
const CURRENCY: Record<string, string> = {
  'com.bd': 'BDT',
  'com.np': 'NPR',
  lk: 'LKR',
  pk: 'PKR',
  'com.mm': 'MMK',
};

const currencyFor = (host: string): string => {
  const m = host.toLowerCase().match(/daraz\.(com\.bd|com\.np|lk|pk|com\.mm)$/);
  return (m && CURRENCY[m[1]]) || 'BDT';
};

/** One row of `mods.listItems`. Only the fields we actually read. */
interface DarazItem {
  itemId?: string;
  nid?: string;
  name?: string;
  itemUrl?: string;
  image?: string;
  price?: string | number;
  priceShow?: string;
  originalPrice?: string | number;
  originalPriceShow?: string;
  discount?: string;
  ratingScore?: string;
  review?: string;
  location?: string;
  sellerName?: string;
  brandName?: string;
  description?: string[] | string;
  inStock?: boolean;
  isSponsored?: boolean;
}

interface DarazPage {
  mods?: { listItems?: DarazItem[] };
  mainInfo?: { totalResults?: string | number; page?: string | number; pageSize?: string | number };
}

const text = (v: unknown): string | undefined => {
  const s = String(v ?? '').trim();
  return s ? s : undefined;
};

const numeric = (v: unknown): number | undefined => {
  const n = Number(String(v ?? '').replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

/** The URL for page N of the same search, as JSON. */
function jsonUrlFor(current: string, pageNumber: number): string {
  const url = new URL(current);
  url.searchParams.set('ajax', 'true');
  url.searchParams.set('page', String(pageNumber));
  /* `spm` is a click-provenance token the site stamps into every link. It is
     harmless in a JSON request and meaningless after the click that made it, so
     it goes — the same reason the compiler refuses to make a form field of it. */
  url.searchParams.delete('spm');
  return url.toString();
}

/**
 * Fetch from inside the page rather than over the network from Node.
 *
 * Same origin, same cookies, same TLS fingerprint as the session that already
 * loaded successfully. A bare `fetch` from the runner gets a different answer.
 */
async function fetchPage(page: Page, url: string): Promise<DarazPage | undefined> {
  return page
    .evaluate(async (target) => {
      try {
        const res = await fetch(target, {
          credentials: 'include',
          headers: { accept: 'application/json,text/plain,*/*' },
        });
        if (!res.ok) return undefined;
        return (await res.json()) as unknown;
      } catch {
        return undefined;
      }
    }, url)
    .then((v) => (v && typeof v === 'object' ? (v as DarazPage) : undefined))
    .catch(() => undefined);
}

function toResultItem(raw: DarazItem, host: string, pageNumber: number): ResultItem | undefined {
  const title = text(raw.name);
  if (!title) return undefined;

  const amount = numeric(raw.price);
  const formatted = text(raw.priceShow);
  const rating = Number(raw.ratingScore);
  const reviews = numeric(raw.review);
  const original = numeric(raw.originalPrice);

  const badges: string[] = [];
  if (text(raw.discount)) badges.push(String(raw.discount).trim());
  if (raw.isSponsored) badges.push('Sponsored');

  const attributes: { label: string; value: string }[] = [];
  if (text(raw.brandName)) attributes.push({ label: 'Brand', value: String(raw.brandName).trim() });
  if (original && amount && original > amount) {
    attributes.push({
      label: 'Was',
      value: text(raw.originalPriceShow) ?? `${original}`,
    });
  }

  /* Daraz ships the blurb as a list of bullet points, and joining an array with
     the default comma runs the last word of one line into the first of the
     next. */
  const description = Array.isArray(raw.description)
    ? raw.description.map((d) => String(d).trim()).filter(Boolean).join(' · ')
    : text(raw.description);

  return {
    id: String(raw.itemId ?? raw.nid ?? title),
    title,
    // The site writes its links protocol-relative; a bare `//host/…` is not a link.
    url: raw.itemUrl ? new URL(String(raw.itemUrl), `https://${host}`).toString() : undefined,
    image: text(raw.image),
    description,
    price:
      amount && formatted
        ? { amount, currency: currencyFor(host), formatted }
        : undefined,
    // An unrated product carries "" here, and Number("") is 0 — which would
    // render as a genuine zero-star rating rather than as no rating at all.
    rating: Number.isFinite(rating) && rating > 0 ? rating : undefined,
    meta: {
      author: text(raw.sellerName),
      location: text(raw.location),
      reviews: reviews ? `${reviews} review${reviews === 1 ? '' : 's'}` : undefined,
    },
    badges,
    attributes,
    page: pageNumber,
    unavailable: raw.inStock === false,
    unavailableReason: raw.inStock === false ? 'Out of stock' : undefined,
  };
}

export interface DarazReadOptions {
  maxPages?: number;
  summaryHint?: string;
  onProgress?: (message: string, detail?: string) => void;
  deadline?: number;
}

/**
 * Read a Daraz results page, and every following page up to `maxPages`.
 *
 * Returns `undefined` when this isn't a Daraz results URL, so the caller falls
 * back to the normal DOM path rather than reporting an empty run.
 */
export async function readDarazResults(
  page: Page,
  opts: DarazReadOptions = {},
): Promise<RunOutput | undefined> {
  const current = page.url();
  let host: string;
  try {
    host = new URL(current).host;
  } catch {
    return undefined;
  }
  if (!isDarazHost(host)) return undefined;

  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 10, 30));
  const items: ResultItem[] = [];
  const seen = new Set<string>();
  let total: number | undefined;
  let pagesRead = 0;
  let stoppedEarly = false;

  /* Consecutive pages that told us nothing new.
   *
   * Daraz intermittently answers `page=2` with page 1's list — not an error,
   * not the end of the results, just the same forty products again, and the
   * next page carries on correctly. Treating the first repeat as the end (the
   * obvious rule, since past its real last page the site also keeps serving
   * full-looking duplicate lists rather than an empty one) stopped a search of
   * 4,080 products at 80. So a repeat is retried once, then skipped, and only a
   * run of them is believed to be the end. */
  let staleRun = 0;
  let retriedThisPage = false;

  for (let n = 1; n <= maxPages; ) {
    if (opts.deadline && Date.now() > opts.deadline) {
      stoppedEarly = true;
      break;
    }

    const data = await fetchPage(page, jsonUrlFor(current, n));

    /* The first page failing means this is not the endpoint we think it is —
       a category page, a redirect, a shape change — and the DOM path deserves
       its turn. A later page failing is just the end of the road, and the items
       already in hand are a real answer. */
    if (!data) {
      if (n === 1) return undefined;
      stoppedEarly = true;
      break;
    }

    const list = data.mods?.listItems ?? [];
    if (n === 1) total = numeric(data.mainInfo?.totalResults) ?? undefined;

    /* An empty first page is the site answering the question — no results —
       and staying instant here is the whole point of that being unambiguous.
       An empty page past the first is not the same signal: the flakiness this
       function already retries for (page 2 silently repeating page 1) has a
       sibling where a page comes back with nothing at all instead of a
       repeat, and `total` says there was more to find. Verified directly: a
       three-page read of "mouse" (4,080 on the site) stopped at 80 once in
       three runs, on an outright empty page 3 rather than a duplicate one —
       the two are the same fault wearing a different shape, so they get the
       same treatment below rather than a silent break here. */
    if (!list.length && n === 1) break;

    let added = 0;
    for (const raw of list) {
      const item = toResultItem(raw, host, n);
      if (!item) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
      added++;
    }

    if (added) {
      pagesRead = n;
      staleRun = 0;
      retriedThisPage = false;
      opts.onProgress?.(
        `Read page ${n} · ${items.length} products so far`,
        total ? `${total} in total on the site` : undefined,
      );
      if (total && items.length >= total) break;
      n++;
      continue;
    }

    // Ask this page number once more before writing it off.
    if (!retriedThisPage) {
      retriedThisPage = true;
      continue;
    }

    retriedThisPage = false;
    staleRun++;
    if (staleRun >= 3) break;
    n++;
  }

  const summaryBits = [
    opts.summaryHint,
    pagesRead > 1 ? `${pagesRead} pages` : undefined,
    total && total > items.length ? `${total} on the site` : undefined,
    // Say so rather than let a partial read look like the whole shop.
    stoppedEarly ? 'stopped early' : undefined,
  ].filter(Boolean);

  return {
    layout: 'cards',
    resultKind: 'product',
    summary: summaryBits.join(' · ') || undefined,
    items,
    /* The site answering with an empty list is a real "nothing matched", and
       says so — as distinct from the page not having rendered, which is the
       failure this whole module exists to avoid reporting as an empty shop. */
    emptyReason: items.length
      ? undefined
      : 'Daraz returned no products for this search. The site itself reports 0 results.',
    candidates: [],
    finalUrl: current,
  };
}

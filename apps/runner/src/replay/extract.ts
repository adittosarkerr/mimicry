import type { Page } from 'playwright';
import type { OutputSpec, ResultItem, ResultKind, RunOutput } from '@mimic/schema';

/**
 * Output scraping.
 *
 * Two paths: the compiler's selectors when it produced usable ones, and an
 * in-page structural detector when it didn't. Both end at the same shape, so
 * the web app renders every site's results in Mimic's own theme rather than
 * showing an iframe of someone else's page.
 *
 * Everything here has to work on a site nobody has seen before, so the rules
 * are about structure and semantics, never about a particular company's markup.
 */

interface RawItem {
  title: string;
  subtitle?: string;
  description?: string;
  url?: string;
  image?: string;
  priceText?: string;
  ratingText?: string;
  badges: string[];
  attributes: { label: string; value: string }[];
  meta: Record<string, string | undefined>;
  text: string;
  /** The card as the page lays it out. `text` has had its newlines flattened,
      and some facts are only legible from how the lines are grouped. */
  lines: string[];
}

/**
 * Runs inside the page: find the repeated block that looks like results.
 *
 * Passed to `page.evaluate` as a real function so Playwright serializes it —
 * which means it must stay entirely self-contained, with no references to
 * anything in this module.
 */
function detectItems(args: { itemSelector: string | null; pinned: boolean }): RawItem[] {
  const { itemSelector, pinned } = args;

  const abs = (u: string | null | undefined): string | undefined => {
    try {
      return u ? new URL(u, location.href).href : undefined;
    } catch {
      return undefined;
    }
  };
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  /**
   * innerText of a wrapper often contains its child's text twice — a visible
   * label plus a screen-reader or tooltip copy. "Lofi Girl Lofi Girl" is one
   * channel, not two.
   */
  /**
   * Screen-reader boilerplate that sites append to link labels. It is not part
   * of the result's name, and reading it back as one ("BRYQS Hotel KL Sentral
   * Opens in new window") is noise in every card.
   */
  const stripA11y = (s: string) =>
    s
      .replace(/[\s,.–-]*\bopens? in (?:a )?new (?:window|tab)\b\.?/gi, '')
      .replace(/[\s,.–-]*\(opens in (?:a )?new (?:window|tab)\)/gi, '')
      .replace(/\s{2,}/g, ' ')
      .trim();

  const collapseRepeat = (input: string): string => {
    const t = stripA11y(clean(input));
    if (!t) return t;
    const tokens = t.split(' ');
    if (tokens.length >= 2 && tokens.length % 2 === 0) {
      const half = tokens.length / 2;
      const a = tokens.slice(0, half).join(' ');
      const b = tokens.slice(half).join(' ');
      if (a.toLowerCase() === b.toLowerCase()) return a;
    }
    return t;
  };

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    // A dense list row (a table of links, a compact feed) is barely taller than
    // its text. Demanding 24px quietly excluded whole sites.
    if (r.width < 40 || r.height < 12) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  };

  /** Class signature ignoring hashed/utility noise — siblings in a list share it. */
  const sig = (el: Element) => {
    const cls = Array.from(el.classList)
      .filter((c) => c.length > 2 && c.length < 40 && !/^(css|sc|jsx)-/.test(c))
      .slice(0, 3)
      .join('.');
    return el.tagName + (cls ? `.${cls}` : '');
  };

  /* ── images ──────────────────────────────────────────────────────────
     Lazy-loading is universal now: the `src` attribute is usually a 1×1 gif
     or a blurred base64 stub, and the real URL sits in srcset or a data-*
     attribute. Reading only `src` is why thumbnails come back blank. */

  const isPlaceholder = (u: string) =>
    !u ||
    u.length < 10 ||
    u.startsWith('data:image/gif') ||
    u.startsWith('data:image/svg') ||
    /\b(blank|placeholder|spacer|transparent|1x1|pixel)\b/i.test(u);

  /** Largest candidate in a srcset, by declared width. */
  const fromSrcset = (srcset: string | null): string | undefined => {
    if (!srcset) return undefined;
    const best = srcset
      .split(',')
      .map((part) => {
        const [url, size] = part.trim().split(/\s+/);
        const width = size?.endsWith('w') ? Number.parseInt(size, 10) : size?.endsWith('x') ? Number.parseFloat(size) * 1000 : 0;
        return { url, width: Number.isFinite(width) ? width : 0 };
      })
      .filter((c) => c.url && !isPlaceholder(c.url))
      .sort((a, b) => b.width - a.width)[0];
    return best?.url;
  };

  const IMG_ATTRS = [
    'src',
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-thumb',
    'data-thumbnail',
    'data-image',
    'data-bg',
    'data-defer-src',
  ];

  const pickImage = (root: Element): string | undefined => {
    const images = Array.from(root.querySelectorAll('img'));
    for (const img of images) {
      const r = img.getBoundingClientRect();
      if (r.width && r.width < 24) continue; // icons and tracking pixels

      const fromSet = fromSrcset(img.getAttribute('srcset') || img.getAttribute('data-srcset'));
      if (fromSet) return abs(fromSet);

      for (const attr of IMG_ATTRS) {
        const v = img.getAttribute(attr);
        if (v && !isPlaceholder(v)) return abs(v);
      }
      // currentSrc resolves whatever the browser actually loaded.
      if (img.currentSrc && !isPlaceholder(img.currentSrc)) return abs(img.currentSrc);
    }

    // <picture><source srcset>
    const source = root.querySelector('source[srcset]');
    const fromSource = fromSrcset(source?.getAttribute('srcset') ?? null);
    if (fromSource) return abs(fromSource);

    // Cards that paint their image as a CSS background.
    const painted = Array.from(root.querySelectorAll<HTMLElement>('*')).find((n) => {
      const bg = getComputedStyle(n).backgroundImage;
      return bg && bg !== 'none' && bg.includes('url(');
    });
    if (painted) {
      const match = getComputedStyle(painted).backgroundImage.match(/url\(["']?(.*?)["']?\)/);
      if (match?.[1] && !isPlaceholder(match[1])) return abs(match[1]);
    }
    return undefined;
  };

  /* ── grouping ────────────────────────────────────────────────────── */

  /**
   * One scoring rule for every candidate block, whoever proposed it.
   *
   * The compiled selector and the structural detector both produce a set of
   * sibling elements, and there was previously no way to say which was better —
   * the compiled one simply won by existing. That is how a saved automation
   * ends up reading a shelf of eleven thumbnails while the real result grid sits
   * untouched below it.
   */
  const scoreGroup = (members: Element[]): number => {
    if (members.length < 3) return 0;

    const texts = members.map((m) => clean((m as HTMLElement).innerText));
    const textLen = texts.reduce((sum, t) => sum + t.length, 0) / members.length;
    const distinctness =
      new Set(texts.map((t) => t.slice(0, 40).toLowerCase())).size / members.length;

    const hasLink = members.filter((m) => {
      const href = m.querySelector('a[href]')?.getAttribute('href') ?? '';
      return href && !href.startsWith('#');
    }).length;
    const hasImage = members.filter((m) => m.querySelector('img')).length;
    const hasHeading = members.filter((m) => m.querySelector('h1,h2,h3,h4,[role="heading"]')).length;
    const hasBoth = members.filter((m) => m.querySelector('img') && m.querySelector('a[href]')).length;

    /* Signals that survive a list with no links and no pictures.
     *
     * A flight itinerary is a row of times, a duration and a fare — no anchor,
     * no thumbnail — so weighting only links and images ranked Google's own
     * header above the flights. What such a row does have: a semantic tag, a
     * lot of numbers, and a length almost identical to its siblings. Page
     * furniture has none of those three at once. */
    const LISTY = members.filter((m) => {
      const tag = m.tagName.toLowerCase();
      return (
        tag === 'li' ||
        tag === 'article' ||
        tag === 'tr' ||
        tag.includes('-') ||
        m.getAttribute('role') === 'listitem' ||
        m.getAttribute('role') === 'article'
      );
    }).length;

    // Prices, times, durations, counts — the substance of a result row.
    const DATA = /[\d]{1,3}[:,.]\d|\b\d+\s?(?:hr|min|h|m|km|mi)\b|[$€£₹৳]|\b\d{2,}\b/i;
    const dataRich = texts.filter((t) => DATA.test(t)).length;

    // Sibling rows are near-identical in size; a stack of page furniture is not.
    const spread =
      textLen > 0
        ? texts.reduce((sum, t) => sum + Math.abs(t.length - textLen), 0) / members.length / textLen
        : 1;
    const uniformity = Math.max(0, 1 - spread);

    /* Must match the weighting in scoreRegions, or the picker would list a
       different winner than the extractor actually used. */
    return (
      Math.min(members.length, 40) * 3.0 +
      (hasLink / members.length) * 20 +
      (hasImage / members.length) * 18 +
      /* Consistency, not just presence. A product grid is uniform — every card
         has a picture and a link. A looser container that also sweeps up
         banners and promo rows scores well on raw count and badly here, which
         is what makes it lose. */
      (hasBoth / members.length) * 14 +
      (hasHeading / members.length) * 12 +
      (LISTY / members.length) * 12 +
      (dataRich / members.length) * 14 +
      uniformity * 12 +
      Math.min(textLen / 40, 15) +
      distinctness * 15
    );
  };

  const groups: Element[][] = [];
  /** Set when the compiled selector produced a usable list, so it can compete. */
  let compiledGroup: Element[] | null = null;

  if (itemSelector) {
    try {
      let nodes = Array.from(document.querySelectorAll(itemSelector)).filter(visible);

      /* The compiler's selector often lands on the title node rather than the
         card — which is why thumbnails and links go missing. If most matches
         hold no image or link, climb to the ancestor that does, as long as that
         ancestor doesn't swallow a sibling result. */
      if (nodes.length) {
        const rich = nodes.filter((n) => n.querySelector('img, a[href]')).length;
        if (rich / nodes.length < 0.5) {
          const expanded = nodes.map((n) => {
            let node: Element = n;
            for (let up = 0; up < 4; up += 1) {
              const parent: Element | null = node.parentElement;
              if (!parent || parent === document.body) break;
              // Stop before a container that holds more than one result.
              const swallows = nodes.filter((other) => other !== n && parent.contains(other)).length;
              if (swallows > 0) break;
              node = parent;
              if (node.querySelector('img') && node.querySelector('a[href]')) break;
            }
            return node;
          });
          // Only accept the climb if it genuinely found more.
          const expandedRich = expanded.filter((n) => n.querySelector('img, a[href]')).length;
          if (expandedRich > rich) nodes = expanded;
        }
      }

      /* A compiled selector matching one or two elements is worse than none:
         it returns a single blob of concatenated page text and hides the real
         list behind it. Trust it only when it actually looks like a list. */
      if (nodes.length >= 3) {
        // Pinned means a person looked at the choices and picked this one. No
        // heuristic gets to overrule that.
        if (pinned) groups.push(nodes);
        else compiledGroup = nodes;
      }
    } catch {
      /* the compiler's selector didn't parse — fall through to detection */
    }
  }

  if (!groups.length) {
    // Page furniture that repeats just as reliably as results but never *is*
    // the results: footnotes, navboxes, breadcrumbs, site nav.
    /* Kept identical to the copy in `scoreRegions`. Both run inside
       page.evaluate and cannot share a module constant — and when they drifted
       apart, the stricter one was the one nobody's results came from: a fridge
       search returned nine "products" made of Search, Awards, Newsroom and
       Media and Events, straight out of the footer this list was supposed to
       be excluding. */
    const EXCLUDE =
      'nav, footer, aside, header, [role="navigation"], [role="contentinfo"], [role="banner"], ' +
      '[role="doc-endnotes"], .references, .reflist, .mw-references-wrap, .navbox, .catlinks, ' +
      '.toc, [class*="footnote" i], [class*="breadcrumb" i], [class*="pagination" i], ' +
      '[class*="sidebar" i], [class*="footer" i], [id*="footer" i], [class*="site-header" i], ' +
      '[id*="header" i], [class*="topbar" i], [class*="menu" i], [class*="navbar" i]';

    /* `closest` walks all the way up to <html>, and some of the rules above
       match on a substring of a class name. Wikipedia's skin writes
       `vector-feature-main-menu-pinned` onto the root element, so a rule meant
       to skip a navigation menu matched every element on the page and returned
       nothing at all for a screen full of search results. Nothing that
       contains the entire document is a menu. */
    const excluded = (el: Element): boolean => {
      const hit = el.closest(EXCLUDE);
      return Boolean(hit) && hit !== document.documentElement && hit !== document.body;
    };

    // Every element, not a fixed tag list: results live in <tbody> rows on
    // older sites and inside custom elements (<shreddit-post>, <ytd-…>) on
    // newer ones, and a hand-written list of container tags misses both.
    const containers = Array.from(document.querySelectorAll('*'));
    const scored: { members: Element[]; score: number; sig: string }[] = [];

    for (const c of containers) {
      if (excluded(c)) continue;

      const kids = Array.from(c.children).filter(visible);
      if (kids.length < 3 || kids.length > 200) continue;

      /* Signature by tag+class first. Plenty of sites hash a unique class onto
         every card, so nothing ever "repeats" by that measure — fall back to
         the tag alone, which those same sites keep uniform. */
      const byClass = new Map<string, number>();
      kids.forEach((k) => byClass.set(sig(k), (byClass.get(sig(k)) || 0) + 1));
      let top = Array.from(byClass.entries()).sort((a, b) => b[1] - a[1])[0];
      let signatureOf = sig;

      if (!top || top[1] < 3) {
        const byTag = new Map<string, number>();
        kids.forEach((k) => byTag.set(k.tagName, (byTag.get(k.tagName) || 0) + 1));
        const tagTop = Array.from(byTag.entries()).sort((a, b) => b[1] - a[1])[0];
        if (tagTop && tagTop[1] >= 3) {
          top = tagTop;
          signatureOf = (el: Element) => el.tagName;
        }
      }

      if (!top || top[1] < 3) continue;

      const members = kids.filter((k) => signatureOf(k) === top[0]);
      const textLen =
        members.reduce((sum, m) => sum + clean((m as HTMLElement).innerText).length, 0) / members.length;
      if (textLen < 15 || textLen > 4000) continue;

      // Real results differ from each other. A block where every row opens with
      // the same words ("Jump up", "Read more") is boilerplate, not content.
      const openings = new Set(
        members.map((m) => clean((m as HTMLElement).innerText).slice(0, 40).toLowerCase()),
      );
      void signatureOf;
      const distinctness = openings.size / members.length;
      if (distinctness < 0.5) continue;

      scored.push({
        members,
        // A tag-only signature is a valid selector too.
        sig: top[0],
        score: scoreGroup(members),
      });
    }

    scored.sort((a, b) => b.score - a.score);

    if (scored.length) {
      const winner = scored[0];

      /* Endless-scroll pages append a NEW section per batch, each holding its
         own copy of the list. Reading one container therefore returns only the
         first screenful. Collect every block sharing the winning signature,
         wherever it lives. */
      const selector = winner.sig
        .replace(/^([A-Z0-9-]+)/, (t) => t.toLowerCase())
        .replace(/\./g, '.');

      let all: Element[] = [];
      try {
        all = Array.from(document.querySelectorAll(selector)).filter(visible);
      } catch {
        all = [];
      }

      // Guard against a signature so generic it matches half the page.
      const usable =
        all.length >= winner.members.length && all.length <= winner.members.length * 40
          ? all.filter((el) => !all.some((other) => other !== el && el.contains(other)))
          : winner.members;

      groups.push(usable);
    }
  }

  /* One result is still a result.
   *
   * Every rule above needs three repeating siblings, because that is what makes
   * a list detectable. A search that matched a single product has no siblings
   * to repeat — so the detector looks past it and settles on whatever else on
   * the page comes in threes, which is how a fridge search returned Search,
   * Awards, Newsroom and Media and Events.
   *
   * A card does not need siblings to be recognisable: a picture, a link, and a
   * price on a line of its own. Where the repeated block has none of that and
   * cards like this exist, the cards are the results.
   */
  const cardLike = (): Element[] => {
    const PRICE_LINE = /^(?:[^\w\s]{0,3}\s?)?[\d][\d,.]{2,}(?:\s?[A-Z]{2,4})?$/;
    const found: Element[] = [];

    for (const el of Array.from(document.querySelectorAll('*'))) {
      if (found.length >= 40) break;
      if (!visible(el) || !el.children.length) continue;

      // Raw innerText: `clean` flattens the newlines, and a price is only
      // recognisable because it sits on a line of its own.
      const lines = ((el as HTMLElement).innerText ?? '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      // A card is small. A section containing every card is not.
      if (!lines.length || lines.length > 14) continue;
      if (!el.querySelector('img') || !el.querySelector('a[href]')) continue;
      if (!lines.some((l) => PRICE_LINE.test(l))) continue;

      found.push(el);
    }

    // Keep the innermost of any nested run — the card, not its wrapper.
    return found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
  };

  const best = groups[0];
  const looksThin =
    !best ||
    best.filter((m) => m.querySelector('img') && /[\d][\d,.]{2,}/.test((m as HTMLElement).innerText ?? ''))
      .length /
      best.length <
      0.34;

  if (!compiledGroup && looksThin) {
    const cards = cardLike();
    if (cards.length) {
      groups.length = 0;
      groups.push(cards);
    }
  }

  /* The compiled selector was written from one recording of one page, months
     ago. When the detector finds a clearly better block on the page in front of
     it — more results, pictures where there were none — that wins. "Clearly"
     matters: a narrow margin means they are looking at the same list, and the
     compiled selector is the more deliberate choice. */
  if (compiledGroup) {
    const detected = groups[0];
    const compiledScore = scoreGroup(compiledGroup);
    const detectedScore = detected ? scoreGroup(detected) : 0;
    if (!detected || compiledScore >= detectedScore * 0.85) {
      groups.length = 0;
      groups.push(compiledGroup);
    }
  }

  const nodes = (groups[0] || []).slice(0, 200);

  /* ── per-item facts ──────────────────────────────────────────────── */

  const PRICE =
    /(?:BDT|USD|EUR|GBP|INR|৳|\$|€|£|₹|Rs\.?|Tk\.?)\s?[\d,.]{2,}|[\d,.]{2,}\s?(?:BDT|USD|EUR|GBP|INR|taka|tk)/i;
  const DURATION = /^\d{1,2}:\d{2}(:\d{2})?$/;
  const COUNT = /\b[\d.,]+\s?[KMB]?\s+(views|reviews|ratings|watching|subscribers|sold)\b/i;
  const AGO = /\b\d+\s+(second|minute|hour|day|week|month|year)s?\s+ago\b/i;

  return nodes.map((el) => {
    const text = clean((el as HTMLElement).innerText).slice(0, 1500);
    /* `clean` flattens every newline into a space, which is right for reading a
       card as one string and wrong for anything that depends on how the card is
       laid out. A price sits on its own line — that is what separates it from a
       number inside a sentence — so the line-based reads below need the text as
       the page actually renders it. */
    const rawLines = ((el as HTMLElement).innerText ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 60);

    const link =
      (Array.from(el.querySelectorAll('a[href]')).find((a) => {
        const href = a.getAttribute('href') ?? '';
        return href && !href.startsWith('#') && !href.startsWith('javascript:');
      }) as HTMLAnchorElement | undefined) ?? (el.matches('a[href]') ? (el as HTMLAnchorElement) : null);

    const heading = el.querySelector(
      'h1,h2,h3,h4,[role="heading"],[class*="title" i],[class*="name" i],[id*="title" i]',
    );

    const titleText = collapseRepeat(
      clean((heading as HTMLElement | null)?.innerText) ||
        clean(link?.getAttribute('title')) ||
        clean(link?.getAttribute('aria-label')) ||
        clean((link as HTMLElement | null)?.innerText) ||
        text.split('\n')[0].slice(0, 120),
    );

    /* price — only from a dedicated element, or from short text.
       Pulling a currency match out of a long description invents prices that
       aren't prices ("...won £20000 in the challenge"). */
    const priceEl = el.querySelector(
      '[class*="price" i]:not([class*="pricing" i]),[class*="fare" i],[class*="amount" i],[class*="cost" i],' +
        // data-testid is a testing convention rather than any one site's markup,
        // and it is where component-driven sites put the label that used to be a
        // class name. Ignoring it is why prices and ratings came back blank on
        // exactly the sites that are hardest to scrape.
        '[data-testid*="price" i],[data-price],[itemprop="price"]',
    );
    /* The element has to actually hold a price. "View Fares" matches
       `[class*="fare"]` perfectly well, and taking it on trust both produced a
       nonsense price and skipped the fallback that would have found the real
       one two lines below it. */
    const priceElText = clean((priceEl as HTMLElement | null)?.innerText);
    /* Take the price *out* of the element, rather than taking the element's
       whole text as the price. Sites label the number in the same box they
       print it in — "Starting from BDT 1,830,266", "from $45 per night" — and
       keeping the label made the value too long to be a price, which silently
       discarded it and skipped the line-based fallback below. */
    let priceText = PRICE.test(priceElText)
      ? ((priceElText.match(PRICE) || [])[0] ?? '')
      : /^[\d][\d,.]*$/.test(priceElText)
        ? priceElText
        : '';
    // A "price" longer than this is a sentence that happens to contain a
    // number. Checked here so an over-long read still falls through.
    if (priceText.length > 24) priceText = '';

    /* No element admitted to being the price. Read the lines instead.
     *
     * Requiring a `price`-ish class or testid works right up until a site
     * renames its components — booking ships `property-card` markup to some
     * sessions and hashed class names to others, so the same search returns
     * prices one run and blanks the next. A price is written on a line of its
     * own on every site there has ever been, and a short line is what tells it
     * apart from "...won £20000 in the challenge" buried in a description. */
    if (!priceText) {
      const lines = rawLines.filter((s) => s.length <= 34);

      const line = lines.find((s) => PRICE.test(s));
      if (line) priceText = (line.match(PRICE) || [])[0] ?? '';

      /* Plenty of sites put the currency in its own element, so the card reads
         "BDT" then "4,349" on separate lines and a single-line match finds
         nothing at all — which is why every GoZayaan fare came back blank. */
      if (!priceText) {
        const CURRENCY = /^(?:BDT|USD|EUR|GBP|INR|Tk\.?|Rs\.?|৳|\$|€|£|₹)$/i;
        for (let i = 0; i < lines.length - 1; i += 1) {
          if (!CURRENCY.test(lines[i])) continue;
          if (!/^[\d][\d,.]*$/.test(lines[i + 1])) continue;
          priceText = `${lines[i]} ${lines[i + 1]}`;
          break;
        }
      }
    }
    if (priceText && priceText.length > 24) priceText = '';

    const ratingEl = el.querySelector(
      '[class*="rating" i],[class*="score" i],[aria-label*="rating" i],[aria-label*="scored" i],' +
        '[data-testid*="rating" i],[data-testid*="review-score" i],[itemprop="ratingValue"]',
    );

    /* structured facts, deduplicated. Nested elements match the same selectors,
       which is how "1:05:58" ends up printed three times. */
    const seen = new Set<string>();
    const attributes: { label: string; value: string }[] = [];
    const addAttr = (label: string, value: string) => {
      const v = collapseRepeat(value);
      if (!v || v.length > 90) return;
      const key = v.toLowerCase();
      if (seen.has(key)) return;
      if (titleText.toLowerCase().includes(key)) return; // already in the title
      seen.add(key);
      attributes.push({ label, value: v });
    };

    // Definition lists and two-cell rows are explicit label/value pairs.
    el.querySelectorAll('dt').forEach((dt) => {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') addAttr(clean(dt.innerText), (dd as HTMLElement).innerText);
    });

    /* ── facts that mean the same thing on every site ──────────────────
       These are pulled out by name rather than dumped into the attribute
       list, because the renderer places them deliberately: a duration goes on
       the thumbnail, a rating next to the price, a channel under the title.
       Everything here is a general web convention, not one site's markup. */

    const first = (selector: string, test?: RegExp): string | undefined => {
      for (const node of Array.from(el.querySelectorAll<HTMLElement>(selector))) {
        const t = collapseRepeat(clean(node.innerText));
        if (!t || t.length > 90) continue;
        if (test && !test.test(t)) continue;
        return t;
      }
      return undefined;
    };

    const meta: Record<string, string | undefined> = {};

    /* Only from an element that says it is a duration. "asked Aug 6 at 9:54"
       ends in something that looks exactly like a runtime, and trusting loose
       text here turned a page of questions into a page of videos. */
    meta.duration = first(
      '[class*="duration" i],[class*="length" i],[class*="time-status" i],[class*="runtime" i]',
      DURATION,
    );

    const viewMatch = text.match(/\b[\d.,]+\s?[KMB]?\s+(?:views|watching|plays|listeners)\b/i);
    if (viewMatch) meta.views = viewMatch[0];

    const reviewMatch = text.match(/\b[\d.,]+\s?[KMB]?\s+(?:reviews|ratings)\b/i);
    if (reviewMatch) meta.reviews = reviewMatch[0];

    const agoMatch = text.match(new RegExp(AGO, 'i'));
    const dateEl = el.querySelector<HTMLElement>('time[datetime],[class*="date" i],[class*="published" i]');
    meta.published =
      agoMatch?.[0] ??
      (dateEl ? clean(dateEl.innerText).slice(0, 40) || dateEl.getAttribute('datetime') || undefined : undefined);

    meta.author = first(
      '[class*="channel" i],[class*="author" i],[class*="byline" i],[class*="owner" i],[rel="author"],[itemprop="author"]',
    );
    meta.source = first('[class*="source" i],[class*="publisher" i],cite,[data-n-tid]');
    meta.location = first(
      '[class*="location" i],[class*="address" i],[class*="region" i],[class*="district" i],' +
        '[data-testid*="address" i],[data-testid*="location" i],[data-testid*="distance" i]',
    );

    /* Repositories: a star count and a primary language.
       "4.6 out of 5 stars" is a product rating wearing the same word, so the
       count has to look like a tally — a plain number, optionally abbreviated,
       and nothing else. */
    meta.stars = first(
      '[href$="/stargazers"],[class*="star" i][class*="count" i],[aria-label*="star" i]',
      /^[\d,.]+\s?[km]?$/i,
    );
    meta.language = first('[itemprop="programmingLanguage"],[class*="language" i]', /^[A-Za-z+#. ]{2,20}$/);

    // Discussions: points/votes and a comment count.
    const pointsMatch = text.match(/\b[\d.,]+\s+(?:points?|votes?|upvotes?)\b/i);
    if (pointsMatch) meta.points = pointsMatch[0];
    const commentMatch = text.match(/\b[\d.,]+\s+(?:comments?|answers?|replies)\b/i);
    if (commentMatch) meta.comments = commentMatch[0];

    /* The same facts still go into the attribute list, so the generic renderer
       — and any result type without a bespoke layout — keeps showing them. */
    if (meta.duration) addAttr('Duration', meta.duration);
    if (meta.views) addAttr('', meta.views);
    if (meta.published) addAttr('', meta.published);
    if (meta.author) addAttr('', meta.author);
    if (meta.location) addAttr('', meta.location);

    const counts = text.match(new RegExp(COUNT, 'i'));
    if (counts) addAttr('', counts[0]);

    /* badges — same dedupe, and never repeat a fact we already listed */
    const badges: string[] = [];
    const badgeSeen = new Set(seen);
    for (const b of Array.from(
      el.querySelectorAll<HTMLElement>('[class*="badge" i],[class*="tag" i],[class*="label" i],[class*="chip" i],[class*="pill" i]'),
    )) {
      const t = clean(b.innerText);
      if (!t || t.length > 28) continue;
      const key = t.toLowerCase();
      if (badgeSeen.has(key)) continue;
      if (titleText.toLowerCase().includes(key)) continue;
      badgeSeen.add(key);
      badges.push(t);
      if (badges.length >= 4) break;
    }

    /* Cards concatenate everything they hold, so a title read from the block
       often arrives wearing its own byline: "Fox Business More Tesla files
       plans … Yesterday By James Cirrone". Anything already captured as a named
       fact is not part of the headline, so take it back out. */
    let title = titleText;
    for (const fragment of [meta.source, meta.author, meta.published, meta.duration, meta.views]) {
      if (fragment && fragment.length > 2) title = title.split(fragment).join(' ');
    }
    /* "… clean energy milestone By Chris Martin" — a byline the card ran onto
       the end of the headline. It is a fact about the result, not part of its
       name, so it moves rather than disappears. */
    const trailingByline = title.match(/\s+By\s+([A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+){0,3})\s*$/);
    if (trailingByline) {
      title = title.slice(0, trailingByline.index);
      meta.author = meta.author || trailingByline[1];
    }

    title = title
      .replace(/\s+/g, ' ')
      .replace(/^\s*(?:more|new)\b/i, '')
      .replace(/\bby\s*$/i, '')
      .replace(/^[\s·|•\-–—,]+|[\s·|•\-–—,]+$/g, '')
      .trim();
    // If stripping ate the headline, the original was the better answer.
    if (title.length < 10) title = titleText;

    // The description is whatever the card says beyond its own title.
    const withoutTitle = text.startsWith(titleText) ? text.slice(titleText.length).trim() : text;

    return {
      title,
      subtitle:
        clean(
          (el.querySelector('[class*="subtitle" i],[class*="secondary" i],[class*="snippet" i]') as HTMLElement | null)
            ?.innerText,
        ) || undefined,
      description: withoutTitle ? withoutTitle.slice(0, 320) : undefined,
      url: link ? abs(link.getAttribute('href')) : undefined,
      image: pickImage(el),
      priceText: priceText || undefined,
      ratingText:
        clean((ratingEl as HTMLElement | null)?.innerText) ||
        ratingEl?.getAttribute('aria-label') ||
        ratingEl?.getAttribute('content') ||
        /* Same reasoning as the price: the score is written plainly on the
           card — "Scored 8.4", "8.4 Very good", "4.5 out of 5" — whether or
           not any element is willing to be selected by name. */
        (text.match(/\bscored\s+\d(?:[.,]\d)?\b/i) ||
          text.match(/\b\d(?:[.,]\d)?\s*(?:\/|out of)\s*(?:5|10)\b/i) ||
          [])[0]?.trim() ||
        // A score on a line by itself — only meaningful with the real newlines.
        rawLines.find((s) => /^\d(?:[.,]\d)?$/.test(s)) ||
        undefined,
      badges,
      attributes: attributes.slice(0, 6),
      meta,
      text,
      lines: rawLines.slice(0, 48),
    };
  });
}

/* ── itineraries ─────────────────────────────────────────────────────────
   A flight is the one common result that says almost nothing in its heading.
   Every card on a results page is headed with the airline, so ten different
   itineraries arrive as ten copies of "Qatar Airways" with the times, the
   route, the duration and the stops scattered across separate lines that the
   generic reader has no reason to connect.

   The shape is a web-wide convention rather than one site's markup: a time,
   an airport code, how long it takes, how many stops, then the same again for
   where it lands. Read positionally so a leg without a day-shift marker does
   not drag every later leg out of alignment. */

const AIRPORT = /^[A-Z]{3}$/;
const CLOCK = /^\d{1,2}:\d{2}$/;
const LEG_DURATION = /^\d{1,2}\s?h(?:\s?\d{1,2}\s?m)?$/i;
const STOPS = /^(?:non[-\s]?stop|direct|\d+\s?stops?)$/i;
const DAY_SHIFT = /^\+\s?\d+\s?days?$/i;

/** Three uppercase letters that are money rather than a place. */
const CURRENCY_CODES = new Set([
  'BDT', 'USD', 'EUR', 'GBP', 'INR', 'AED', 'SAR', 'QAR', 'KWD', 'OMR', 'PKR',
  'NPR', 'LKR', 'THB', 'MYR', 'IDR', 'PHP', 'JPY', 'CNY', 'KRW', 'AUD', 'CAD',
  'CHF', 'SEK', 'NOK', 'DKK', 'TRY', 'ZAR', 'RUB', 'BRL', 'MXN',
]);

export interface Itinerary {
  /** "DAC → JFK", or "DAC → JFK → DAC" for a return. */
  route: string;
  legs: { label: string; value: string }[];
}

/**
 * Reads an itinerary out of a card's lines, or returns nothing.
 *
 * Deliberately strict: two airport codes, two clock times and a duration or a
 * stop count. Anything less is a page that happens to contain capital letters,
 * and inventing a route for it would be worse than leaving the card alone.
 */
export function readItinerary(lines: string[]): Itinerary | undefined {
  const codes: number[] = [];
  const times: number[] = [];
  let durations = 0;
  let stops = 0;

  lines.forEach((line, i) => {
    if (AIRPORT.test(line) && !CURRENCY_CODES.has(line)) codes.push(i);
    else if (CLOCK.test(line)) times.push(i);
    else if (LEG_DURATION.test(line)) durations += 1;
    else if (STOPS.test(line)) stops += 1;
  });

  if (codes.length < 2 || times.length < 2) return undefined;
  if (durations === 0 && stops === 0) return undefined;

  /* One leg per pair of codes. A trailing odd code is a stray — a baggage
     allowance, an alliance badge — and is dropped rather than guessed at. */
  const legs: { label: string; value: string }[] = [];
  const stations: string[] = [];

  for (let pair = 0; pair + 1 < codes.length && pair < 6; pair += 2) {
    const fromIdx = codes[pair];
    const toIdx = codes[pair + 1];

    // The time for a station is the last one printed before it.
    const before = (idx: number) => {
      const hit = [...times].reverse().find((t) => t < idx);
      return hit === undefined ? undefined : lines[hit];
    };
    const between = (re: RegExp) => lines.slice(fromIdx, toIdx).find((l) => re.test(l));

    const from = lines[fromIdx];
    const to = lines[toIdx];
    const depart = before(fromIdx);
    const arrive = before(toIdx);
    if (!depart || !arrive || depart === arrive) continue;

    const shift = lines.slice(fromIdx, toIdx).find((l) => DAY_SHIFT.test(l));
    const duration = between(LEG_DURATION);
    const stopText = between(STOPS);

    const value = [
      `${depart} ${from} → ${arrive}${shift ? ` (${shift.replace(/\s/g, '')})` : ''} ${to}`,
      duration,
      stopText,
    ]
      .filter(Boolean)
      .join(' · ');

    legs.push({ label: legs.length === 0 ? 'Outbound' : legs.length === 1 ? 'Return' : `Leg ${legs.length + 1}`, value });
    if (!stations.length) stations.push(from);
    stations.push(to);
  }

  if (!legs.length) return undefined;
  return { route: stations.join(' → '), legs };
}

/**
 * Ranks every repeated block on the page and returns them with a selector.
 *
 * Same reasoning the extractor uses, exposed so a failure can be inspected —
 * and so the UI can offer the runner-up when the top pick is wrong. Runs in the
 * page, so it must stay self-contained.
 */
function scoreRegions(): {
  selector: string;
  count: number;
  score: number;
  samples: string[];
  chosen: boolean;
}[] {
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    // A dense list row (a table of links, a compact feed) is barely taller than
    // its text. Demanding 24px quietly excluded whole sites.
    if (r.width < 40 || r.height < 12) return false;
    const st = getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  };

  const stableClasses = (el: Element) =>
    Array.from(el.classList).filter(
      (c) => c.length > 2 && c.length < 40 && !/^(css|sc|jsx)-/.test(c) && !/\d{4,}/.test(c),
    );

  /** A selector that matches this set of siblings and nothing much else. */
  const selectorFor = (members: Element[]): string => {
    const first = members[0];
    const tag = first.tagName.toLowerCase();

    // Custom elements are already unique enough on their own.
    if (tag.includes('-')) return tag;

    // A class shared by every member is the clearest signal.
    const shared = stableClasses(first).filter((c) => members.every((m) => m.classList.contains(c)));
    if (shared.length) return `${tag}.${shared.slice(0, 2).join('.')}`;

    // Otherwise anchor to the parent.
    const parent = first.parentElement;
    if (parent) {
      if (parent.id && !/^\d|:/.test(parent.id)) return `#${parent.id} > ${tag}`;
      const parentClass = stableClasses(parent)[0];
      if (parentClass) return `.${parentClass} > ${tag}`;
    }
    return tag;
  };

  const EXCLUDE =
    'nav, footer, aside, header, [role="navigation"], [role="contentinfo"], [role="banner"], ' +
    '[role="doc-endnotes"], .references, .reflist, .navbox, .catlinks, .toc, ' +
    '[class*="footnote" i], [class*="breadcrumb" i], [class*="pagination" i], ' +
    '[class*="sidebar" i], ' +
    /* Plenty of sites never use the semantic tags. Walton's footer is a plain
       <div class="footer"> holding five columns of links, which is a textbook
       repeated block — uniform, linked, evenly sized — and it scored well
       enough to be returned as nine "products" for a fridge search that had
       found exactly one. Matching on the name catches those. */
    '[class*="footer" i], [id*="footer" i], [class*="site-header" i], [id*="header" i], ' +
    '[class*="topbar" i], [class*="menu" i], [class*="navbar" i]';

  /* Same guard as `detectItems`, and for the same reason: `closest` reaches
     the root element, and a substring rule that matches there disqualifies the
     whole page. Kept identical to that copy on purpose — when these two lists
     drifted apart before, the results came from the wrong one. */
  const excluded = (el: Element): boolean => {
    const hit = el.closest(EXCLUDE);
    return Boolean(hit) && hit !== document.documentElement && hit !== document.body;
  };

  const scored: { selector: string; count: number; score: number; samples: string[] }[] = [];
  const seenSelectors = new Set<string>();

  for (const container of Array.from(
    // Every element, not a fixed tag list: results live in <tbody> rows on
    // older sites and inside custom elements (<shreddit-post>, <ytd-…>) on
    // newer ones, and a hand-written list of container tags misses both.
    document.querySelectorAll('*'),
  )) {
    if (excluded(container)) continue;

    const kids = Array.from(container.children).filter(visible);
    if (kids.length < 3 || kids.length > 200) continue;

    // Group by tag+class, then by tag alone for sites that hash every class.
    for (const mode of ['class', 'tag'] as const) {
      const counts = new Map<string, Element[]>();
      for (const kid of kids) {
        const key =
          mode === 'tag'
            ? kid.tagName
            : kid.tagName + stableClasses(kid).slice(0, 3).map((c) => `.${c}`).join('');
        const list = counts.get(key) ?? [];
        list.push(kid);
        counts.set(key, list);
      }

      const best = Array.from(counts.values()).sort((a, b) => b.length - a.length)[0];
      if (!best || best.length < 3) continue;

      const texts = best.map((m) => clean((m as HTMLElement).innerText));
      const avgLen = texts.reduce((s, t) => s + t.length, 0) / texts.length;
      if (avgLen < 15 || avgLen > 4000) continue;

      const distinct = new Set(texts.map((t) => t.slice(0, 40).toLowerCase())).size / texts.length;
      if (distinct < 0.5) continue;

      const withLinks = best.filter((m) => {
        const href = m.querySelector('a[href]')?.getAttribute('href') ?? '';
        return href && !href.startsWith('#');
      }).length;
      const withImages = best.filter((m) => m.querySelector('img')).length;
      const withHeadings = best.filter((m) => m.querySelector('h1,h2,h3,h4,[role="heading"]')).length;
      const withBoth = best.filter((m) => m.querySelector('img') && m.querySelector('a[href]')).length;

      // Signals for lists that carry neither — see the note in detectItems.
      const listy = best.filter((m) => {
        const tag = m.tagName.toLowerCase();
        return (
          tag === 'li' ||
          tag === 'article' ||
          tag === 'tr' ||
          tag.includes('-') ||
          m.getAttribute('role') === 'listitem' ||
          m.getAttribute('role') === 'article'
        );
      }).length;

      const DATA = /[\d]{1,3}[:,.]\d|\b\d+\s?(?:hr|min|h|m|km|mi)\b|[$€£₹৳]|\b\d{2,}\b/i;
      const dataRich = texts.filter((t) => DATA.test(t)).length;

      const spread =
        avgLen > 0
          ? texts.reduce((s, t) => s + Math.abs(t.length - avgLen), 0) / texts.length / avgLen
          : 1;
      const uniformity = Math.max(0, 1 - spread);

      const selector = selectorFor(best);
      if (seenSelectors.has(selector)) continue;
      seenSelectors.add(selector);

      scored.push({
        selector,
        count: best.length,
        /* Must match scoreGroup in detectItems exactly, or this picker lists a
           different winner than the extractor actually used. */
        score: Math.round(
          Math.min(best.length, 40) * 3.0 +
            (withLinks / best.length) * 20 +
            (withImages / best.length) * 18 +
            (withBoth / best.length) * 14 +
            (withHeadings / best.length) * 12 +
            (listy / best.length) * 12 +
            (dataRich / best.length) * 14 +
            uniformity * 12 +
            Math.min(avgLen / 40, 15) +
            distinct * 15,
        ),
        samples: texts.slice(0, 3).map((t) => t.slice(0, 70)),
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8).map((c, i) => ({ ...c, chosen: i === 0 }));
}

/**
 * Does this text *say* the hint, rather than merely contain those characters?
 *
 * A plain substring test is why an Amazon search for "usb c cable" came back
 * empty: the page says "1-16 of over 40,000 results", which contains "0
 * results", which is the hint for a page that found nothing. Fifteen real
 * products were discarded on the strength of the last digit of forty thousand.
 *
 * So a hint has to begin and end on a boundary. Digits and separators count as
 * word characters here — "40,000" must not be allowed to end in a "0" that
 * starts the match.
 */
export function saysHint(text: string, hint: string): boolean {
  const needle = hint.trim().toLowerCase();
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w,.])${escaped}(?![\\w])`, 'i').test(text);
}

/**
 * Works out what the results actually are, from the results themselves.
 *
 * Deliberately evidence-based rather than URL-based: a site is not a category,
 * and the same host serves videos on one page and articles on another. What
 * decides it is what most items carry — a duration and a channel is a video, a
 * price and a picture is a product, stars and a language is a repository.
 */
function inferResultKind(items: ResultItem[]): ResultKind {
  if (items.length === 0) return 'generic';

  const share = (test: (i: ResultItem) => boolean) =>
    items.filter(test).length / items.length;

  const withDuration = share((i) => Boolean(i.meta.duration));
  const withPrice = share((i) => Boolean(i.price));
  const withRating = share((i) => typeof i.rating === 'number');
  const withImage = share((i) => Boolean(i.image));
  const withStars = share((i) => Boolean(i.meta.stars));
  const withLanguage = share((i) => Boolean(i.meta.language));
  const withPoints = share((i) => Boolean(i.meta.points || i.meta.comments));
  const withPublished = share((i) => Boolean(i.meta.published));
  const withLocation = share((i) => Boolean(i.meta.location));
  const withReviews = share((i) => Boolean(i.meta.reviews));
  const withViews = share((i) => Boolean(i.meta.views));

  /* A parsed itinerary is the least ambiguous signal there is — nothing else
     produces one — so it is asked first. Without this a flight reads as a
     product (a picture and a fare) or, when the fare fails to parse, as an
     article (a date and no price). */
  if (share((i) => i.attributes.some((a) => a.label === 'Route')) >= 0.5) return 'flight';

  // Order matters: the more specific signals get first refusal.
  if (withDuration >= 0.5 && withImage >= 0.5) return 'video';
  if (withDuration >= 0.4 && withViews >= 0.4) return 'video';

  /* Code, not commerce. A star count alone is ambiguous — plenty of shops
     render "stars" next to a rating — so it only counts when nothing is for
     sale. A declared language is unambiguous on its own. */
  if (withLanguage >= 0.4) return 'repo';
  if (withStars >= 0.5 && withPrice < 0.2 && withImage < 0.4) return 'repo';

  /* A place to stay is the combination nothing else has: a photo, somewhere it
     is, and a body of reviews. Location is what separates it from a product —
     shops have pictures, prices and review counts too, but nothing to say
     where the thing is. */
  if (withImage >= 0.5 && withLocation >= 0.4 && (withReviews >= 0.3 || withRating >= 0.3)) {
    return 'stay';
  }

  if (withPrice >= 0.4 && withImage >= 0.4) return 'product';
  if (withPoints >= 0.5) return 'discussion';
  if (withPublished >= 0.5 && withPrice < 0.2) return 'article';
  if (withLocation >= 0.5) return 'place';
  if (withRating >= 0.5 && withImage >= 0.5) return 'product';
  return 'generic';
}

/**
 * Do these look like results, or like the site's own navigation?
 *
 * A row of category tiles — "Hotels", "Apartments", "Resorts" — is repeated,
 * linked and pictured, which is everything a structural detector looks for. The
 * giveaway is that they say nothing: no price, no rating, no date, no
 * description, just a word. Real results carry facts about themselves.
 *
 * Both conditions have to hold, because plenty of honest result lists are
 * sparse: a list of article links has no prices either, but its titles are
 * sentences rather than single words.
 */
export function looksLikeNavigation(items: ResultItem[]): boolean {
  if (items.length < 3) return false;

  const substantive = items.filter(
    (i) =>
      i.price ||
      typeof i.rating === 'number' ||
      Object.keys(i.meta).length > 0 ||
      (i.description?.length ?? 0) > 40,
  ).length;

  /* Any one item carrying a real fact is enough to call this a list.
   *
   * A proportional test was tried and reverted: it read Amazon's own results
   * and a page of article links as navigation and threw both away. Sparse
   * lists are normal, and the cost of being wrong here is deleting somebody's
   * actual results — so the benefit of the doubt goes to the page. The Walton
   * footer case is handled where it belongs, by not scanning footers. */
  if (substantive > 0) return false;

  /* Pictures are the deciding vote at run time.
   *
   * A shop's product grid can be as terse as any menu — "WIWH-GSN-45A" with no
   * price on the listing page — but every tile carries a photograph of the
   * thing itself. Telling that user their five water heaters were "nothing to
   * show" is far worse than occasionally rendering a menu, so anything with
   * images gets shown. Authoring-time verification stays strict, because that
   * is where a wrong page can still be rejected cheaply. */
  const withImages = items.filter((i) => i.image).length;
  if (withImages / items.length > 0.5) return false;

  const averageTitle = items.reduce((sum, i) => sum + i.title.length, 0) / items.length;
  return averageTitle < 32;
}

/** Pull a number + currency out of "৳ 12,450" or "USD 145.00". */
function parsePrice(text: string | undefined) {
  if (!text) return undefined;
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const num = cleaned.match(/[\d][\d,.\s]*/);
  if (!num) return undefined;
  const amount = Number.parseFloat(num[0].replace(/[,\s]/g, ''));
  if (!Number.isFinite(amount)) return undefined;

  const symbols: Record<string, string> = { '৳': 'BDT', $: 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR' };
  const symbol = Object.keys(symbols).find((s) => cleaned.includes(s));
  const code = cleaned.match(/\b(BDT|USD|EUR|GBP|INR|AED|SAR|JPY|CNY|AUD|CAD)\b/i)?.[1]?.toUpperCase();
  const currency = code || (symbol ? symbols[symbol] : undefined);
  // A bare number with no currency marker anywhere isn't a price.
  if (!currency) return undefined;

  return { amount, currency, formatted: cleaned.slice(0, 30) };
}

function parseRating(text: string | undefined) {
  if (!text) return undefined;
  const m = text.match(/(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+))?/);
  if (!m) return undefined;
  const value = Number.parseFloat(m[1]);
  if (!Number.isFinite(value)) return undefined;
  const scale = m[2] ? Number.parseInt(m[2], 10) : value <= 5 ? 5 : 10;
  if (value > scale) return undefined;
  return Math.round((value / scale) * 50) / 10; // normalise to /5
}

/**
 * Scrolls to the bottom in steps, then back up.
 *
 * Lazy images and virtualised lists only load what has been near the viewport,
 * so scraping without this returns blank thumbnails and a fraction of the rows.
 */
/**
 * Scrolls whatever the page actually scrolls, one screen at a time.
 *
 * Plenty of applications never scroll the document: they put the content in a
 * div with `overflow-y: auto` and leave `document.body.scrollHeight` at zero.
 * Calling `window.scrollBy` on those pages does nothing at all, so lazy content
 * never loads and only the first screenful is ever scraped.
 */
const SCROLL_STEP = function scrollStep(): number {
  const scrollable = (el: Element | null): boolean => {
    if (!el) return false;
    const style = getComputedStyle(el);
    const canScroll = /(auto|scroll|overlay)/.test(style.overflowY);
    return canScroll && el.scrollHeight > el.clientHeight + 40;
  };

  let scroller: Element | null = null;

  const root = document.scrollingElement ?? document.documentElement;
  if (root && root.scrollHeight > root.clientHeight + 40) {
    scroller = root;
  } else {
    // Biggest scrollable box on the page is the content area.
    let bestArea = 0;
    for (const el of Array.from(document.querySelectorAll('div, main, section, [role="main"]'))) {
      if (!scrollable(el)) continue;
      const r = el.getBoundingClientRect();
      const area = r.width * r.height;
      if (area > bestArea) {
        bestArea = area;
        scroller = el;
      }
    }
  }

  if (!scroller) {
    window.scrollBy(0, window.innerHeight * 0.92);
    return document.documentElement.scrollHeight || document.body?.scrollHeight || 0;
  }

  scroller.scrollTop += scroller.clientHeight * 0.92;
  return scroller.scrollHeight;
};

/** Sends whichever scroller is in charge back to the top. */
const SCROLL_TOP = function scrollTop(): void {
  const root = document.scrollingElement ?? document.documentElement;
  if (root && root.scrollHeight > root.clientHeight + 40) {
    root.scrollTop = 0;
    return;
  }
  for (const el of Array.from(document.querySelectorAll('div, main, section, [role="main"]'))) {
    const style = getComputedStyle(el);
    if (/(auto|scroll|overlay)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 40) {
      el.scrollTop = 0;
      return;
    }
  }
  window.scrollTo({ top: 0 });
};

/**
 * Waits until the page actually has content to read.
 *
 * Two things arrive at the results late and look identical from here: a
 * Cloudflare-style interstitial that swaps itself out after a few seconds, and
 * a single-page app that has loaded its shell but not yet painted. In both the
 * DOM is a handful of nodes with no text — scraping that returns zero items and
 * blames the site, while a screenshot taken twenty seconds later shows a
 * perfectly good page. Nothing here is site-specific: it is just "don't read a
 * page that hasn't rendered yet".
 */
export async function waitForContent(page: Page, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let previousText = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    const state = await page
      .evaluate(() => ({
        elements: document.querySelectorAll('*').length,
        text: (document.body?.innerText ?? '').trim().length,
        title: document.title,
      }))
      .catch(() => null);

    // Navigating (the interstitial handing over) — give it a moment and re-look.
    if (!state) {
      await page.waitForTimeout(700);
      continue;
    }

    const interstitial = /just a moment|verifying|checking your browser|attention required/i.test(
      state.title,
    );

    /* A real results page is hundreds of nodes and hundreds of characters. The
       thresholds are deliberately low — enough to tell "rendered" from "blank",
       not to judge whether the content is any good. */
    if (!interstitial && state.elements >= 150 && state.text >= 400) return;

    /* Some pages really are that small — a sparse search result, a plain
       confirmation. Once the text has held steady for a couple of seconds and
       no interstitial is on screen, this is the page, not a loading state. */
    stable = state.text > 0 && state.text === previousText ? stable + 1 : 0;
    previousText = state.text;
    if (!interstitial && stable >= 3) return;

    await page.waitForTimeout(700);
  }
}

/**
 * Counts the result blocks currently in the DOM.
 *
 * Height is a poor stand-in for "did more results load". Virtualised feeds
 * recycle their nodes and keep the document exactly as tall; sticky footers and
 * skeleton placeholders make a static page appear to grow. What actually
 * matters is whether there are more items than there were a moment ago, so
 * that is what gets measured — through the real selector when one is known.
 */
async function countItems(page: Page, itemSelector: string | null): Promise<number> {
  const bySelector = itemSelector ? await countBySelector(page, itemSelector) : 0;
  if (bySelector >= 3) return bySelector;
  return countRepeatedSiblings(page);
}

/** How many elements the compiled/pinned selector matches right now. */
async function countBySelector(page: Page, selector: string): Promise<number> {
  return page
    .evaluate((sel) => {
      try {
        return Array.from(document.querySelectorAll(sel)).filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width >= 40 && r.height >= 12;
        }).length;
      } catch {
        return 0;
      }
    }, selector)
    .catch(() => 0);
}

/**
 * Size of the largest family of repeated siblings on the page.
 *
 * Stands in for "how many results are showing" when no selector is known — the
 * same thing the detector will end up choosing, cheap enough to run on every
 * scroll step.
 */
async function countRepeatedSiblings(page: Page): Promise<number> {
  return page
    .evaluate(() => {
      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width >= 40 && r.height >= 12;
      };
      let best = 0;
      for (const container of Array.from(document.querySelectorAll('*'))) {
        const kids = Array.from(container.children).filter(visible);
        if (kids.length < 3) continue;
        const byTag = new Map<string, number>();
        for (const kid of kids) byTag.set(kid.tagName, (byTag.get(kid.tagName) ?? 0) + 1);
        const top = Math.max(...byTag.values());
        if (top > best) best = top;
      }
      return best;
    })
    .catch(() => 0);
}

/**
 * Waits for the results themselves, not merely for the page.
 *
 * A search application paints its header, its filter chips and its footer long
 * before the first result arrives — hundreds of elements and plenty of text,
 * enough to satisfy any "has the page rendered" check while the list is still
 * empty. Scraping in that window is how a run that works perfectly against the
 * same URL returns a handful of stragglers when it drives the site itself.
 */
async function waitForItems(
  page: Page,
  itemSelector: string | null,
  timeoutMs = 12_000,
): Promise<void> {
  /* When a selector is known, wait for THAT list specifically before settling
     for anything else. Otherwise a page showing only a shelf of suggestions
     looks "ready" — a handful of repeated siblings, perfectly stable — and the
     scrape captures the shelf while the real results are still on their way. */
  if (itemSelector) {
    const selectorDeadline = Date.now() + timeoutMs * 0.7;
    while (Date.now() < selectorDeadline) {
      if ((await countBySelector(page, itemSelector)) >= 3) {
        // Let the rest of the batch land before reading.
        await page.waitForTimeout(600);
        return;
      }
      await page.waitForTimeout(500);
    }
  }

  const deadline = Date.now() + timeoutMs * (itemSelector ? 0.3 : 1);
  let previous = -1;
  let stable = 0;

  while (Date.now() < deadline) {
    const count = await countRepeatedSiblings(page);

    // Growing — the list is still arriving, so keep waiting regardless.
    if (count !== previous) {
      stable = 0;
      previous = count;
    } else if (count >= 3) {
      stable += 1;
      if (stable >= 2) return;
    }

    await page.waitForTimeout(500);
  }
}

/**
 * Makes the page fetch the pictures it has been putting off.
 *
 * Scrolling loads the rows, but a thumbnail is a separate request that a lazy
 * image only starts once it is near the viewport — and by the time the scroll
 * pass has been up and down, the ones in the middle have been asked for and not
 * yet answered. Reading then gives a row of results with holes where the images
 * should be. Turning off lazy loading and waiting for the fetches to land costs
 * a second and fills them in.
 */
async function forceImagesToLoad(page: Page): Promise<void> {
  try {
    const pending = await page.evaluate(() => {
      let waiting = 0;
      for (const img of Array.from(document.querySelectorAll('img'))) {
        img.loading = 'eager';
        // Some lazy loaders only ever write to a data attribute.
        const deferred =
          img.getAttribute('data-src') ||
          img.getAttribute('data-lazy-src') ||
          img.getAttribute('data-original');
        if (deferred && !img.getAttribute('src')) img.setAttribute('src', deferred);
        if (!img.complete && img.getAttribute('src')) waiting += 1;
      }
      return waiting;
    });

    /* Some images have no `src` at all yet.
     *
     * A virtualising feed leaves the tail of the list as empty <img> elements
     * and only fills them in when its own observer says they are near the
     * viewport — so the last rows of a scrape come back with every fact
     * present and no picture. Nothing can force that but showing them to the
     * page. Bounded, because a long list should not be walked twice. */
    const blank = await page
      .evaluate(async () => {
        const empty = Array.from(document.querySelectorAll('img')).filter(
          (i) => !i.getAttribute('src') && !i.getAttribute('srcset'),
        );
        for (const img of empty.slice(0, 80)) {
          img.scrollIntoView({ block: 'center' });
          await new Promise((done) => setTimeout(done, 50));
        }
        window.scrollTo({ top: 0 });
        return empty.length;
      })
      .catch(() => 0);

    if (!pending && !blank) return;

    // Give the browser a moment, but never wait on a CDN that isn't answering.
    await page
      .waitForFunction(
        () => Array.from(document.querySelectorAll('img')).filter((i) => !i.complete).length < 3,
        undefined,
        { timeout: 5000 },
      )
      .catch(() => {});
  } catch {
    /* best effort — a missing thumbnail is not worth failing a run over */
  }
}

async function primeLazyContent(
  page: Page,
  budgetMs = 22_000,
  itemSelector: string | null = null,
): Promise<void> {
  /* Enough to fill any result page worth reading, and a hard stop so a truly
     endless feed can't run until the budget expires. Matches the cap the
     detector applies when it slices its node list. */
  const ENOUGH = 200;

  try {
    const deadline = Date.now() + budgetMs;
    const probe = () => countItems(page, itemSelector);

    /* Most pages are not endless. Scroll twice and look: if neither the height
       nor the item count moves, this is an ordinary page — take a couple of
       quick passes to trip any lazy images and get out. Spending the full
       infinite-scroll budget on a static page is most of where a two-minute
       run goes. */
    const firstHeight = await page.evaluate(SCROLL_STEP);
    const firstCount = await probe();
    await page.waitForTimeout(400);
    const secondHeight = await page.evaluate(SCROLL_STEP);
    await page.waitForTimeout(400);
    let previousCount = await probe();

    if (secondHeight === firstHeight && previousCount <= firstCount && firstHeight > 0) {
      for (let i = 0; i < 3; i += 1) {
        await page.evaluate(SCROLL_STEP);
        await page.waitForTimeout(280);
      }
      await page.evaluate(SCROLL_TOP);
      await page.waitForTimeout(250);
      return;
    }

    let previousHeight = secondHeight;
    let quiet = 0;

    while (Date.now() < deadline) {
      const height = await page.evaluate(SCROLL_STEP);
      await page.waitForTimeout(450);
      const count = await probe();

      /* Either signal counts as progress. A feed that recycles its nodes grows
         in height without gaining items; one that pins its footer gains items
         without growing. Requiring both is how a scrape stopped at fifteen
         videos on a page holding sixty. */
      if (count > previousCount || height !== previousHeight) {
        quiet = 0;
        previousCount = Math.max(previousCount, count);
        previousHeight = height;
        if (previousCount >= ENOUGH) break;
        continue;
      }

      /* Reaching the bottom is not the end. Endless-scroll pages only request
         the next batch once you sit there, and that round trip can take a
         couple of seconds — giving up after one quiet pass is what caps a
         scrape at the first screenful. Wait properly before believing it. */
      quiet += 1;
      await page.waitForTimeout(1500);
      const settledHeight = await page.evaluate(SCROLL_STEP);
      const settledCount = await probe();
      if (settledCount > previousCount || settledHeight !== height) {
        quiet = 0;
        previousCount = Math.max(previousCount, settledCount);
        previousHeight = settledHeight;
        continue;
      }
      if (quiet >= 3) break;
    }

    // Back to the top so lazy images above the fold get a chance too.
    await page.evaluate(SCROLL_TOP);
    await page.waitForTimeout(400);
  } catch {
    /* scrolling is best-effort */
  }
}

/**
 * Advances to the next page of results. Returns false when there isn't one.
 *
 * Covers the three shapes every site uses: an explicit next control, a numbered
 * pager, and infinite scroll.
 */
async function goToNextPage(page: Page, pageNumber: number): Promise<'clicked' | 'scrolled' | false> {
  const beforeCount = await countCandidates(page);

  // Infinite scroll first. Trying pagination controls first is what makes an
  // endless-scroll page click a carousel arrow labelled "Next" and go nowhere.
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate(SCROLL_STEP).catch(() => 0);
    await page.waitForTimeout(700);
  }
  if ((await countCandidates(page)) > beforeCount) return 'scrolled';

  /* Only controls that unambiguously page a result list. Anything inside a
     carousel, shelf or slider is navigating a widget, not the results. */
  const CAROUSEL = '[class*="carousel" i], [class*="shelf" i], [class*="slider" i], [class*="swiper" i]';

  const nextSelectors = [
    'a[rel="next"]',
    '[data-testid*="pagination-next" i]',
    '[class*="pagination" i] a[class*="next" i]',
    `[class*="pagination" i] a:text-is("${pageNumber + 1}")`,
    '[aria-label="Next page"]',
    'nav[aria-label*="pagination" i] a[aria-label*="next" i]',
    'button:has-text("Load more")',
    'button:has-text("Show more results")',
  ];

  for (const selector of nextSelectors) {
    const control = page.locator(selector).first();
    if (!(await control.isVisible({ timeout: 250 }).catch(() => false))) continue;
    if (await control.isDisabled().catch(() => false)) continue;
    // Skip anything living inside a horizontal widget.
    const inCarousel = await control
      .evaluate((el, sel) => Boolean(el.closest(sel)), CAROUSEL)
      .catch(() => false);
    if (inCarousel) continue;

    await control.scrollIntoViewIfNeeded().catch(() => {});
    await control.click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(1200);
    await page.waitForLoadState('domcontentloaded', { timeout: 10_000 }).catch(() => {});
    return 'clicked';
  }

  /* Nothing matched a known pattern. Plenty of pagers are a plain row of links
     — "|← First  ← Previous  1 2 3 4 5  Next → Last →|" — with no rel, no aria
     label and no class saying "next". Find them the way a reader does: a link
     whose text is the next page number, or the word next, sitting in a cluster
     of sibling links that are mostly numbers. */
  const href = await page
    .evaluate((wanted) => {
      const links = Array.from(document.querySelectorAll('a[href]')) as HTMLAnchorElement[];

      const numericNeighbours = (a: HTMLAnchorElement) => {
        const siblings = Array.from(a.parentElement?.parentElement?.querySelectorAll('a') ?? []);
        return siblings.filter((s) => /^\d{1,3}$/.test((s.textContent ?? '').trim())).length;
      };

      const candidates = links.filter((a) => {
        const text = (a.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (!text || text.length > 12) return false;
        const isNext = /^(next|next\s*[›→»>]|[›→»>])$/i.test(text) || text === String(wanted);
        if (!isNext) return false;
        // Must live among other page links, or it is just a link saying "next".
        return numericNeighbours(a) >= 2;
      });

      // Prefer the explicit page number over a generic "next".
      const exact = candidates.find((a) => (a.textContent ?? '').trim() === String(wanted));
      return (exact ?? candidates[0])?.href ?? null;
    }, pageNumber + 1)
    .catch(() => null);

  if (href && href !== page.url()) {
    await page.goto(href, { waitUntil: 'domcontentloaded', timeout: 25_000 }).catch(() => {});
    await page.waitForTimeout(800);
    return 'clicked';
  }

  return false;
}

/** Cheap proxy for "how many result-ish blocks are on the page right now". */
async function countCandidates(page: Page): Promise<number> {
  return page
    .evaluate(() => document.querySelectorAll('article, li, [role="listitem"], [class*="card" i], [class*="result" i]').length)
    .catch(() => 0);
}

/**
 * Reports every repeated block the detector considered, with the winner marked.
 *
 * Extraction is the least predictable part of replaying an arbitrary site, and
 * "no results" tells you nothing about why. This exposes the actual ranking so
 * failures can be diagnosed — and so the UI can offer the runner-up when the
 * top pick is wrong.
 */
export interface RegionCandidate {
  selector: string;
  count: number;
  score: number;
  samples: string[];
  chosen: boolean;
}

export async function listRegionCandidates(page: Page): Promise<RegionCandidate[]> {
  return page.evaluate(scoreRegions).catch(() => [] as RegionCandidate[]);
}

export interface ExtractOptions {
  spec: OutputSpec;
  /** Human summary line the UI shows above the results. */
  summaryHint?: string;
  /** How many pages of results to walk. 1 disables pagination. */
  maxPages?: number;
  /** Progress reporting, so a long multi-page scrape isn't a silent wait. */
  onProgress?: (message: string, detail?: string) => void;
  /**
   * Wall-clock time by which this must stop, if there is one.
   *
   * Only serverless runs set it, and only because the alternative is being
   * killed mid-page: the platform stops the function and the caller gets its
   * error page, so the results already read are thrown away along with any
   * explanation. Stopping a page early and reporting what was found beats
   * both.
   */
  deadline?: number;
}

export async function extractOutput(page: Page, opts: ExtractOptions): Promise<RunOutput> {
  const { spec } = opts;
  const maxPages = Math.max(1, Math.min(opts.maxPages ?? 10, 30));

  const bodyText = (await page.evaluate(() => document.body?.innerText ?? '').catch(() => ''))
    .slice(0, 12_000)
    .toLowerCase();

  // Honest empty state beats a confident empty list.
  const emptyHit = spec.emptyStateHints.find((h) => h && saysHint(bodyText, h));

  /* The same phrase, but where the page is *announcing* it.
   *
   * Booking answers an unrecognised destination with "Cox's Bazar: no
   * properties found" as the page heading and then, below it, its standing
   * "Browse by property type" tiles. Those tiles are perfectly uniform blocks
   * with images and links, so the structural scanner scores them highly and
   * returns "60 stays" — Hotels, Apartments, Resorts, Villas — for a search
   * that found nothing. A page that says in its own heading that it found
   * nothing has settled the question, whatever else is lying around on it.
   *
   * Restricted to headings and the top of the page on purpose: "no results"
   * inside a filter sidebar is about that filter, not the search. */
  const announced = (
    await page
      .evaluate(() => {
        const heads = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
          .slice(0, 12)
          .map((el) => (el as HTMLElement).innerText ?? '')
          .join(' \n ');
        return `${heads} \n ${(document.body?.innerText ?? '').slice(0, 600)}`;
      })
      .catch(() => '')
  ).toLowerCase();

  const announcedEmpty = spec.emptyStateHints.find((h) => h && saysHint(announced, h));

  /* Sites hand automated visitors a soft error page rather than a block: eBay's
     "Sorry — something went wrong on our end", a bare 500, a "page not found".
     Reporting that as "no results could be read" blames the scraper for the
     site's refusal, and sends you re-recording something that was never wrong. */
  const SITE_ERROR = [
    'something went wrong on our end',
    'something went wrong',
    'sorry, we could not',
    'temporarily unavailable',
    'service unavailable',
    'try again later',
    'page not found',
    'an error occurred',
    'http error 5',
  ];
  const errorHit =
    bodyText.length < 2500 ? SITE_ERROR.find((p) => bodyText.includes(p)) : undefined;

  /* Asked for the page itself, not a list of links to pages. Wait for it to
     render, then read it as prose. */
  if (spec.layout === 'detail') {
    await waitForContent(page, 20_000);
    const document = await page.evaluate(readDocument).catch((err) => {
      // Never let a bug in the reader masquerade as "this page has no article".
      console.error('[extract] reading the page as a document failed:', err);
      return null;
    });

    /* A results page is not the article you asked for.
     *
     * "Search Wikipedia for solar rooftop" ended on Special:Search and read
     * 866 words of it as prose — a "document" titled "Search results", made of
     * the site's own chrome, with twenty real results sitting on the page
     * unread. Word count alone cannot tell those apart: a busy search page has
     * plenty of words. What tells them apart is that one of them has a list on
     * it and calls itself a search.
     *
     * Both conditions, because either alone is wrong: articles legitimately
     * contain lists, and a page can be titled "Results" and still be prose. */
    const stillOnResults =
      Boolean(document) &&
      /^\s*(search results?|results|search)\b/i.test(document!.title ?? '') &&
      (await countBySelector(
        page,
        '[class*="search-result" i], [class*="searchresult" i], .mw-search-results > li, ' +
          '[data-testid*="result" i], li[class*="result" i]',
      )) >= 5;

    if (stillOnResults) {
      opts.onProgress?.('That is the site’s search results, not an article — reading it as a list');
    } else if (document && document.wordCount >= 40) {
      opts.onProgress?.(
        `Read the article · ${document.wordCount.toLocaleString()} words in ${document.sections.length} section${
          document.sections.length === 1 ? '' : 's'
        }`,
      );
      return {
        layout: 'detail',
        resultKind: 'article',
        items: [],
        document,
        finalUrl: page.url(),
        candidates: [],
        summary: opts.summaryHint,
      };
    }
    /* Too thin to be the article — this is probably still a results list, so
       fall through and read it as one rather than returning an empty page. */
    else opts.onProgress?.('That page had no article on it — reading it as a list instead');
  }

  // Confirmation-style runs don't have a list at all.
  if (spec.layout === 'confirmation') {
    const confirmation = await extractConfirmation(page);
    // A confirmation page has no list to choose between.
    return { layout: 'confirmation', resultKind: 'generic' as const, confirmation, finalUrl: page.url(), items: [], candidates: [] };
  }

  const unavailableHints = spec.unavailableHints.map((h) => h.toLowerCase());
  const collected: ResultItem[] = [];
  const fingerprints = new Set<string>();
  let pagesRead = 0;
  /**
   * Where the results were found.
   *
   * Deliberately the *first* results page, not wherever pagination finished:
   * "open the final page" should take you to the search you asked for, not to
   * page three of a pager the scraper walked through on your behalf.
   */
  let resultsUrl = page.url();
  let capturedResultsUrl = false;

  /* How long is left, when anyone is counting. A page load plus a scrape is
     the unit of work here, so there is no point starting one without room for
     it — the platform would stop the function mid-page and the results already
     read would go with it. */
  const timeLeft = () => (opts.deadline ?? Number.POSITIVE_INFINITY) - Date.now();

  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    if (pageIndex > 0 && timeLeft() < 12_000) {
      opts.onProgress?.(
        `Out of time for more pages — returning the ${collected.length} result${
          collected.length === 1 ? '' : 's'
        } already read`,
      );
      break;
    }

    // A pager can lead somewhere that fails to load. Never scrape — or report —
    // a browser error page.
    const here = page.url();
    if (/^(chrome-error|about:blank|chrome:)/.test(here)) {
      opts.onProgress?.('That page failed to load — keeping the results already read');
      break;
    }
    if (!capturedResultsUrl) {
      resultsUrl = here;
      capturedResultsUrl = true;
    }

    /* Never scrape a page that hasn't rendered. An interstitial or an unpainted
       app shell reads as "the site returned nothing", which is both wrong and
       the hardest kind of wrong to diagnose. */
    /* Never longer than there is. These waits are generous because waiting is
       usually free — it only costs time when the page is not ready — but a
       thirty-second wait inside a request with twenty seconds left spends all
       of it and then gets killed anyway. */
    const within = (ms: number) => Math.max(3_000, Math.min(ms, timeLeft() - 8_000));

    await waitForContent(page, within(pageIndex === 0 ? 30_000 : 10_000));
    /* Generous on the first page, because this only costs time when the saved
       selector is not matching yet — which on a slow connection is exactly the
       case where waiting is the difference between the real results and
       whichever shelf the site painted first. */
    await waitForItems(page, spec.itemLocator ?? null, within(pageIndex === 0 ? 30_000 : 8000));

    /* Says out loud which list is about to be read. When a run comes back with
       the wrong results, this line is the difference between "the saved
       selector no longer matches" and "the detector picked badly" — two
       problems with completely different fixes. */
    if (spec.itemLocator) {
      let matched = await countBySelector(page, spec.itemLocator);

      /* An application that navigated in-page can leave a half-built result
         list: the URL is right, a shelf or two has painted, and the list the
         recording actually read never arrives. Loading that same URL fresh
         renders it properly. Worth one attempt — it is the difference between
         eleven suggestions and the real results — but only on the first page,
         only when a query is in the URL, and only when the saved selector is
         finding nothing at all. */
      /* Reloading costs a navigation and both waits again — around twenty
         seconds on a slow browser. Starting one with less than that left is
         how a run that had something to say ends as a timeout with nothing:
         Booking spent 18s waiting for its cards, found too few, and began a
         retry it could not finish. Better to read what is on the page. */
      if (matched < 3 && pageIndex === 0 && page.url().includes('?') && timeLeft() > 22_000) {
        opts.onProgress?.('The page came back incomplete — loading it again');
        await page
          .goto(page.url(), { waitUntil: 'domcontentloaded', timeout: 30_000 })
          .catch(() => {});
        await waitForContent(page, 20_000);
        await waitForItems(page, spec.itemLocator, 20_000);
        matched = await countBySelector(page, spec.itemLocator);
      }

      opts.onProgress?.(
        matched >= 3
          ? `Reading ${matched} blocks matching ${spec.itemLocator}`
          : `${spec.itemLocator} matched ${matched} — finding the results block instead`,
      );
    }

    /* Only the first page earns the long endless-scroll budget. It is generous
       because that loop now stops the moment the item count stops rising —
       a static page still costs about a second. */
    await primeLazyContent(page, within(pageIndex === 0 ? 25_000 : 6000), spec.itemLocator ?? null);

    await forceImagesToLoad(page);

    const raw =
      (await page
        .evaluate(detectItems, {
          itemSelector: spec.itemLocator ?? null,
          pinned: Boolean(spec.itemLocatorPinned),
        })
        .catch((err) => {
        // Never let a scraping bug masquerade as "the site returned nothing".
        console.error('[extract] in-page detection failed:', err);
        return [] as RawItem[];
      })) ?? [];

    let added = 0;
    for (const r of raw) {
      if (!r.title && !r.text) continue;
      const title = r.title || `Result ${collected.length + 1}`;
      if (title.length < 2 || title.length > 300) continue;

      /* The same item can appear on two pages, so each one is remembered by
         what identifies it. A URL does that outright. A title alone does not:
         ten GoZayaan flight cards are ten different itineraries all headed
         "Qatar Airways", and deduplicating on the heading threw seven of them
         away. Where there is no link, identity is the card's own content. */
      const fingerprint = (
        r.url || `${title}|${r.priceText ?? ''}|${r.text.slice(0, 200)}`
      ).toLowerCase();
      if (fingerprints.has(fingerprint)) continue;

      /* Promo strips and notices share the result class on many shops ("We're
         showing you items that ship to…"). A real result points somewhere, or
         shows a picture, or has a price; a banner has none of the three. */
      const isBanner = !r.url && !r.image && !r.priceText;
      if (isBanner && raw.length > 3) continue;

      fingerprints.add(fingerprint);

      const lower = r.text.toLowerCase();
      const unavailableHit = unavailableHints.find((h) => h && lower.includes(h));

      /* An itinerary card is headed with the airline and nothing else, so the
         route goes into the title where it can be told apart from the nine
         other cards the same airline is selling, and the legs become facts
         instead of loose lines in the description. */
      const itinerary = readItinerary(r.lines ?? []);
      const heading = itinerary ? `${itinerary.route} · ${title}` : title;

      collected.push({
        id: `item_${collected.length}`,
        title: heading,
        subtitle: itinerary ? title : r.subtitle,
        description: itinerary ? undefined : r.description,
        image: r.image,
        url: r.url,
        price: parsePrice(r.priceText),
        rating: parseRating(r.ratingText),
        // Drop the keys the page had nothing for, so `meta.duration` is either
        // a duration or absent — never an empty string the UI has to test for.
        meta: Object.fromEntries(
          Object.entries(r.meta ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()),
        ),
        badges: r.badges ?? [],
        attributes: itinerary
          ? [{ label: 'Route', value: itinerary.route }, ...itinerary.legs]
          : (r.attributes ?? []).filter((a) => a.value),
        page: pageIndex + 1,
        unavailable: Boolean(unavailableHit),
        unavailableReason: unavailableHit ? `Site says: “${unavailableHit}”` : undefined,
      });
      added += 1;
    }

    pagesRead += 1;
    opts.onProgress?.(
      `Read page ${pagesRead} · ${collected.length} result${collected.length === 1 ? '' : 's'} so far`,
    );

    if (pageIndex === maxPages - 1) break;
    // A page that added nothing new means we've reached the end, whatever the
    // pager says.
    if (added === 0 && pageIndex > 0) break;

    /* Paging is only worth it when page one clearly *is* a result list. A
       handful of blocks usually means the detector latched onto something else,
       and following that site's pager from there wanders off the results
       entirely — costing a minute and ending somewhere unrelated. */
    if (pageIndex === 0 && collected.length < 5) {
      opts.onProgress?.(
        `Page one held ${collected.length} block${collected.length === 1 ? '' : 's'} — treating that as the whole result`,
      );
      break;
    }

    const advanced = await goToNextPage(page, pageIndex + 1);
    if (!advanced) break;
    opts.onProgress?.(
      advanced === 'scrolled' ? 'Loading more results' : `Opening page ${pageIndex + 2}`,
    );
  }

  const finalUrl = resultsUrl;

  /* Always attach the ranking, and most of all when nothing was found — that is
     exactly when someone needs to see what the extractor was choosing between.
     `chosen` reflects what actually got used, not merely what ranked first. */
  const ranked = await listRegionCandidates(page);
  const candidates = ranked.map((c) => ({
    ...c,
    chosen: spec.itemLocator ? c.selector === spec.itemLocator : c.chosen,
  }));

  if (errorHit && collected.length === 0) {
    return {
      layout: spec.layout,
      resultKind: spec.resultKind ?? 'generic',
      items: [],
      finalUrl,
      candidates,
      emptyReason: `The site returned an error page instead of results (“${errorHit}”). That is the site refusing, not a problem with the recording — try again, or run it with a visible browser.`,
      summary: opts.summaryHint,
    };
  }

  if (announcedEmpty || (emptyHit && collected.length === 0)) {
    const said = announcedEmpty ?? emptyHit;
    return {
      layout: spec.layout,
      resultKind: spec.resultKind ?? 'generic',
      items: [],
      finalUrl,
      candidates,
      emptyReason:
        announcedEmpty && collected.length
          ? `The site says “${said}”. The ${collected.length} blocks on the page are its standing categories, not results for this search.`
          : `The site reported no results (“${said}”).`,
      summary: opts.summaryHint,
    };
  }

  /* Nothing found *and* nothing on the page. That is a site that never handed
     over its content — a challenge that never cleared, or a shell that never
     painted — not a scrape that came up short. Saying so is the difference
     between "try again / run it visibly" and re-recording something that was
     never broken. */
  if (collected.length === 0) {
    const rendered = await page
      .evaluate(() => ({
        text: (document.body?.innerText ?? '').trim().length,
        elements: document.querySelectorAll('*').length,
      }))
      .catch(() => ({ text: 0, elements: 0 }));

    if (rendered.text < 200 || rendered.elements < 60) {
      return {
        layout: spec.layout,
        resultKind: spec.resultKind ?? 'generic',
        items: [],
        finalUrl,
        candidates,
        emptyReason:
          'The site never rendered its content for this visit — it served a blank or security-check page instead. Try running it again, or with a visible browser.',
        summary: opts.summaryHint,
      };
    }
  }

  /* A list of places to stay with no prices on it is not a list of places to
   * stay.
   *
   * Booking, asked for hotels in Cox's Bazar, served a page with no property
   * cards on it at all. The structural scanner did what it is built to do —
   * found the largest uniform repeated region — and returned eighty-eight
   * results: "York United States", "Atlanta United States", "Chicago United
   * States". Booking's own list of destinations, reported as a successful
   * search for hotels.
   *
   * Deliberately only stays and flights. Those are sold, always, with the
   * price on the listing — nobody lists a hotel without a nightly rate. A
   * shop's product grid can honestly be terse: Walton lists "WIWH-GSN-45A"
   * with no price until you open it, and refusing those would throw away real
   * results to catch a rarer fault. */
  const MUST_COST: ResultKind[] = ['stay', 'flight'];
  if (
    collected.length >= 5 &&
    spec.resultKind &&
    MUST_COST.includes(spec.resultKind) &&
    !collected.some((item) => item.price)
  ) {
    return {
      layout: spec.layout,
      resultKind: spec.resultKind,
      items: [],
      finalUrl,
      candidates,
      emptyReason: `The site did not return its results for this search — the ${collected.length} blocks on the page carry no prices, so they are its own navigation rather than anything on offer. That is usually the site refusing an automated visit; try again, or run it with a visible browser.`,
      summary: opts.summaryHint,
    };
  }

  const summaryBits = [opts.summaryHint, pagesRead > 1 ? `${pagesRead} pages` : undefined].filter(Boolean);

  /* The compiler's guess is made from the recording, before a single result
     exists. What was actually scraped is better evidence, so it only defers to
     the declared kind when it can't tell. */
  const inferred = inferResultKind(collected);
  const resultKind: ResultKind = inferred === 'generic' ? (spec.resultKind ?? 'generic') : inferred;

  return {
    layout: spec.layout,
    resultKind,
    items: collected,
    finalUrl,
    candidates,
    summary: summaryBits.length ? summaryBits.join(' · ') : undefined,
    emptyReason: collected.length === 0 ? 'The automation finished but no results could be read from the page.' : undefined,
  };
}

/**
 * Reads the page as prose: its lead, its headings, its paragraphs.
 *
 * Runs in the page, so it stays self-contained. It looks for the main content
 * the way a reader-mode implementation does — the container holding the most
 * paragraph text — rather than trusting any one site's markup.
 */
function readDocument(): {
  title: string;
  url: string;
  summary?: string;
  image?: string;
  sections: { heading?: string; level: number; paragraphs: string[] }[];
  wordCount: number;
} {
  const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();

  /* Chrome that reads like prose but isn't: navigation, edit links, citation
     footers, "this article needs additional citations" notices. */
  const NOISE =
    'nav, footer, header, aside, form, table, [role="navigation"], [role="banner"], ' +
    '[role="contentinfo"], [role="note"], .navbox, .reflist, .references, .mw-editsection, ' +
    '.hatnote, .ambox, .infobox, .sidebar, .toc, .mw-jump-link, .shortdescription, ' +
    '[class*="cookie" i], [class*="newsletter" i], [class*="promo" i], [class*="related" i]';

  /* Find the content by weighing it, not by trusting a selector.
   *
   * Taking the first `article` or `.mw-parser-output` on the page looks
   * reasonable and quietly fails: Wikipedia renders several of those wrappers
   * and the first is an empty one holding a hatnote, so the reader found zero
   * paragraphs on a page with hundreds. Whichever container actually holds the
   * most prose is the article, on any site. */
  const scoreOf = (el: Element): number => {
    let total = 0;
    for (const p of Array.from(el.querySelectorAll('p'))) {
      if (p.closest(NOISE)) continue;
      total += clean((p as HTMLElement).innerText).length;
    }
    return total;
  };

  let scope: HTMLElement = document.body;
  let best = scoreOf(document.body) * 0.75; // the body wins only by a clear margin

  const containers = Array.from(
    document.querySelectorAll(
      'article, main, [role="main"], .mw-parser-output, #content, #main, ' +
        '[class*="article-body" i], [class*="entry-content" i], [class*="post-content" i], ' +
        '[itemprop="articleBody"]',
    ),
  );

  for (const container of containers) {
    const score = scoreOf(container);
    if (score > best) {
      best = score;
      scope = container as HTMLElement;
    }
  }

  const usable = (el: Element) => {
    if (el.closest(NOISE)) return false;
    const text = clean((el as HTMLElement).innerText);
    return text.length >= 40;
  };

  const sections: { heading?: string; level: number; paragraphs: string[] }[] = [];
  let current: { heading?: string; level: number; paragraphs: string[] } = {
    level: 2,
    paragraphs: [],
  };

  // Walk the content in document order so headings keep their paragraphs.
  const nodes = Array.from(scope?.querySelectorAll('h1, h2, h3, h4, h5, h6, p, li') ?? []);
  for (const node of nodes) {
    const tag = node.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tag)) {
      if (node.closest(NOISE)) continue;
      const heading = clean((node as HTMLElement).innerText).replace(/\[edit\]$/i, '').trim();
      if (!heading || heading.length > 140) continue;
      if (current.paragraphs.length || current.heading) sections.push(current);
      current = { heading, level: Number(tag[1]), paragraphs: [] };
      continue;
    }

    if (!usable(node)) continue;
    const text = clean((node as HTMLElement).innerText);
    // A list item repeated inside a paragraph, or vice versa.
    if (current.paragraphs.includes(text)) continue;
    current.paragraphs.push(text.slice(0, 4000));
    if (current.paragraphs.length > 60) break;
  }
  if (current.paragraphs.length || current.heading) sections.push(current);

  const lead = sections.find((s) => s.paragraphs.length)?.paragraphs[0];

  // The biggest picture in the content area is the one the page is about.
  let image: string | undefined;
  let widest = 0;
  for (const img of Array.from(scope?.querySelectorAll('img') ?? [])) {
    const box = img.getBoundingClientRect();
    if (box.width < 120 || box.width < widest) continue;
    const src = img.currentSrc || img.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) continue;
    widest = box.width;
    try {
      image = new URL(src, location.href).href;
    } catch {
      /* unusable src */
    }
  }

  const wordCount = sections
    .flatMap((s) => s.paragraphs)
    .join(' ')
    .split(/\s+/)
    .filter(Boolean).length;

  return {
    title:
      clean((document.querySelector('h1') as HTMLElement | null)?.innerText) ||
      clean(document.title),
    url: location.href,
    summary: lead?.slice(0, 600),
    image,
    sections: sections.slice(0, 80),
    wordCount,
  };
}

async function extractConfirmation(page: Page) {
  return page
    .evaluate(() => {
      const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim();
      const heading = document.querySelector('h1, h2, [role="heading"]');
      const bodyText = clean(document.body?.innerText).slice(0, 600);

      const details: { label: string; value: string }[] = [];
      document.querySelectorAll('dt').forEach((dt) => {
        const dd = dt.nextElementSibling;
        if (dd?.tagName === 'DD') {
          details.push({ label: clean(dt.textContent), value: clean((dd as HTMLElement).innerText) });
        }
      });
      document.querySelectorAll('tr').forEach((tr) => {
        const cells = Array.from(tr.querySelectorAll('td,th')).map((c) => clean((c as HTMLElement).innerText));
        if (cells.length === 2 && cells[0] && cells[1] && cells[0].length < 40) {
          details.push({ label: cells[0], value: cells[1] });
        }
      });

      // Booking references are the thing people actually want off this page.
      const ref =
        bodyText.match(/\b(?:reference|booking|order|confirmation|pnr|ticket)\s*(?:no\.?|number|id|#|:)?\s*([A-Z0-9-]{5,20})\b/i)?.[1] ??
        undefined;

      const failed = /(failed|error|declined|could not|unable to|went wrong)/i.test(bodyText);

      return {
        ok: !failed,
        reference: ref,
        message: clean(heading?.textContent) || bodyText.slice(0, 160),
        details: details.slice(0, 12),
      };
    })
    .catch(() => ({ ok: false, message: 'Could not read the confirmation page.', details: [] }));
}

/**
 * Cheap HTML condensers. The model only needs structure — class names, ids,
 * test hooks, and the shape of repeated blocks — so everything that costs
 * tokens without carrying signal gets stripped before the prompt is built.
 */

const DROP_TAGS = /<(script|style|noscript|svg|iframe|template|link|meta|path|symbol|defs)\b[\s\S]*?<\/\1>/gi;
const SELF_CLOSING_NOISE = /<(link|meta|br|source|track|img)\b[^>]*>/gi;
const COMMENTS = /<!--[\s\S]*?-->/g;
/** Inline styles and long data attributes are pure noise for our purposes. */
const NOISY_ATTRS = /\s(style|srcset|sizes|onclick|onload|integrity|nonce|crossorigin|data-reactroot|xmlns[^=]*)="[^"]*"/gi;
const LONG_DATA_URI = /"data:[^"]{80,}"/gi;

export function condenseHtml(html: string, limit = 18_000): string {
  if (!html) return '';
  let out = html
    .replace(COMMENTS, '')
    .replace(DROP_TAGS, '')
    .replace(SELF_CLOSING_NOISE, (m) => (/<img/i.test(m) ? '<img>' : ''))
    .replace(LONG_DATA_URI, '"data:…"')
    .replace(NOISY_ATTRS, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/>\s+</g, '><');

  // Long text nodes get clipped — the model needs the tags, not the prose.
  out = out.replace(/>([^<]{200,})</g, (_m, text: string) => `>${text.slice(0, 200)}…<`);

  if (out.length > limit) {
    // Keep the head of the body plus the tail, where results usually live.
    const head = out.slice(0, Math.floor(limit * 0.6));
    const tail = out.slice(-Math.floor(limit * 0.4));
    return `${head}\n<!-- … ${out.length - limit} chars trimmed … -->\n${tail}`;
  }
  return out;
}

/**
 * Finds the container whose children repeat most — search results, product
 * grids, inbox rows. Gives the model a strong starting guess for `itemLocator`.
 */
export function guessResultContainers(html: string, max = 4): string[] {
  const condensed = condenseHtml(html, 120_000);
  const counts = new Map<string, number>();

  // Count class signatures of repeated sibling-ish elements.
  const classRe = /<(?:li|article|div|tr|a)\b[^>]*class="([^"]{3,120})"/gi;
  let m: RegExpExecArray | null;
  while ((m = classRe.exec(condensed))) {
    const sig = m[1]
      .split(/\s+/)
      .filter((c) => c.length > 2 && c.length < 40 && !/^[a-z]{1,2}-\d/.test(c))
      .slice(0, 3)
      .join(' ');
    if (!sig) continue;
    counts.set(sig, (counts.get(sig) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .filter(([, n]) => n >= 3 && n <= 200)
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([sig, n]) => `.${sig.split(' ').join('.')} (×${n})`);
}

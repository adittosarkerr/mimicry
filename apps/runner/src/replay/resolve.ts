import type { Frame, Locator, Page } from 'playwright';
import type { ElementLocator, LocatorCandidate } from '@mimic/schema';

/**
 * Turns a recorded ElementLocator into a live Playwright Locator.
 *
 * Candidates are tried best-first with a short budget each, so a site that
 * renamed its CSS classes costs a second or two rather than failing the run.
 */

export interface Resolved {
  locator: Locator;
  candidate: LocatorCandidate;
  /** How far down the candidate list we had to go — surfaced in the console. */
  fallbackDepth: number;
}

/** Pick the frame the element was recorded in. */
function frameFor(page: Page, target: ElementLocator): Frame {
  const wanted = target.frame?.frameUrl;
  if (!wanted) return page.mainFrame();
  if (wanted === page.url()) return page.mainFrame();

  const frames = page.frames();
  const exact = frames.find((f) => f.url() === wanted);
  if (exact) return exact;

  // Query strings change between runs; matching on origin + path is enough.
  try {
    const w = new URL(wanted);
    const loose = frames.find((f) => {
      try {
        const u = new URL(f.url());
        return u.origin === w.origin && u.pathname === w.pathname;
      } catch {
        return false;
      }
    });
    if (loose) return loose;
  } catch {
    /* not a parseable URL */
  }
  return page.mainFrame();
}

/** Build a Locator for one candidate, or null if the strategy can't apply. */
export function locatorFor(scope: Frame | Page, c: LocatorCandidate): Locator | null {
  const value = c.value;
  try {
    switch (c.strategy) {
      case 'testid':
      case 'id':
      case 'name':
      case 'css':
      case 'nth':
        return scope.locator(value);
      case 'xpath':
        return scope.locator(`xpath=${value}`);
      case 'role':
        return c.name
          ? scope.getByRole(value as Parameters<Page['getByRole']>[0], { name: c.name, exact: false })
          : scope.getByRole(value as Parameters<Page['getByRole']>[0]);
      case 'label':
        return scope.getByLabel(value, { exact: false });
      case 'placeholder':
        return scope.getByPlaceholder(value, { exact: false });
      case 'text':
        return scope.getByText(value, { exact: true });
      case 'altText':
        return scope.getByAltText(value, { exact: false });
      case 'title':
        return scope.getByTitle(value, { exact: false });
      default:
        return null;
    }
  } catch {
    return null;
  }
}

/** Prefer a visible, enabled match; fall back to the first match that exists. */
async function pickUsable(locator: Locator, budgetMs: number): Promise<Locator | null> {
  try {
    const count = await locator.count();
    if (count === 0) return null;
    if (count === 1) {
      await locator.first().waitFor({ state: 'attached', timeout: budgetMs });
      return locator.first();
    }

    // Several matches — take the first one a human could actually interact with.
    const limit = Math.min(count, 8);
    for (let i = 0; i < limit; i += 1) {
      const nth = locator.nth(i);
      if (await nth.isVisible().catch(() => false)) return nth;
    }
    return locator.first();
  } catch {
    return null;
  }
}

export interface ResolveOptions {
  /** Total time to spend across all candidates. */
  timeoutMs?: number;
  /** Wait for the element to appear rather than giving up on an empty page. */
  waitForFirst?: boolean;
}

export async function resolve(
  page: Page,
  target: ElementLocator,
  opts: ResolveOptions = {},
): Promise<Resolved | null> {
  const total = opts.timeoutMs ?? 15_000;
  const scope = frameFor(page, target);
  const candidates = [...target.candidates].sort((a, b) => b.score - a.score);
  const deadline = Date.now() + total;

  // The top candidate gets a real wait — the page may still be rendering.
  if (opts.waitForFirst !== false && candidates.length) {
    const first = candidates[0];
    const loc = locatorFor(scope, first);
    if (loc) {
      try {
        await loc.first().waitFor({ state: 'attached', timeout: Math.min(total * 0.5, 8000) });
        const usable = await pickUsable(loc, 1500);
        if (usable) return { locator: usable, candidate: first, fallbackDepth: 0 };
      } catch {
        /* fall through to the rest of the list */
      }
    }
  }

  for (let i = 0; i < candidates.length; i += 1) {
    if (Date.now() > deadline) break;
    const c = candidates[i];
    const loc = locatorFor(scope, c);
    if (!loc) continue;
    const usable = await pickUsable(loc, 1200);
    if (usable) return { locator: usable, candidate: c, fallbackDepth: i };
  }

  // The element may live in a frame we didn't expect.
  for (const frame of page.frames()) {
    if (frame === scope) continue;
    if (Date.now() > deadline) break;
    for (const c of candidates.slice(0, 3)) {
      const loc = locatorFor(frame, c);
      if (!loc) continue;
      const usable = await pickUsable(loc, 800);
      if (usable) return { locator: usable, candidate: c, fallbackDepth: candidates.length };
    }
  }

  // Nothing matched structurally. Fall back to meaning: find the control on the
  // page that a person would say is the same one.
  const semantic = await semanticFallback(page, target);
  if (semantic) {
    return {
      locator: semantic,
      candidate: { strategy: 'role', value: 'semantic', unique: false, score: 1 },
      fallbackDepth: candidates.length + 1,
    };
  }

  return null;
}

/**
 * Last-resort resolution by meaning rather than structure.
 *
 * Sites rewrite their markup constantly — a search box moves into a dialog, an
 * id becomes hashed, a wrapper is added. What survives is what the control *is*:
 * a text input labelled "Enter destination", a button that says "Search". This
 * scores every visible control on the page against what was recorded and takes
 * the best match, if it's clearly a match.
 *
 * It marks the winner with a temporary attribute so Playwright can address it
 * without needing a stable selector.
 */
async function semanticFallback(page: Page, target: ElementLocator): Promise<Locator | null> {
  const snap = target.snapshot;
  if (!snap) return null;

  const wanted = {
    tag: snap.tag ?? '',
    type: snap.type ?? snap.attributes?.type ?? '',
    role: snap.role ?? '',
    name: (snap.accessibleName ?? '').toLowerCase().trim(),
    placeholder: (snap.attributes?.placeholder ?? '').toLowerCase().trim(),
    nameAttr: (snap.attributes?.name ?? '').toLowerCase().trim(),
    text: (snap.text ?? '').toLowerCase().trim().slice(0, 60),
  };

  if (!wanted.name && !wanted.placeholder && !wanted.nameAttr && !wanted.text) return null;

  const matched = await page
    .evaluate((want) => {
      const MARK = 'data-mimic-resolved';
      document.querySelectorAll(`[${MARK}]`).forEach((n) => n.removeAttribute(MARK));

      const clean = (s: string | null | undefined) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

      const visible = (el: Element) => {
        const r = el.getBoundingClientRect();
        if (r.width < 8 || r.height < 8) return false;
        const st = getComputedStyle(el);
        return st.display !== 'none' && st.visibility !== 'hidden' && Number(st.opacity) > 0.05;
      };

      /** Accessible-ish name, cheap version of the recorder's. */
      const nameOf = (el: Element): string => {
        const aria = clean(el.getAttribute('aria-label'));
        if (aria) return aria;
        const labelledBy = el.getAttribute('aria-labelledby');
        if (labelledBy) {
          const text = labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id))
            .filter(Boolean)
            .map((n) => clean(n!.textContent))
            .join(' ');
          if (text) return text;
        }
        if (el.id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) return clean(lbl.textContent);
        }
        const wrapping = el.closest('label');
        if (wrapping) return clean(wrapping.textContent);
        return clean(el.getAttribute('title')) || clean((el as HTMLElement).innerText).slice(0, 60);
      };

      /** Token overlap, 0–1. Robust to word order and extra words. */
      const similarity = (a: string, b: string): number => {
        if (!a || !b) return 0;
        if (a === b) return 1;
        if (a.includes(b) || b.includes(a)) return 0.85;
        const at = new Set(a.split(/\W+/).filter((t) => t.length > 2));
        const bt = new Set(b.split(/\W+/).filter((t) => t.length > 2));
        if (!at.size || !bt.size) return 0;
        let hits = 0;
        at.forEach((t) => {
          if (bt.has(t)) hits += 1;
        });
        return hits / Math.max(at.size, bt.size);
      };

      const pool = Array.from(
        document.querySelectorAll(
          'input, textarea, select, button, a[href], [role="button"], [role="combobox"], [role="textbox"], [role="searchbox"], [contenteditable="true"]',
        ),
      ).filter(visible);

      let best: { el: Element; score: number } | null = null;

      for (const el of pool) {
        const tag = el.tagName.toLowerCase();
        const type = clean(el.getAttribute('type'));
        const role = clean(el.getAttribute('role'));
        const placeholder = clean(el.getAttribute('placeholder'));
        const nameAttr = clean(el.getAttribute('name'));
        const name = nameOf(el);

        let score = 0;

        // Same kind of control at all?
        const wantsTextEntry = ['input', 'textarea'].includes(want.tag);
        const isTextEntry = ['input', 'textarea'].includes(tag) || el.hasAttribute('contenteditable');
        if (wantsTextEntry && !isTextEntry) continue;
        if (!wantsTextEntry && want.tag && tag !== want.tag && role !== want.role) score -= 1;

        if (tag === want.tag) score += 2;
        if (type && type === want.type) score += 2;
        if (role && role === want.role) score += 1;

        if (nameAttr && nameAttr === want.nameAttr) score += 5;

        score += similarity(name, want.name) * 5;
        score += similarity(placeholder, want.placeholder) * 4;
        // A recorded placeholder often becomes the visible label, and vice versa.
        score += similarity(name, want.placeholder) * 2;
        score += similarity(placeholder, want.name) * 2;
        if (want.text) score += similarity(clean((el as HTMLElement).innerText), want.text) * 3;

        if (!best || score > best.score) best = { el, score };
      }

      // Below this, the "match" is just the first input on the page.
      if (!best || best.score < 3.5) return false;
      best.el.setAttribute(MARK, '1');
      return true;
    }, wanted)
    .catch(() => false);

  if (!matched) return null;
  const locator = page.locator('[data-mimic-resolved="1"]').first();
  return (await locator.count().catch(() => 0)) > 0 ? locator : null;
}

/** Human-readable description of what we searched for, for the run console. */
export function describeTarget(target: ElementLocator): string {
  const snap = target.snapshot;
  const name = snap?.accessibleName || snap?.text || snap?.attributes?.name || snap?.attributes?.id;
  const tag = snap?.tag ?? 'element';
  return name ? `${tag} “${String(name).slice(0, 50)}”` : `${tag} ${target.candidates[0]?.value?.slice(0, 50) ?? ''}`;
}

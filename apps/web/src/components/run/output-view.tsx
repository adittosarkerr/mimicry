'use client';

import { useRef, useState } from 'react';
import { motion } from 'motion/react';
import type { ResultItem, ResultKind, Run, RunOutput } from '@mimic/schema';
import { api } from '@/lib/api';
import { Badge, EmptyState } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * Results, rebuilt in Mimic's own layout.
 *
 * Deliberately not an iframe or a screenshot of someone else's page: the run
 * produced structured data, so it renders as structured data — with every item
 * still linking back to the real thing.
 *
 * And not one card for everything. A video wants a wide thumbnail, a duration
 * and a channel; a place to stay wants a photo, a nightly price and a rating; a
 * repository wants stars and a language. The run reports what kind of thing it
 * found (`output.resultKind`) and each kind gets the layout it deserves.
 */

/** Per-kind copy and grid shape. Everything else is shared. */
const KIND_PRESENTATION: Record<
  ResultKind,
  { noun: [string, string]; grid: string }
> = {
  video: { noun: ['video', 'videos'], grid: 'gap-x-4 gap-y-6 sm:grid-cols-2 lg:grid-cols-3' },
  stay: { noun: ['stay', 'stays'], grid: 'gap-3 grid-cols-1' },
  flight: { noun: ['flight', 'flights'], grid: 'gap-2.5 grid-cols-1' },
  product: { noun: ['product', 'products'], grid: 'gap-4 grid-cols-2 lg:grid-cols-4' },
  article: { noun: ['article', 'articles'], grid: 'gap-2 grid-cols-1' },
  discussion: { noun: ['thread', 'threads'], grid: 'gap-1.5 grid-cols-1' },
  repo: { noun: ['repository', 'repositories'], grid: 'gap-2.5 grid-cols-1' },
  place: { noun: ['place', 'places'], grid: 'gap-3 sm:grid-cols-2' },
  generic: { noun: ['result', 'results'], grid: 'gap-3 sm:grid-cols-2' },
};

export function OutputView({ run }: { run: Run }) {
  const output = run.output;

  if (run.error) return <ErrorState run={run} />;
  if (!output) return null;

  if (output.layout === 'confirmation' && output.confirmation) {
    return <ConfirmationView output={output} />;
  }

  if (output.document) return <DocumentView output={output} />;

  if (!output.items.length) {
    return (
      <EmptyState
        title={output.emptyReason ? 'Nothing came back' : 'No results'}
        body={
          output.emptyReason ??
          'The run finished but the page had no results to read. Try different values, or re-record if the site has changed.'
        }
        action={
          output.finalUrl ? (
            <a
              href={output.finalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm font-medium text-ember-600 underline underline-offset-4"
            >
              Open the page the run ended on
            </a>
          ) : undefined
        }
      />
    );
  }

  const kind: ResultKind = output.resultKind ?? 'generic';
  const preset = KIND_PRESENTATION[kind] ?? KIND_PRESENTATION.generic;
  const count = output.items.length;
  const noun = preset.noun[count === 1 ? 0 : 1];

  /* A `list` layout from the compiler drops to one column — but only for the
     kinds that read as rows anyway. A wall of full-width 16:9 thumbnails is not
     a list of videos, it is one video per screen. */
  const ROW_KINDS: ResultKind[] = ['article', 'discussion', 'repo', 'stay', 'generic'];
  const grid =
    output.layout === 'list' && ROW_KINDS.includes(kind) ? 'gap-2.5 grid-cols-1' : preset.grid;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="font-display text-2xl text-ink-900">
          {count} {noun}
        </h3>
        {output.summary && <span className="text-[13px] text-ink-500">{output.summary}</span>}
        {output.finalUrl && (
          <a
            href={output.finalUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="ml-auto inline-flex items-center gap-1.5 rounded-lg border border-sand-300 bg-white/70 px-3 py-1.5 text-[12.5px] font-medium text-ink-700 transition-colors hover:border-sand-400 hover:text-ink-900"
          >
            Open the final page
            <ExternalIcon />
          </a>
        )}
      </div>

      {/* The answer, when the request wanted one rather than a list. Placed
          above the results and marked as written rather than scraped — it is a
          reading of what follows, and the reader should be able to check it. */}
      {output.answer && (
        <div className="rounded-[18px] border border-ember-200 bg-ember-100/40 p-5">
          <div className="flex items-center gap-2">
            <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ember-700">
              Answer
            </span>
            <span className="text-[11px] text-ink-400">
              written from these results by {output.answer.model}
            </span>
          </div>
          <p className="mt-2 text-[15px] leading-relaxed text-ink-800">{output.answer.text}</p>
          {output.answer.cites.length > 0 && (
            <p className="mt-2 text-[12px] text-ink-500">
              Based on:{' '}
              {output.answer.cites
                .map((i) => output.items[i]?.title)
                .filter(Boolean)
                .join(' · ')}
            </p>
          )}
        </div>
      )}

      {/* One page at a time, in the site's own pages.
          Ten pages of forty products stacked into a single column is 400 cards
          and a scrollbar the height of a pin — you cannot get back to the third
          result, and you cannot tell page 7 from page 8 without reading the
          divider. The run already knows which page each result came from, so
          that is what gets paged through. */}
      <PagedResults items={output.items} kind={kind} grid={grid} />

      {run.output?.finalScreenshot && (
        <details className="group rounded-[18px] border border-sand-200 bg-white/50 p-4">
          <summary className="cursor-pointer list-none text-[13px] font-medium text-ink-700">
            What the page looked like
            <span className="ml-2 text-[12px] font-normal text-ink-400">screenshot from the run</span>
          </summary>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={api.screenshotUrl(run.output.finalScreenshot)}
            alt="The page the automation finished on"
            className="mt-3 w-full rounded-xl border border-sand-200"
          />
        </details>
      )}
    </div>
  );
}

function ResultCard({ item, kind }: { item: ResultItem; kind: ResultKind }) {
  switch (kind) {
    case 'video':
      return <VideoCard item={item} />;
    case 'stay':
    case 'place':
      return <StayCard item={item} />;
    case 'flight':
      return <FlightCard item={item} />;
    case 'product':
      return <ProductCard item={item} />;
    case 'article':
      return <ArticleRow item={item} />;
    case 'discussion':
      return <DiscussionRow item={item} />;
    case 'repo':
      return <RepoRow item={item} />;
    default:
      return <GenericCard item={item} />;
  }
}

/**
 * Results, one scraped page at a time.
 *
 * The pages are the site's own — page 3 here is page 3 there — so a result can
 * be found again where it was seen, and "400 products" stops meaning "scroll
 * until you give up". A single-page run renders exactly as it did before, with
 * no pager and no page label.
 */
function PagedResults({
  items,
  kind,
  grid,
}: {
  items: ResultItem[];
  kind: ResultKind;
  grid: string;
}) {
  const pages = pagesOf(items);
  const [at, setAt] = useState(0);
  const top = useRef<HTMLDivElement>(null);

  // Beyond the end after a re-run with fewer pages: go back to the first.
  const index = Math.min(at, pages.length - 1);
  const current = pages[index];
  if (!current) return null;

  const go = (next: number) => {
    setAt(next);
    /* Jumping to page four and landing halfway down it is disorienting — the
       eye expects the top of the new page, the way the site itself behaves. */
    top.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div ref={top} className="scroll-mt-6 space-y-4">
      {pages.length > 1 && (
        <div className="flex items-center gap-3">
          <span className="text-[12px] font-medium uppercase tracking-wider text-ink-400">
            Page {current.page}
          </span>
          <span className="h-px flex-1 bg-sand-200" />
          <span className="text-[12px] text-ink-400">
            {current.items.length} of {items.length}
          </span>
        </div>
      )}

      <div className={cn('grid', grid)}>
        {current.items.map((item, i) => (
          <Reveal key={item.id} index={i}>
            <ResultCard item={item} kind={kind} />
          </Reveal>
        ))}
      </div>

      {pages.length > 1 && (
        <nav className="flex flex-wrap items-center justify-center gap-1.5 pt-2">
          <PagerButton onClick={() => go(index - 1)} disabled={index === 0}>
            ← Previous
          </PagerButton>

          {pages.map((p, i) => (
            <PagerButton key={p.page} onClick={() => go(i)} active={i === index}>
              {p.page}
            </PagerButton>
          ))}

          <PagerButton onClick={() => go(index + 1)} disabled={index === pages.length - 1}>
            Next →
          </PagerButton>
        </nav>
      )}
    </div>
  );
}

function PagerButton({
  children,
  onClick,
  disabled,
  active,
}: {
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'min-w-9 rounded-lg border px-2.5 py-1.5 text-[13px] font-medium transition-colors',
        active
          ? 'border-ember-300 bg-ember-500 text-white'
          : 'border-sand-300 bg-white/70 text-ink-700 hover:border-sand-400 hover:text-ink-900',
        disabled && 'cursor-not-allowed opacity-40 hover:border-sand-300 hover:text-ink-700',
      )}
    >
      {children}
    </button>
  );
}

/** Results split into the pages they were scraped from, in order. */
function pagesOf(items: ResultItem[]): { page: number; items: ResultItem[] }[] {
  const byPage = new Map<number, ResultItem[]>();
  for (const item of items) {
    const page = item.page || 1;
    const list = byPage.get(page) ?? [];
    list.push(item);
    byPage.set(page, list);
  }
  return Array.from(byPage.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([page, list]) => ({ page, items: list }));
}

/**
 * A page read as prose.
 *
 * The point of asking for an article is to read it, so this is a reading
 * layout: one measured column, real paragraph spacing, headings that keep
 * their hierarchy.
 */
function DocumentView({ output }: { output: RunOutput }) {
  const doc = output.document!;

  return (
    <article className="mx-auto max-w-[68ch]">
      <header className="mb-6">
        <h3 className="font-display text-3xl leading-tight text-ink-900">{doc.title}</h3>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[12.5px] text-ink-400">
          <span>{doc.wordCount.toLocaleString()} words</span>
          <span>·</span>
          <span>
            {doc.sections.length} section{doc.sections.length === 1 ? '' : 's'}
          </span>
          {(doc.url || output.finalUrl) && (
            <a
              href={doc.url || output.finalUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="ml-auto inline-flex items-center gap-1.5 font-medium text-ember-600 underline underline-offset-4"
            >
              Open the original
              <ExternalIcon />
            </a>
          )}
        </div>
      </header>

      {doc.image && (
        <ResultImage
          src={doc.image}
          className="mb-6 w-full rounded-[18px] border border-sand-200 object-cover"
        />
      )}

      <div className="space-y-6">
        {doc.sections.map((section, i) => (
          <motion.section
            key={`${section.heading ?? 'lead'}-${i}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i * 0.02, 0.3), duration: 0.35 }}
          >
            {section.heading && (
              <h4
                className={cn(
                  'mb-2 font-display text-ink-900',
                  section.level <= 2 ? 'text-xl' : section.level === 3 ? 'text-lg' : 'text-base',
                )}
              >
                {section.heading}
              </h4>
            )}
            {section.paragraphs.map((p, j) => (
              <p key={j} className="mb-3 text-[15px] leading-[1.75] text-ink-700">
                {p}
              </p>
            ))}
          </motion.section>
        ))}
      </div>
    </article>
  );
}

/* ── shared pieces ────────────────────────────────────────────────────── */

function Reveal({ index, children }: { index: number; children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: Math.min(index * 0.035, 0.4), duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
      className="h-full"
    >
      {children}
    </motion.div>
  );
}

/** Anchor when the result links somewhere, plain box when it doesn't. */
function Shell({
  item,
  className,
  children,
}: {
  item: ResultItem;
  className?: string;
  children: React.ReactNode;
}) {
  const Tag = item.url ? 'a' : 'div';
  return (
    <Tag
      {...(item.url ? { href: item.url, target: '_blank', rel: 'noreferrer noopener' } : {})}
      className={cn(
        'block h-full',
        item.url && 'cursor-pointer',
        item.unavailable && 'opacity-65',
        className,
      )}
    >
      {children}
    </Tag>
  );
}

/** Meta facts, joined with the middot separator every site uses. */
function MetaLine({ parts, className }: { parts: (string | undefined)[]; className?: string }) {
  const shown = parts.filter(Boolean) as string[];
  if (!shown.length) return null;
  return (
    <p className={cn('text-[12px] text-ink-400', className)}>
      {shown.map((p, i) => (
        <span key={`${p}-${i}`}>
          {i > 0 && <span className="mx-1.5 text-ink-300">·</span>}
          {p}
        </span>
      ))}
    </p>
  );
}

/**
 * A scraped image, or nothing at all.
 *
 * Plenty of the URLs a page yields turn out not to be fetchable — expired
 * signatures, hotlink protection, a CDN that refuses the proxy. The browser's
 * answer to that is a broken-image glyph, which is uglier than the gap it
 * fills, so a failed load removes the element instead.
 */
function ResultImage({
  src,
  className,
  fallback,
}: {
  src: string | undefined;
  className: string;
  fallback?: React.ReactNode;
}) {
  /* Straight from the site first, through the runner only if that fails.
   *
   * Everything used to be proxied, because plenty of hosts serve images with
   * `Cross-Origin-Resource-Policy: same-site` and the browser refuses to paint
   * those on a page that isn't theirs. But most hosts don't — Daraz's two CDNs
   * both send `Access-Control-Allow-Origin: *` — and proxying anyway funnels
   * every image on the page through one server. A 400-product search meant 400
   * requests queued behind each other with a twelve-second timeout apiece, and
   * the ones that lost that race rendered as "no image" on products whose
   * pictures were fine.
   *
   * So the browser tries the real URL, which is cached, parallel and free, and
   * only the genuinely blocked ones cost the runner anything. */
  const [stage, setStage] = useState<'direct' | 'proxied' | 'failed'>('direct');
  if (!src || stage === 'failed') return <>{fallback ?? null}</>;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={stage === 'direct' ? src : api.imageUrl(src)}
      alt=""
      className={className}
      loading="lazy"
      onError={() => setStage((s) => (s === 'direct' ? 'proxied' : 'failed'))}
    />
  );
}

function UnavailableTag({ item }: { item: ResultItem }) {
  if (!item.unavailable) return null;
  return <Badge tone="rust">{item.unavailableReason ?? 'Unavailable'}</Badge>;
}

/* ── video ────────────────────────────────────────────────────────────── */

function VideoCard({ item }: { item: ResultItem }) {
  return (
    <Shell item={item} className="group">
      <div className="relative aspect-video w-full overflow-hidden rounded-[14px] border border-sand-200 bg-sand-100">
        <ResultImage
          src={item.image}
          className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
          fallback={
            <div className="flex size-full items-center justify-center text-ink-300">
              <PlayIcon />
            </div>
          }
        />
        {item.meta.duration && (
          <span className="absolute bottom-1.5 right-1.5 rounded-md bg-ink-900/85 px-1.5 py-0.5 font-mono text-[11px] font-medium text-white tabular-nums">
            {item.meta.duration}
          </span>
        )}
      </div>

      <h4 className="mt-2.5 line-clamp-2 text-[14px] font-medium leading-snug text-ink-900">
        {item.title}
      </h4>
      {item.meta.author && (
        <p className="mt-1 truncate text-[12.5px] text-ink-500">{item.meta.author}</p>
      )}
      <MetaLine parts={[item.meta.views, item.meta.published]} className="mt-0.5" />
      <UnavailableTag item={item} />
    </Shell>
  );
}

/* ── stays and places ─────────────────────────────────────────────────── */

function StayCard({ item }: { item: ResultItem }) {
  return (
    <Shell
      item={item}
      className="lift flex gap-4 rounded-[18px] border border-sand-200 bg-white/80 p-3"
    >
      <div className="size-28 shrink-0 overflow-hidden rounded-[14px] border border-sand-200 bg-sand-100 sm:size-32">
        <ResultImage
          src={item.image}
          className="size-full object-cover"
          fallback={
            <div className="flex size-full items-center justify-center text-[11px] text-ink-300">
              no photo
            </div>
          }
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <h4 className="line-clamp-2 text-[15px] font-medium leading-snug text-ink-900">
          {item.title}
        </h4>
        {item.meta.location && (
          <p className="mt-1 flex items-center gap-1 text-[12.5px] text-ink-500">
            <PinIcon />
            {item.meta.location}
          </p>
        )}

        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {typeof item.rating === 'number' && <Badge tone="moss">★ {item.rating.toFixed(1)}</Badge>}
          {item.meta.reviews && <span className="text-[11.5px] text-ink-400">{item.meta.reviews}</span>}
          <UnavailableTag item={item} />
          {item.badges.slice(0, 2).map((b) => (
            <Badge key={b} tone="outline">
              {b}
            </Badge>
          ))}
        </div>

        {item.description && (
          <p className="mt-1.5 line-clamp-2 text-[12.5px] leading-relaxed text-ink-500">
            {item.description}
          </p>
        )}
      </div>

      {item.price && (
        <div className="shrink-0 self-end text-right">
          <div className="font-display text-xl leading-none text-ember-600">
            {item.price.formatted}
          </div>
          <div className="mt-1 text-[11px] text-ink-400">total shown</div>
        </div>
      )}
    </Shell>
  );
}

/* ── flights ──────────────────────────────────────────────────────────── */

/**
 * An itinerary, laid out the way one is read.
 *
 * The route and the fare are what you scan; the legs are what you check once
 * something catches your eye. Every card on a flight results page carries the
 * same airline logo and the same heading, so neither of those can be the thing
 * that distinguishes one row from the next — the times have to be on the card.
 */
function FlightCard({ item }: { item: ResultItem }) {
  const route = item.attributes.find((a) => a.label === 'Route')?.value;
  const legs = item.attributes.filter((a) => a.label !== 'Route');

  return (
    <Shell
      item={item}
      className="lift flex gap-4 rounded-[18px] border border-sand-200 bg-white/80 p-4"
    >
      <div className="size-10 shrink-0 overflow-hidden rounded-[10px] border border-sand-200 bg-white">
        <ResultImage
          src={item.image}
          className="size-full object-contain p-1"
          fallback={
            <div className="flex size-full items-center justify-center text-[10px] text-ink-300">
              ✈
            </div>
          }
        />
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <h4 className="font-display text-[17px] leading-none text-ink-900">
            {route ?? item.title}
          </h4>
          {item.subtitle && <span className="text-[12.5px] text-ink-500">{item.subtitle}</span>}
        </div>

        {legs.map((leg) => (
          <div key={leg.label} className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
            <span className="w-[62px] shrink-0 text-[11px] font-medium uppercase tracking-wider text-ink-400">
              {leg.label}
            </span>
            <span className="tabular-nums text-ink-700">{leg.value}</span>
          </div>
        ))}

        <div className="flex flex-wrap items-center gap-1.5 empty:hidden">
          <UnavailableTag item={item} />
          {item.badges.slice(0, 3).map((b) => (
            <Badge key={b} tone="outline">
              {b}
            </Badge>
          ))}
        </div>
      </div>

      {item.price && (
        <div className="shrink-0 self-center text-right">
          <div className="font-display text-xl leading-none text-ember-600">
            {item.price.formatted}
          </div>
          <div className="mt-1 text-[11px] text-ink-400">from</div>
        </div>
      )}
    </Shell>
  );
}

/* ── products ─────────────────────────────────────────────────────────── */

function ProductCard({ item }: { item: ResultItem }) {
  return (
    <Shell
      item={item}
      className="lift flex flex-col rounded-[18px] border border-sand-200 bg-white/80 p-3"
    >
      <div className="aspect-square w-full overflow-hidden rounded-[14px] bg-white">
        <ResultImage
          src={item.image}
          className="size-full object-contain"
          fallback={
            <div className="flex size-full items-center justify-center text-[11px] text-ink-300">
              no image
            </div>
          }
        />
      </div>

      <h4 className="mt-2.5 line-clamp-2 text-[13px] leading-snug text-ink-800">{item.title}</h4>

      <div className="mt-auto pt-2">
        {item.price && (
          <div className="font-display text-lg leading-none text-ember-600">
            {item.price.formatted}
          </div>
        )}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {typeof item.rating === 'number' && (
            <span className="text-[11.5px] text-ink-500">★ {item.rating.toFixed(1)}</span>
          )}
          {item.meta.reviews && <span className="text-[11.5px] text-ink-400">{item.meta.reviews}</span>}
        </div>
        <UnavailableTag item={item} />
      </div>
    </Shell>
  );
}

/* ── articles and news ────────────────────────────────────────────────── */

function ArticleRow({ item }: { item: ResultItem }) {
  return (
    <Shell
      item={item}
      className="flex gap-4 rounded-[14px] border border-transparent px-3 py-3 transition-colors hover:border-sand-200 hover:bg-white/70"
    >
      <div className="min-w-0 flex-1">
        <MetaLine parts={[item.meta.source, item.meta.published]} />
        <h4 className="mt-0.5 text-[15px] font-medium leading-snug text-ink-900">{item.title}</h4>
        {(item.description || item.subtitle) && (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-500">
            {item.subtitle || item.description}
          </p>
        )}
        {item.meta.author && (
          <p className="mt-1 text-[11.5px] text-ink-400">{item.meta.author}</p>
        )}
      </div>

      <ResultImage
        src={item.image}
        className="size-20 shrink-0 rounded-[12px] border border-sand-200 object-cover"
      />
    </Shell>
  );
}

/* ── discussion threads ───────────────────────────────────────────────── */

function DiscussionRow({ item }: { item: ResultItem }) {
  const score = item.meta.points?.match(/[\d.,]+/)?.[0];

  return (
    <Shell
      item={item}
      className="flex items-baseline gap-3 rounded-[12px] px-3 py-2 transition-colors hover:bg-white/70"
    >
      {score && (
        <span className="w-12 shrink-0 text-right font-mono text-[13px] tabular-nums text-ember-600">
          {score}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <h4 className="text-[14px] leading-snug text-ink-900">{item.title}</h4>
        <MetaLine
          parts={[item.meta.author, item.meta.comments, item.meta.published]}
          className="mt-0.5"
        />
      </div>
    </Shell>
  );
}

/* ── repositories ─────────────────────────────────────────────────────── */

function RepoRow({ item }: { item: ResultItem }) {
  return (
    <Shell
      item={item}
      className="rounded-[14px] border border-sand-200 bg-white/70 px-4 py-3 transition-colors hover:border-sand-300"
    >
      <h4 className="font-mono text-[13.5px] font-medium text-ember-600">{item.title}</h4>
      {item.description && (
        <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-500">
          {item.description}
        </p>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-3 text-[11.5px] text-ink-400">
        {item.meta.language && (
          <span className="flex items-center gap-1.5">
            <span className="size-2 rounded-full bg-ember-400" aria-hidden />
            {item.meta.language}
          </span>
        )}
        {item.meta.stars && <span>★ {item.meta.stars}</span>}
        {item.meta.published && <span>{item.meta.published}</span>}
      </div>
    </Shell>
  );
}

/* ── anything else ────────────────────────────────────────────────────── */

function GenericCard({ item }: { item: ResultItem }) {
  return (
    <Shell
      item={item}
      className="lift flex gap-4 rounded-[18px] border border-sand-200 bg-white/80 p-4"
    >
      <ResultImage
        src={item.image}
        className="size-16 shrink-0 rounded-xl border border-sand-200 object-cover"
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-start gap-2">
          <h4 className="min-w-0 flex-1 text-[14.5px] font-medium leading-snug text-ink-900">
            {item.title}
          </h4>
          {item.price && (
            <span className="shrink-0 whitespace-nowrap font-display text-lg text-ember-600">
              {item.price.formatted}
            </span>
          )}
        </div>

        {item.subtitle && <p className="mt-0.5 text-[12.5px] text-ink-500">{item.subtitle}</p>}

        {item.description && !item.subtitle && (
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-ink-500">
            {item.description}
          </p>
        )}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <UnavailableTag item={item} />
          {typeof item.rating === 'number' && <Badge tone="moss">★ {item.rating.toFixed(1)}</Badge>}
          {item.badges.slice(0, 3).map((b) => (
            <Badge key={b} tone="outline">
              {b}
            </Badge>
          ))}
          {item.attributes.slice(0, 3).map((a, i) => (
            <span key={`${a.label}-${i}`} className="text-[11.5px] text-ink-400">
              {a.label ? `${a.label}: ` : ''}
              {a.value}
            </span>
          ))}
        </div>
      </div>

      {item.url && (
        <span className="mt-1 shrink-0 self-start text-ink-400">
          <ExternalIcon />
        </span>
      )}
    </Shell>
  );
}

function ConfirmationView({ output }: { output: RunOutput }) {
  const c = output.confirmation!;
  return (
    <div
      className={cn(
        'rounded-[18px] border p-6',
        c.ok ? 'border-lime-200 bg-lime-50/60' : 'border-red-200 bg-rust-100/50',
      )}
    >
      <div className="flex items-center gap-3">
        <span
          className={cn(
            'flex size-9 items-center justify-center rounded-full text-white',
            c.ok ? 'bg-lime-600' : 'bg-rust-500',
          )}
          aria-hidden
        >
          {c.ok ? '✓' : '!'}
        </span>
        <div>
          <h3 className="font-display text-xl text-ink-900">{c.message}</h3>
          {c.reference && (
            <p className="mt-0.5 font-mono text-[12.5px] text-ink-500">Reference {c.reference}</p>
          )}
        </div>
      </div>

      {c.details.length > 0 && (
        <dl className="mt-5 grid gap-x-8 gap-y-2.5 sm:grid-cols-2">
          {c.details.map((d, i) => (
            <div key={`${d.label}-${i}`} className="flex justify-between gap-4 border-b border-sand-200/70 pb-2">
              <dt className="text-[12.5px] text-ink-400">{d.label}</dt>
              <dd className="text-right text-[13px] font-medium text-ink-900">{d.value}</dd>
            </div>
          ))}
        </dl>
      )}

      {output.finalUrl && (
        <a
          href={output.finalUrl}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-5 inline-flex items-center gap-1.5 text-[13px] font-medium text-ember-600 underline underline-offset-4"
        >
          Open the confirmation page
          <ExternalIcon />
        </a>
      )}
    </div>
  );
}

function ErrorState({ run }: { run: Run }) {
  const err = run.error!;
  const needsHuman = ['captcha', 'bot_wall', 'login_required'].includes(err.code);

  return (
    <div
      className={cn(
        'rounded-[18px] border p-6',
        needsHuman ? 'border-amber-200 bg-amber-50/60' : 'border-red-200 bg-rust-100/40',
      )}
    >
      <div className="flex items-baseline gap-3">
        <h3 className="font-display text-xl text-ink-900">
          {needsHuman ? 'The site wants a human' : 'The run stopped'}
        </h3>
        <code className="rounded-md bg-white/70 px-1.5 py-0.5 font-mono text-[11px] text-ink-500">
          {err.code}
        </code>
      </div>

      <p className="mt-2 text-[14px] leading-relaxed text-ink-700">{err.message}</p>
      {err.suggestion && <p className="mt-3 text-[13px] leading-relaxed text-ink-500">{err.suggestion}</p>}

      {err.screenshot && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={api.screenshotUrl(err.screenshot)}
          alt="The page when the run stopped"
          className="mt-4 w-full rounded-xl border border-sand-200"
        />
      )}
    </div>
  );
}

function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" aria-hidden>
      <path
        d="M5.5 3H3.5A1.5 1.5 0 002 4.5v6A1.5 1.5 0 003.5 12h6a1.5 1.5 0 001.5-1.5v-2M8 2h4v4M12 2L6.5 7.5"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function PlayIcon() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9.25" stroke="currentColor" strokeWidth="1.2" />
      <path d="M10 8.5l5.5 3.5L10 15.5v-7z" fill="currentColor" />
    </svg>
  );
}

function PinIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden className="shrink-0">
      <path
        d="M6 11s3.75-4.2 3.75-6.5a3.75 3.75 0 10-7.5 0C2.25 6.8 6 11 6 11z"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      <circle cx="6" cy="4.5" r="1.25" stroke="currentColor" strokeWidth="1.1" />
    </svg>
  );
}

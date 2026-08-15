'use client';

import { motion } from 'motion/react';
import { SectionLabel } from '@/components/ui';

const EASE = [0.22, 1, 0.36, 1] as const;

/** Scroll-triggered entrance used by every section, so the page has one rhythm. */
function Rise({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-80px' }}
      transition={{ duration: 0.6, delay, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

/* ── how it works ─────────────────────────────────────────────────────── */

const STEPS = [
  {
    n: '01',
    title: 'Press record',
    body: 'The extension watches clicks, typing, dropdowns, calendars and filters — capturing several ways to find each element so replays survive site updates.',
    note: 'Passwords and card fields are never captured.',
  },
  {
    n: '02',
    title: 'Get a form',
    body: 'Mimic works out which values were decisions and which were scaffolding, then builds a form with the real widget for each one — a calendar stays a calendar.',
    note: 'Editable fields, constants stay hidden.',
  },
  {
    n: '03',
    title: 'Run it headlessly',
    body: 'Change what you like and hit run. A headless browser repeats the task, streaming every step, then reads the results back into Mimic.',
    note: 'Or call the generated REST endpoint.',
  },
];

export function HowItWorks() {
  return (
    <section id="how" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-24">
      <Rise>
        <SectionLabel>How it works</SectionLabel>
        <h2 className="mt-3 max-w-2xl font-display text-[clamp(2rem,4vw,3rem)] leading-[1.06] text-ink-900">
          Three steps between doing a thing once and never doing it again.
        </h2>
      </Rise>

      <div className="mt-14 grid gap-px overflow-hidden rounded-[18px] border border-sand-200 bg-sand-200 md:grid-cols-3">
        {STEPS.map((step, i) => (
          <Rise key={step.n} delay={i * 0.08}>
            <div className="group h-full bg-sand-50 p-7 transition-colors duration-300 hover:bg-white">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-[11px] text-ember-500">{step.n}</span>
                <h3 className="font-display text-2xl text-ink-900">{step.title}</h3>
              </div>
              <p className="mt-3 text-[14.5px] leading-relaxed text-ink-500">{step.body}</p>
              <p className="mt-5 border-t border-sand-200 pt-4 text-[12px] text-ink-400">{step.note}</p>
            </div>
          </Rise>
        ))}
      </div>
    </section>
  );
}

/* ── what it handles ──────────────────────────────────────────────────── */

const CAPABILITIES = [
  { title: 'Dropdowns & selects', body: 'Native and custom, with every option captured.' },
  { title: 'Calendars', body: 'Pages to the right month, then clicks the day — any picker.' },
  { title: 'Typeaheads', body: 'Types the query, waits for suggestions, picks the best match.' },
  { title: 'Checkboxes & filters', body: 'Toggles, pills, radio groups, sliders.' },
  { title: 'Currency & language', body: 'Preferences kept out of the way under Advanced.' },
  { title: 'Multi-page flows', body: 'Navigations, SPA route changes, iframes and shadow DOM.' },
];

export function Capabilities() {
  return (
    <section id="recorder" className="border-y border-sand-200 bg-sand-100/40 py-24">
      <div className="mx-auto max-w-6xl px-5">
        <Rise>
          <SectionLabel>Detail level</SectionLabel>
          <h2 className="mt-3 max-w-2xl font-display text-[clamp(2rem,4vw,3rem)] leading-[1.06] text-ink-900">
            It notices the small things, because the small things are the task.
          </h2>
        </Rise>

        <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {CAPABILITIES.map((cap, i) => (
            <Rise key={cap.title} delay={(i % 3) * 0.06}>
              <div className="lift h-full rounded-[18px] border border-sand-200 bg-white/70 p-5">
                <h3 className="text-[15px] font-medium text-ink-900">{cap.title}</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-500">{cap.body}</p>
              </div>
            </Rise>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ── output ───────────────────────────────────────────────────────────── */

export function OutputShowcase() {
  return (
    <section id="outputs" className="mx-auto max-w-6xl scroll-mt-24 px-5 py-24">
      <div className="grid items-center gap-14 lg:grid-cols-2">
        <Rise>
          <SectionLabel>Results</SectionLabel>
          <h2 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.06] text-ink-900">
            The answer comes back here, not in a tab you have to read.
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-ink-500">
            Mimic reads the finished page and rebuilds the results in its own layout — prices,
            ratings, durations, links. Every card opens the real page, and the run keeps a direct
            link to where it finished. If something is sold out or the search came back empty, it
            says so instead of showing you nothing.
          </p>
        </Rise>

        <Rise delay={0.1}>
          <div className="space-y-2.5">
            {[
              {
                title: 'Season highlights — full recap',
                meta: 'somevideos.example · 1.2M views · 42:10',
                price: '',
              },
              {
                title: 'Riverside Garden Rooms',
                meta: 'staysomewhere.example · Breakfast · 8.4',
                price: '12,410',
              },
              {
                title: 'Sent to team@company.example',
                meta: 'workmail.example · Weekly note · 1 attachment',
                price: '',
              },
              {
                title: 'Compact wireless keyboard',
                meta: 'anysite.example · Accessories · 4.6',
                price: '3,400',
                gone: true,
              },
            ].map((item, i) => (
              <motion.div
                key={item.title}
                initial={{ opacity: 0, y: 12 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ delay: i * 0.1, duration: 0.5, ease: EASE }}
                className={`lift flex items-center gap-4 rounded-[18px] border border-sand-200 bg-white/80 p-4 ${
                  item.gone ? 'opacity-60' : ''
                }`}
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-[14.5px] font-medium text-ink-900">{item.title}</span>
                    {item.gone && (
                      <span className="rounded-full bg-rust-100 px-2 py-0.5 text-[10px] font-medium text-rust-500">
                        sold out
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-[12.5px] text-ink-400">{item.meta}</div>
                </div>
                {item.price && (
                  <span className="shrink-0 font-display text-xl text-ember-600">{item.price}</span>
                )}
              </motion.div>
            ))}
          </div>
        </Rise>
      </div>
    </section>
  );
}

/* ── api ──────────────────────────────────────────────────────────────── */

export function ApiSection() {
  const snippet = `curl -X POST https://mimic.app/api/automations/au_9fK2/run?wait=1 \\
  -H "Content-Type: application/json" \\
  -d '{
    "query": "wireless keyboard",
    "category": "Accessories",
    "max_price": 5000,
    "sort_by": "Rating"
  }'`;

  return (
    <section id="api" className="border-t border-sand-200 bg-ink-900 py-24 text-sand-100">
      {/* A grid item is `min-width: auto` by default, so the widest line in the
          code block below sets the width of the whole row — and on a narrow
          screen that pushes the entire page sideways. `min-w-0` lets the item
          shrink and hands the overflow to the <pre>, which can scroll. */}
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 lg:grid-cols-2">
        <Rise className="min-w-0">
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ember-400">
            Every automation is an API
          </span>
          <h2 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.06] text-sand-50">
            One endpoint, generated the moment you stop recording.
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-sand-300/80">
            Call it from a cron job, a spreadsheet, or another product. You get the same structured
            JSON the dashboard renders — plus the run's live event stream if you want to follow
            along.
          </p>
        </Rise>

        <Rise delay={0.1} className="min-w-0">
          <pre className="overflow-x-auto rounded-[18px] border border-white/10 bg-black/30 p-5 font-mono text-[12.5px] leading-relaxed text-sand-200">
            <code>{snippet}</code>
          </pre>
        </Rise>
      </div>
    </section>
  );
}

/* ── closing ──────────────────────────────────────────────────────────── */

export function ClosingCta() {
  return (
    <section className="mx-auto max-w-6xl px-5 py-28 text-center">
      <Rise>
        <h2 className="mx-auto max-w-2xl font-display text-[clamp(2.25rem,5vw,3.5rem)] leading-[1.04] text-ink-900">
          You already know how to do the task. Do it once more.
        </h2>
        <p className="mx-auto mt-5 max-w-md text-[15px] leading-relaxed text-ink-500">
          Install the recorder, run through it as you normally would, and let Mimic take the
          repetition off your hands.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <a
            href="/sign-up"
            className="inline-flex h-12 items-center rounded-xl bg-ember-500 px-6 text-[15px] font-medium text-white transition-colors hover:bg-ember-600"
          >
            Create an account
          </a>
          <a
            href="/marketplace"
            className="inline-flex h-12 items-center rounded-xl border border-sand-300 bg-white/70 px-6 text-[15px] font-medium text-ink-800 transition-colors hover:bg-white"
          >
            See what others built
          </a>
        </div>
      </Rise>
    </section>
  );
}

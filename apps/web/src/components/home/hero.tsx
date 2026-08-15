'use client';

import { useEffect, useReducer } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { ButtonLink } from '@/components/ui';

/**
 * The hero demo cycles the product's whole promise in about twelve seconds:
 * a cursor fills a booking form, the form collapses into Mimic's own fields,
 * and a run streams to completion. It's the fastest honest explanation of what
 * the app does, so it earns the motion budget.
 */

type Phase = 'record' | 'compile' | 'run';
const ORDER: Phase[] = ['record', 'compile', 'run'];
const DURATIONS: Record<Phase, number> = { record: 5200, compile: 3400, run: 5600 };

const EASE = [0.22, 1, 0.36, 1] as const;

/**
 * Four unrelated tasks, cycled. Mimic isn't a travel tool — showing only a
 * flight search would say otherwise, however good the flight search looks.
 */
interface Scenario {
  site: string;
  appUrl: string;
  recordTitle: string;
  fields: { label: string; value: string; at: number }[];
  chips: string[];
  submit: string;
  compiled: { key: string; label: string; kind: string; value: string }[];
  runLines: string[];
  result: { title: string; meta: string; trailing?: string };
}

const SCENARIOS: Scenario[] = [
  {
    site: 'anysite.example/search',
    appUrl: 'mimic.app/automations/catalogue-search',
    recordTitle: 'Recording',
    fields: [
      { label: 'Search', value: 'wireless keyboard', at: 0.35 },
      { label: 'Category', value: 'Accessories', at: 1.0 },
      { label: 'Max price', value: '5,000', at: 1.7 },
      { label: 'Sort by', value: 'Rating', at: 2.3 },
    ],
    chips: ['In stock', 'Free delivery', 'Rated 4+'],
    submit: 'Show results',
    compiled: [
      { key: 'query', label: 'Search', kind: 'combobox', value: 'wireless keyboard' },
      { key: 'category', label: 'Category', kind: 'select', value: 'Accessories' },
      { key: 'max_price', label: 'Max price', kind: 'slider', value: '5000' },
      { key: 'sort_by', label: 'Sort by', kind: 'select', value: 'Rating' },
      { key: 'in_stock', label: 'In stock only', kind: 'checkbox', value: 'on' },
      { key: 'min_rating', label: 'Minimum rating', kind: 'radio', value: '4 and up' },
    ],
    runLines: [
      'Starting a clean browser session',
      'Opening anysite.example',
      'Typing “wireless keyboard”',
      'Setting max price to 5,000',
      'Applying filters · In stock · Rated 4+',
      'Reading the results off the page',
      'Found 48 items across 3 pages',
    ],
    result: { title: 'Compact wireless keyboard', meta: 'In stock · Free delivery · 4.6', trailing: '3,400' },
  },
  {
    site: 'somevideos.example',
    appUrl: 'mimic.app/automations/video-digest',
    recordTitle: 'Recording',
    fields: [
      { label: 'Search', value: 'season highlights', at: 0.4 },
      { label: 'Uploaded', value: 'This week', at: 1.5 },
      { label: 'Type', value: 'Video', at: 2.1 },
      { label: 'Length', value: 'Over 20 min', at: 2.7 },
    ],
    chips: ['HD', 'Subtitles', 'Sort: views'],
    submit: 'Search',
    compiled: [
      { key: 'query', label: 'Search', kind: 'combobox', value: 'season highlights' },
      { key: 'uploaded', label: 'Uploaded', kind: 'radio', value: 'This week' },
      { key: 'result_type', label: 'Type', kind: 'radio', value: 'Video' },
      { key: 'length', label: 'Length', kind: 'radio', value: 'Over 20 minutes' },
      { key: 'features', label: 'Features', kind: 'multiselect', value: 'HD, Subtitles' },
      { key: 'sort_by', label: 'Sort by', kind: 'select', value: 'View count' },
    ],
    runLines: [
      'Starting a clean browser session',
      'Opening somevideos.example',
      'Typing “season highlights”',
      'Opening filters · This week · Video',
      'Sorting by view count',
      'Scrolling to load every result',
      'Found 62 videos across 2 pages',
    ],
    result: { title: 'Season highlights — full recap', meta: '1.2M views · 4 days ago · 42:10' },
  },
  {
    site: 'staysomewhere.example',
    appUrl: 'mimic.app/automations/stay-search',
    recordTitle: 'Recording',
    fields: [
      { label: 'Destination', value: 'Riverside', at: 0.4 },
      { label: 'Check-in', value: '20 Aug 2026', at: 1.2 },
      { label: 'Check-out', value: '8 Sep 2026', at: 1.9 },
      { label: 'Guests', value: '2 adults, 1 room', at: 2.5 },
    ],
    chips: ['Breakfast', 'Rated 8+', 'Free cancellation'],
    submit: 'Search',
    compiled: [
      { key: 'destination', label: 'Destination', kind: 'combobox', value: 'Riverside' },
      { key: 'check_in', label: 'Check-in', kind: 'date', value: '2026-08-20' },
      { key: 'check_out', label: 'Check-out', kind: 'date', value: '2026-09-08' },
      { key: 'adults', label: 'Adults', kind: 'number', value: '2' },
      { key: 'rooms', label: 'Rooms', kind: 'number', value: '1' },
      { key: 'breakfast', label: 'Breakfast', kind: 'checkbox', value: 'on' },
    ],
    runLines: [
      'Starting a clean browser session',
      'Opening staysomewhere.example',
      'Matched “Riverside” from the suggestion list',
      'Set check-in 20 Aug, check-out 8 Sep',
      'Enabling filter · Breakfast',
      'Reading the results off the page',
      'Found 96 places · 4 unavailable',
    ],
    result: { title: 'Riverside Garden Rooms', meta: 'Twin room · Breakfast · 8.4', trailing: '12,410' },
  },
  {
    site: 'workmail.example',
    appUrl: 'mimic.app/automations/weekly-note',
    recordTitle: 'Recording',
    fields: [
      { label: 'To', value: 'team@company.example', at: 0.4 },
      { label: 'Subject', value: 'Weekly note', at: 1.2 },
      { label: 'Body', value: 'Numbers attached.', at: 1.9 },
      { label: 'Attachment', value: 'summary.pdf', at: 2.5 },
    ],
    chips: ['Cc finance', 'Mark important'],
    submit: 'Send',
    compiled: [
      { key: 'recipient', label: 'To', kind: 'combobox', value: 'team@company.example' },
      { key: 'subject', label: 'Subject', kind: 'text', value: 'Weekly note' },
      { key: 'body', label: 'Body', kind: 'textarea', value: 'Numbers attached.' },
      { key: 'attachment', label: 'Attachment', kind: 'file', value: 'summary.pdf' },
      { key: 'cc', label: 'Cc', kind: 'combobox', value: 'finance@company.example' },
      { key: 'important', label: 'Mark important', kind: 'toggle', value: 'on' },
    ],
    runLines: [
      'Starting a clean browser session',
      'Opening workmail.example',
      'Composing to team@company.example',
      'Attaching summary.pdf',
      'Marking as important',
      'Sending',
      'Delivered · thread #4821',
    ],
    result: { title: 'Sent to team@company.example', meta: 'Weekly note · 1 attachment · Cc finance' },
  },
  {
    site: 'cityportal.example/permits',
    appUrl: 'mimic.app/automations/permit-status',
    recordTitle: 'Recording',
    fields: [
      { label: 'Reference', value: 'PR-2026-4821', at: 0.4 },
      { label: 'Applicant', value: 'A. Rahman', at: 1.2 },
      { label: 'Year', value: '2026', at: 1.9 },
      { label: 'Office', value: 'North branch', at: 2.5 },
    ],
    chips: ['Include history', 'PDF receipt'],
    submit: 'Check status',
    compiled: [
      { key: 'reference', label: 'Reference', kind: 'text', value: 'PR-2026-4821' },
      { key: 'applicant', label: 'Applicant', kind: 'text', value: 'A. Rahman' },
      { key: 'year', label: 'Year', kind: 'select', value: '2026' },
      { key: 'office', label: 'Office', kind: 'select', value: 'North branch' },
      { key: 'include_history', label: 'Include history', kind: 'toggle', value: 'on' },
    ],
    runLines: [
      'Starting a clean browser session',
      'Opening cityportal.example',
      'Filling reference PR-2026-4821',
      'Selecting North branch · 2026',
      'Submitting the lookup',
      'Reading the result page',
      'Status: approved · issued 14 Aug',
    ],
    result: { title: 'Permit PR-2026-4821 — approved', meta: 'Issued 14 Aug · North branch · valid 12 months' },
  },
];

export function Hero() {
  const reduced = useReducedMotion();
  // One counter drives both: phase cycles fast, the scenario changes each lap.
  const [tick, next] = useReducer((i: number) => i + 1, 0);
  const phase = ORDER[tick % ORDER.length];
  const scenario = SCENARIOS[Math.floor(tick / ORDER.length) % SCENARIOS.length];

  useEffect(() => {
    if (reduced) return;
    const t = setTimeout(next, DURATIONS[phase]);
    return () => clearTimeout(t);
  }, [tick, phase, reduced]);

  return (
    <section className="relative overflow-hidden px-5 pb-16 pt-14 sm:pt-20">
      <Orbs />

      <div className="mx-auto grid max-w-6xl items-center gap-14 lg:grid-cols-[1.05fr_1fr]">
        {/* ── copy ─────────────────────────────────────────────────── */}
        <div className="relative z-10">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="inline-flex items-center gap-2 rounded-full border border-sand-300 bg-white/60 px-3 py-1 text-[12px] text-ink-500"
          >
            <span className="relative flex size-1.5">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-ember-400 opacity-70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-ember-500" />
            </span>
            Works on any site — no integration required
          </motion.div>

          <h1 className="mt-6 font-display text-[clamp(2.75rem,6.5vw,4.5rem)] leading-[0.98] text-ink-900">
            <Reveal delay={0.05}>Record it once.</Reveal>
            <Reveal delay={0.14}>
              <span className="relative inline-block">
                <span className="relative z-10 italic text-ember-600">Run it forever.</span>
                <motion.svg
                  aria-hidden
                  viewBox="0 0 300 12"
                  preserveAspectRatio="none"
                  className="absolute -bottom-1 left-0 z-0 h-3 w-full text-ember-300"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: 0.75, duration: 0.3 }}
                >
                  <motion.path
                    d="M2 8C60 3 120 3 180 6c40 2 80 3 118 0"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="3.5"
                    strokeLinecap="round"
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: 1 }}
                    transition={{ delay: 0.75, duration: 0.7, ease: EASE }}
                  />
                </motion.svg>
              </span>
            </Reveal>
          </h1>

          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.35, duration: 0.55, ease: EASE }}
            className="mt-6 max-w-lg text-[17px] leading-relaxed text-ink-500"
          >
            Hit record and do the task once — any task, on any site. Mimic reads what you did,
            hands you a form with every field it found, and replays the whole thing headlessly
            whenever you ask.
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.45, duration: 0.55, ease: EASE }}
            className="mt-8 flex flex-wrap items-center gap-3"
          >
            <ButtonLink href="/sign-up" size="lg">
              Start recording
            </ButtonLink>
            <ButtonLink href="/voice" variant="secondary" size="lg">
              <MicGlyph />
              Or just say it
            </ButtonLink>
          </motion.div>

          <motion.dl
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.7, duration: 0.6 }}
            className="mt-10 flex flex-wrap gap-x-9 gap-y-4"
          >
            {[
              ['Every widget', 'dropdowns, calendars, filters'],
              ['Every site', 'no API needed'],
              ['Every result', 'scraped into clean JSON'],
            ].map(([term, def]) => (
              <div key={term}>
                <dt className="text-sm font-medium text-ink-900">{term}</dt>
                <dd className="text-[13px] text-ink-400">{def}</dd>
              </div>
            ))}
          </motion.dl>
        </div>

        {/* ── demo ─────────────────────────────────────────────────── */}
        <div className="relative z-10">
          <PhaseRail phase={phase} />
          <div className="relative mt-4 h-[420px]">
            <AnimatePresence mode="wait">
              {phase === 'record' && <RecordPanel key={`record-${scenario.site}`} s={scenario} />}
              {phase === 'compile' && <CompilePanel key={`compile-${scenario.site}`} s={scenario} />}
              {phase === 'run' && <RunPanel key={`run-${scenario.site}`} s={scenario} />}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── shared bits ──────────────────────────────────────────────────────── */

function MicGlyph() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="1.8" />
      <path d="M5 11a7 7 0 0014 0M12 18v3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <span className="block overflow-hidden pb-[0.08em]">
      <motion.span
        className="block"
        initial={{ y: '110%' }}
        animate={{ y: 0 }}
        transition={{ delay, duration: 0.8, ease: EASE }}
      >
        {children}
      </motion.span>
    </span>
  );
}

function Orbs() {
  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
      <motion.div
        className="absolute -right-24 -top-32 size-[30rem] rounded-full bg-ember-200/40 blur-3xl"
        animate={{ y: [0, 22, 0], x: [0, -14, 0] }}
        transition={{ duration: 16, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        className="absolute -left-32 top-40 size-[26rem] rounded-full bg-sand-300/40 blur-3xl"
        animate={{ y: [0, -20, 0] }}
        transition={{ duration: 19, repeat: Infinity, ease: 'easeInOut' }}
      />
    </div>
  );
}

const PHASE_COPY: Record<Phase, { label: string; note: string }> = {
  record: { label: 'Record', note: 'watching what you do' },
  compile: { label: 'Compile', note: 'turning it into a form' },
  run: { label: 'Run', note: 'replaying it headlessly' },
};

function PhaseRail({ phase }: { phase: Phase }) {
  return (
    <div className="flex items-center gap-1.5">
      {ORDER.map((p) => {
        const active = p === phase;
        return (
          <div key={p} className="flex flex-1 flex-col gap-1.5">
            <div className="h-[3px] overflow-hidden rounded-full bg-sand-200">
              {active && (
                <motion.div
                  className="h-full rounded-full bg-ember-500"
                  initial={{ scaleX: 0 }}
                  animate={{ scaleX: 1 }}
                  transition={{ duration: DURATIONS[p] / 1000, ease: 'linear' }}
                  style={{ transformOrigin: 'left' }}
                />
              )}
            </div>
            <span
              className={`text-[11px] transition-colors duration-300 ${
                active ? 'text-ink-900' : 'text-ink-400'
              }`}
            >
              {PHASE_COPY[p].label}
              {active && <span className="hidden text-ink-400 sm:inline"> · {PHASE_COPY[p].note}</span>}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const panelMotion = {
  initial: { opacity: 0, y: 12, filter: 'blur(6px)' },
  animate: { opacity: 1, y: 0, filter: 'blur(0px)' },
  exit: { opacity: 0, y: -10, filter: 'blur(6px)' },
  transition: { duration: 0.45, ease: EASE },
};

function Panel({ children, chrome }: { children: React.ReactNode; chrome: string }) {
  return (
    <motion.div
      {...panelMotion}
      className="absolute inset-0 overflow-hidden rounded-[18px] border border-sand-200 bg-white/80 shadow-[0_24px_60px_-30px_rgba(33,23,16,0.35)] backdrop-blur"
    >
      <div className="flex items-center gap-2 border-b border-sand-200 bg-sand-50/80 px-4 py-2.5">
        <span className="flex gap-1.5">
          <span className="size-2 rounded-full bg-sand-300" />
          <span className="size-2 rounded-full bg-sand-300" />
          <span className="size-2 rounded-full bg-sand-300" />
        </span>
        <span className="ml-1 truncate rounded-md bg-white px-2 py-0.5 text-[11px] text-ink-400">
          {chrome}
        </span>
      </div>
      <div className="p-4">{children}</div>
    </motion.div>
  );
}

/* ── phase 1: recording a real-looking booking form ───────────────────── */

function RecordPanel({ s }: { s: Scenario }) {
  return (
    <Panel chrome={s.site}>
      <div className="mb-3 flex items-center gap-2">
        <motion.span
          className="size-2 rounded-full bg-ember-500"
          animate={{ opacity: [1, 0.35, 1] }}
          transition={{ duration: 1.3, repeat: Infinity }}
        />
        <span className="text-[11px] font-medium text-ink-500">{s.recordTitle}</span>
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {s.fields.map((f) => (
          <div key={f.label} className="rounded-xl border border-sand-200 bg-sand-50/60 px-3 py-2.5">
            <div className="text-[10px] uppercase tracking-wider text-ink-400">{f.label}</div>
            <div className="mt-1 h-5 text-[13px] font-medium text-ink-900">
              <Typewriter text={f.value} delay={f.at} />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {s.chips.map((chip, i) => (
          <motion.span
            key={chip}
            initial={{ opacity: 0.4, scale: 0.96 }}
            animate={{
              opacity: [0.4, 1, 1],
              scale: [0.96, 1.04, 1],
              backgroundColor: ['#f9f1e6', '#ffedd5', '#ffedd5'],
            }}
            transition={{ delay: 2.9 + i * 0.28, duration: 0.5, ease: EASE }}
            className="rounded-full border border-sand-200 px-2.5 py-1 text-[11px] text-ink-700"
          >
            {chip}
          </motion.span>
        ))}
      </div>

      <motion.div
        className="mt-4 h-9 rounded-xl bg-ember-500/90 text-center text-[13px] font-medium leading-9 text-white"
        animate={{ scale: [1, 0.97, 1] }}
        transition={{ delay: 4.2, duration: 0.35 }}
      >
        {s.submit}
      </motion.div>

      <Cursor />
    </Panel>
  );
}

function Typewriter({ text, delay }: { text: string; delay: number }) {
  return (
    <motion.span
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ delay, duration: 0.15 }}
      // Each character is its own span, so whitespace must be preserved
      // explicitly or the browser collapses the gaps between them.
      className="inline-flex whitespace-pre"
    >
      {text.split('').map((ch, i) => (
        <motion.span
          key={`${ch}-${i}`}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: delay + i * 0.035, duration: 0.01 }}
        >
          {ch}
        </motion.span>
      ))}
    </motion.span>
  );
}

/** A cursor that visits each field in turn, then the submit button. */
function Cursor() {
  return (
    <motion.svg
      aria-hidden
      width="16"
      height="19"
      viewBox="0 0 16 19"
      className="pointer-events-none absolute left-0 top-0 z-20 drop-shadow"
      initial={{ x: 250, y: 300, opacity: 0 }}
      animate={{
        x: [250, 70, 210, 70, 210, 150],
        y: [300, 92, 92, 148, 148, 300],
        opacity: [0, 1, 1, 1, 1, 1],
      }}
      transition={{ duration: 4.6, times: [0, 0.14, 0.35, 0.5, 0.68, 0.95], ease: EASE }}
    >
      <path d="M1 1l13 6.5-5.6 1.7L5.6 18 1 1z" fill="#211710" stroke="#fff" strokeWidth="1.2" />
    </motion.svg>
  );
}

/* ── phase 2: the recording becomes a form ────────────────────────────── */

function CompilePanel({ s }: { s: Scenario }) {
  return (
    <Panel chrome={s.appUrl}>
      <div className="mb-3 flex items-center justify-between">
        <span className="text-[11px] font-medium text-ink-500">
          {s.compiled.length} fields detected
        </span>
        <span className="rounded-full bg-moss-100 px-2 py-0.5 text-[10px] font-medium text-lime-800">
          types preserved
        </span>
      </div>

      <div className="space-y-2">
        {s.compiled.map((f, i) => (
          <motion.div
            key={f.key}
            initial={{ opacity: 0, x: -14 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: 0.12 + i * 0.11, duration: 0.4, ease: EASE }}
            className="flex items-center gap-3 rounded-xl border border-sand-200 bg-white px-3 py-2"
          >
            <span className="w-20 shrink-0 text-[11px] text-ink-400">{f.label}</span>
            <span className="flex-1 truncate text-[13px] font-medium text-ink-900">{f.value}</span>
            <span className="rounded-md bg-sand-100 px-1.5 py-0.5 font-mono text-[10px] text-ink-500">
              {f.kind}
            </span>
          </motion.div>
        ))}
      </div>
    </Panel>
  );
}

/* ── phase 3: the headless run ────────────────────────────────────────── */

function RunPanel({ s }: { s: Scenario }) {
  return (
    <Panel chrome="mimic.app/runs/live">
      <div className="mb-3 flex items-center gap-2">
        <span className="text-[11px] font-medium text-ink-500">Run in progress</span>
        <div className="ml-auto h-1.5 w-28 overflow-hidden rounded-full bg-sand-200">
          <motion.div
            className="h-full rounded-full bg-ember-500"
            initial={{ scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 4.6, ease: 'easeInOut' }}
            style={{ transformOrigin: 'left' }}
          />
        </div>
      </div>

      <div className="space-y-1.5 font-mono text-[11.5px]">
        {s.runLines.map((line, i) => (
          <motion.div
            key={line}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.2 + i * 0.62, duration: 0.32, ease: EASE }}
            className="flex items-start gap-2 text-ink-500"
          >
            <motion.span
              className="mt-[5px] size-1.5 shrink-0 rounded-full bg-ember-400"
              initial={{ scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ delay: 0.2 + i * 0.62, duration: 0.25, ease: EASE }}
            />
            <span className={i === s.runLines.length - 1 ? 'text-ink-900' : undefined}>{line}</span>
          </motion.div>
        ))}
      </div>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 4.4, duration: 0.4, ease: EASE }}
        className="mt-4 rounded-xl border border-sand-200 bg-sand-50/70 p-3"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-[13px] font-medium text-ink-900">{s.result.title}</span>
          {s.result.trailing && (
            <span className="shrink-0 font-display text-[17px] text-ember-600">{s.result.trailing}</span>
          )}
        </div>
        <div className="mt-1 text-[11px] text-ink-400">{s.result.meta}</div>
      </motion.div>
    </Panel>
  );
}

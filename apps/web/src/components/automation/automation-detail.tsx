'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import type { Run, RunEvent, RunStatus } from '@mimic/schema';
import { api, curlSnippet, streamRun, type AutomationSummary, type RunStream } from '@/lib/api';
import { DynamicForm, type Values } from '@/components/form/dynamic-form';
import { RunConsole } from '@/components/run/run-console';
import { OutputView } from '@/components/run/output-view';
import { RunApiPanel } from '@/components/run/run-api-panel';
import { RegionPicker } from '@/components/run/region-picker';
import { Badge, Button, Card, SectionLabel, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { cn, faviconFor, formatDuration, formatRelative } from '@/lib/utils';

type Tab = 'run' | 'api' | 'json';

export function AutomationDetail({ id, isNew }: { id: string; isNew?: boolean }) {
  const { user } = useAuth();
  const [automation, setAutomation] = useState<AutomationSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [values, setValues] = useState<Values>({});
  const [tab, setTab] = useState<Tab>('run');

  const [runId, setRunId] = useState<string | null>(null);
  const [status, setStatus] = useState<RunStatus>('queued');
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [starting, setStarting] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const streamRef = useRef<RunStream | null>(null);

  // Load the automation and seed the form with what was recorded.
  useEffect(() => {
    let cancelled = false;
    api
      .getAutomation(id)
      .then((a) => {
        if (cancelled) return;
        setAutomation(a);
        const seed: Values = {};
        for (const f of a.schema.fields) {
          if (f.exposure !== 'constant' && f.defaultValue !== null && f.defaultValue !== undefined) {
            seed[f.key] = f.defaultValue;
          }
        }
        setValues(seed);
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => () => streamRef.current?.close(), []);

  const progress = useMemo(() => {
    const last = [...events].reverse().find((e) => typeof e.progress === 'number');
    if (last?.progress !== undefined) return last.progress;
    return status === 'succeeded' || status === 'partial' ? 100 : 0;
  }, [events, status]);

  const start = useCallback(async () => {
    if (!automation) return;
    setStarting(true);
    setRunError(null);
    setEvents([]);
    setRun(null);
    setStatus('queued');
    streamRef.current?.close();

    try {
      const started = await api.startRun(automation.id, values, { userId: user?.id });
      const newRunId = started.runId;
      setRunId(newRunId);
      setStatus('running');

      /* Already finished. A serverless run has no socket to follow — it ran
         inside the request and came back whole — so opening one would wait for
         events that were emitted before this line executed. */
      if (started.run) {
        setEvents(started.run.events ?? []);
        setRun(started.run);
        setStatus(started.run.status);
        return;
      }

      streamRef.current = streamRun(newRunId, {
        onEvent: (event) => {
          setEvents((prev) => [...prev, event]);
          if (event.phase === 'error') setStatus('failed');
        },
        onEnd: (finished) => {
          if (finished) {
            setRun(finished);
            setStatus(finished.status);
          } else {
            api.getRun(newRunId).then((r) => {
              setRun(r);
              setStatus(r.status);
            });
          }
        },
        onError: (message) => setRunError(message),
      });
    } catch (e) {
      setRunError((e as Error).message);
      setStatus('failed');
    } finally {
      setStarting(false);
    }
  }, [automation, values]);

  if (loadError) {
    return (
      <div className="mx-auto max-w-2xl px-5 py-24">
        <Card>
          <h1 className="font-display text-2xl text-ink-900">Couldn&rsquo;t load this automation</h1>
          <p className="mt-2 text-sm leading-relaxed text-ink-500">{loadError}</p>
          <Link href="/dashboard" className="mt-4 inline-block text-sm font-medium text-ember-600 underline underline-offset-4">
            Back to the dashboard
          </Link>
        </Card>
      </div>
    );
  }

  if (!automation) {
    return (
      <div className="mx-auto flex max-w-6xl items-center gap-3 px-5 py-24 text-ink-400">
        <Spinner /> Loading automation…
      </div>
    );
  }

  const schema = automation.schema;
  const running = ['queued', 'starting', 'running'].includes(status) && runId !== null && !run;
  const editable = schema.fields.filter((f) => f.exposure !== 'constant');

  return (
    <div className="mx-auto max-w-6xl px-5 py-10">
      {isNew && (
        <motion.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-6 rounded-[18px] border border-ember-200 bg-ember-50 px-4 py-3 text-[13.5px] text-ember-700"
        >
          Recording compiled. {editable.length} field{editable.length === 1 ? '' : 's'} found — edit
          anything below and run it.
        </motion.div>
      )}

      {/* ── header ─────────────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start gap-4">
        <span className="flex size-12 shrink-0 items-center justify-center rounded-2xl border border-sand-200 bg-white text-2xl">
          {automation.emoji}
        </span>

        <div className="min-w-0 flex-1">
          <h1 className="font-display text-[clamp(1.75rem,3.5vw,2.5rem)] leading-tight text-ink-900">
            {automation.name}
          </h1>
          <p className="mt-1 max-w-2xl text-[14px] leading-relaxed text-ink-500">
            {automation.description}
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-sand-200 bg-white/70 px-2.5 py-1 text-[12px] text-ink-500">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={faviconFor(automation.site)} alt="" className="size-3.5 rounded-sm" />
              {automation.site}
            </span>
            <Badge tone="outline">{automation.stepCount} steps</Badge>
            <Badge tone="outline">{editable.length} fields</Badge>
            {automation.stats.runs > 0 && (
              <Badge tone="outline">
                {automation.stats.runs} run{automation.stats.runs === 1 ? '' : 's'} ·{' '}
                {formatRelative(automation.stats.lastRunAt)}
              </Badge>
            )}
            {schema.heuristicOnly && (
              <Badge tone="ember">rule-built form — AI refinement unavailable</Badge>
            )}
          </div>
        </div>
      </header>

      {/* ── tabs ───────────────────────────────────────────────────── */}
      <div className="mt-8 flex gap-1 border-b border-sand-200">
        {(
          [
            ['run', 'Run'],
            ['api', 'REST API'],
            ['json', 'JSON'],
          ] as [Tab, string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={cn(
              'relative px-3.5 py-2.5 text-[13.5px] transition-colors',
              tab === key ? 'text-ink-900' : 'text-ink-400 hover:text-ink-700',
            )}
          >
            {label}
            {tab === key && (
              <motion.span
                layoutId="detail-tab"
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-ember-500"
                transition={{ type: 'spring', stiffness: 400, damping: 34 }}
              />
            )}
          </button>
        ))}
      </div>

      <AnimatePresence mode="wait">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
          className="pt-7"
        >
          {/* min-w-0 on both grid columns: without it a long unbreakable string
              in the console (a tracking URL, a Playwright call log) forces the
              grid to widen and crushes the form beside it. */}
          {tab === 'run' && (
            <div className="grid gap-7 lg:grid-cols-[1.15fr_1fr]">
              <div className="min-w-0">
                <SectionLabel>Inputs</SectionLabel>
                <div className="mt-4">
                  <DynamicForm schema={schema} values={values} onChange={setValues} disabled={running} />
                </div>

                <div className="mt-7 flex flex-wrap items-center gap-3">
                  <Button size="lg" onClick={start} loading={starting || running}>
                    {running ? 'Running…' : 'Run automation'}
                  </Button>
                  <span className="text-[12.5px] text-ink-400">
                    {/* Once it has actually run, the measured average beats a
                        guess made from the recording's pauses. */}
                    {automation.stats.avgDurationMs
                      ? `Averages ${formatDuration(automation.stats.avgDurationMs)} over ${automation.stats.runs} run${
                          automation.stats.runs === 1 ? '' : 's'
                        }`
                      : `Usually takes about ${formatDuration(schema.estimatedDurationMs)}`}
                  </span>
                </div>

                {runError && (
                  <p className="mt-4 rounded-xl border border-red-200 bg-rust-100/50 px-3.5 py-2.5 text-[13px] text-rust-500">
                    {runError}
                  </p>
                )}
              </div>

              <div className="min-w-0 space-y-5">
                {(runId || run) && (
                  <RunConsole events={events} status={status} progress={progress} />
                )}
                {!runId && !run && (
                  <div className="rounded-[18px] border border-dashed border-sand-300 bg-white/40 p-6 text-center">
                    <p className="text-[13.5px] leading-relaxed text-ink-400">
                      Fill in what you need and press run. Every step the browser takes shows up
                      here as it happens.
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'api' && <ApiTab automation={automation} values={values} />}

          {tab === 'json' && (
            <CodeBlock
              label="Compiled schema"
              code={JSON.stringify({ ...schema, traceId: undefined }, null, 2)}
            />
          )}
        </motion.div>
      </AnimatePresence>

      {/* ── output ─────────────────────────────────────────────────── */}
      {run && (
        <motion.section
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
          className="mt-12 border-t border-sand-200 pt-9"
        >
          <div className="mb-5 flex flex-wrap items-baseline gap-3">
            <SectionLabel>Output</SectionLabel>
            <span className="text-[12.5px] text-ink-400">
              run {run.id} · {formatDuration(run.durationMs)}
            </span>
          </div>

          <OutputView run={run} />

          {/* The endpoint that just produced this, with these values in it.
              The REST API tab above shows the call in the abstract, before
              anything has run; this is the one that returned what is on the
              screen. The voice page has had it under its results all along and
              the recorded page — where the endpoint is the entire point of
              recording — did not. */}
          <div className="mt-6">
            <RunApiPanel run={run} automationId={automation.id} input={values} />
          </div>

          <RegionPicker
            run={run}
            automation={automation}
            onSaved={(itemLocator) =>
              setAutomation({
                ...automation,
                schema: {
                  ...automation.schema,
                  output: {
                    ...automation.schema.output,
                    itemLocator: itemLocator || undefined,
                    itemLocatorPinned: Boolean(itemLocator),
                  },
                },
              })
            }
          />

          <details className="mt-6 rounded-[18px] border border-sand-200 bg-white/50 p-4">
            <summary className="cursor-pointer list-none text-[13px] font-medium text-ink-700">
              Raw JSON output
            </summary>
            <pre className="mt-3 max-h-96 overflow-auto rounded-xl bg-ink-900 p-4 font-mono text-[11.5px] leading-relaxed text-sand-200">
              <code>{JSON.stringify(run.output ?? run.error, null, 2)}</code>
            </pre>
          </details>
        </motion.section>
      )}
    </div>
  );
}

/* ── api tab ──────────────────────────────────────────────────────────── */

function ApiTab({ automation, values }: { automation: AutomationSummary; values: Values }) {
  const payload = useMemo(() => {
    const out: Values = {};
    for (const f of automation.schema.fields) {
      if (f.exposure === 'constant') continue;
      const v = values[f.key] ?? f.defaultValue;
      if (v !== null && v !== undefined && v !== '') out[f.key] = v;
    }
    return out;
  }, [automation.schema.fields, values]);

  return (
    <div className="space-y-6">
      <div>
        <SectionLabel>Endpoint</SectionLabel>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-ink-500">
          This automation is callable as a REST endpoint. Add <code className="rounded bg-sand-100 px-1 font-mono text-[12.5px]">?wait=1</code>{' '}
          to block until it finishes and get the output inline; leave it off to get a run id and
          follow the websocket stream instead.
        </p>
      </div>

      <CodeBlock label="curl" code={curlSnippet(automation.id, payload)} />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="rounded-[18px] border border-sand-200 bg-white/60 p-4">
          <h4 className="text-[13px] font-medium text-ink-900">Request body</h4>
          <p className="mt-1 text-[12.5px] text-ink-400">Every editable field, by key.</p>
          <ul className="mt-3 space-y-1.5">
            {automation.schema.fields
              .filter((f) => f.exposure !== 'constant')
              .map((f) => (
                <li key={f.key} className="flex items-baseline gap-2 text-[12.5px]">
                  <code className="font-mono text-ink-900">{f.key}</code>
                  <span className="text-ink-400">{f.kind}</span>
                  {f.required && <span className="text-ember-500">required</span>}
                </li>
              ))}
          </ul>
        </div>

        <div className="rounded-[18px] border border-sand-200 bg-white/60 p-4">
          <h4 className="text-[13px] font-medium text-ink-900">Live stream</h4>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-400">
            Connect a websocket to follow a run event by event. History is replayed on connect, so
            nothing is missed.
          </p>
          <code className="mt-3 block break-all rounded-lg bg-sand-100 p-2.5 font-mono text-[11.5px] text-ink-700">
            {process.env.NEXT_PUBLIC_RUNNER_WS || 'ws://localhost:8787'}/ws?runId=&lt;runId&gt;
          </code>
        </div>
      </div>
    </div>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="overflow-hidden rounded-[18px] border border-sand-200 bg-ink-900">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-2.5">
        <span className="font-mono text-[11px] uppercase tracking-wider text-sand-400">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="rounded-md px-2 py-1 text-[12px] text-sand-300 transition-colors hover:bg-white/10 hover:text-white"
        >
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="max-h-[28rem] overflow-auto p-4 font-mono text-[12px] leading-relaxed text-sand-200">
        <code>{code}</code>
      </pre>
    </div>
  );
}

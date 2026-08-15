'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { FormSchema, Run, RunEvent, RunStatus } from '@mimic/schema';
import { api, runnerUnreachable, RUNNER_URL, streamRun, type RunStream } from '@/lib/api';
import { RunConsole } from '@/components/run/run-console';
import { OutputView } from '@/components/run/output-view';
import { RunApiPanel } from '@/components/run/run-api-panel';
import { Badge, Button, SectionLabel, Spinner } from '@/components/ui';
import { useAuth } from '@/lib/auth-context';
import { startMic, type MicSession } from '@/lib/mic';
import { cn } from '@/lib/utils';

/**
 * Speak a task, watch it run.
 *
 * Speech-to-text happens in the browser (the Web Speech API, which Chrome,
 * Edge and Brave all implement). The transcript goes to the runner, which
 * builds an automation for what was asked — opening the site and working out
 * how to do it — and reuses a saved one only when it does the identical job.
 * Nothing runs until you confirm — a misheard word should never book a flight.
 */

interface VoicePlan {
  automationId: string | null;
  confidence: number;
  values: Record<string, unknown>;
  say: string;
  suggestion?: string;
  missing: string[];
  /** True when Mimic authored this automation instead of matching a recording. */
  created?: boolean;
  automation: { id: string; name: string; site: string; emoji: string; schema: FormSchema } | null;
}

type Stage = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'ready' | 'running' | 'done';

const STAGE_HINT: Record<Stage, string> = {
  idle: 'Tap to speak',
  listening: 'Listening — tap again when you’re done',
  transcribing: 'Writing down what you said…',
  thinking: 'Working out what you meant…',
  ready: 'Check it over, then run it',
  running: 'Running…',
  done: 'Done — ask for something else any time',
};

/* Minimal typings — the Web Speech API isn't in lib.dom. */
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: SpeechRecognitionEventLike) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

export function VoiceStudio() {
  const { user } = useAuth();
  const [stage, setStage] = useState<Stage>('idle');
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [plan, setPlan] = useState<VoicePlan | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const [supported, setSupported] = useState(true);
  /** null while unknown; false when the runner has no transcription provider. */
  const [sttReady, setSttReady] = useState<boolean | null>(null);
  /** Running against a runner on this machine, rather than a deployed site. */
  const onOwnMachine =
    typeof window !== 'undefined' && /localhost|127\.0\.0\.1/.test(window.location.host);

  const [events, setEvents] = useState<RunEvent[]>([]);
  const [status, setStatus] = useState<RunStatus>('queued');
  const [run, setRun] = useState<Run | null>(null);
  const streamRef = useRef<RunStream | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  /** Did the browser's recogniser produce anything at all this time? */
  const heardAnythingRef = useRef(false);
  const micRef = useRef<MicSession | null>(null);
  const meterRef = useRef<number | null>(null);
  /** Live input level and elapsed seconds, for the meter. */
  const [level, setLevel] = useState(0);
  const [seconds, setSeconds] = useState(0);
  /** How speech is being captured: the browser's recogniser, or raw audio. */
  const [mode, setMode] = useState<'speech' | 'audio'>('speech');
  // buildPlan is defined below; the recorder's onstop needs it without
  // reordering the whole component.
  const buildPlanRef = useRef<((text: string) => Promise<void>) | null>(null);

  useEffect(() => {
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
      brave?: unknown;
    };
    // Either route counts: the browser's own recogniser, or recording audio and
    // letting the runner transcribe it.
    setSupported(
      Boolean(w.SpeechRecognition || w.webkitSpeechRecognition) ||
        Boolean(navigator.mediaDevices?.getUserMedia),
    );

    // Brave ships the Web Speech API but blocks the backend it needs, so the
    // failure only shows up after someone has already spoken. Check whether the
    // runner can transcribe instead, and say so before they bother.
    void api
      .capabilities()
      .then((h) => setSttReady(Boolean(h.stt)))
      .catch(() => setSttReady(false));

    return () => {
      recognitionRef.current?.stop();
      streamRef.current?.close();
    };
  }, []);

  const progress = useMemo(() => {
    const last = [...events].reverse().find((e) => typeof e.progress === 'number');
    return last?.progress ?? (status === 'succeeded' ? 100 : 0);
  }, [events, status]);

  /* ── speech ─────────────────────────────────────────────────────────── */

  /**
   * The browser's own recogniser. Free, no key, and the only transcriber
   * within reach of a deployment that has not been given one.
   *
   * Used when the backend says it cannot transcribe. Every failure path here
   * falls through to recording the audio instead, so a browser that refuses
   * this (Brave) or accepts it and returns nothing (plain Chromium) still ends
   * up somewhere that can explain itself.
   */
  const startWebSpeech = useCallback(() => {
    heardAnythingRef.current = false;
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
    };
    const Recognition = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!Recognition) {
      void startAudioCapture();
      return;
    }

    const recognition = new Recognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = true;

    recognition.onresult = (event) => {
      let finalText = '';
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript ?? '';
        if (result.isFinal) finalText += text;
        else pending += text;
      }
      if (finalText || pending) heardAnythingRef.current = true;
      if (finalText) setTranscript((prev) => `${prev} ${finalText}`.trim());
      setInterim(pending);
    };

    recognition.onerror = (e) => {
      if (e.error === 'not-allowed') {
        setError('Microphone access was blocked. Allow it in your browser, or type the request instead.');
        setStage('idle');
        return;
      }
      // Brave, and Chromium builds without Google's speech backend, reject the
      // Web Speech API outright with a network error. Record the audio and let
      // the runner transcribe it instead of dead-ending the user.
      recognition.stop();
      recognitionRef.current = null;
      void startAudioCapture();
    };

    recognition.onend = () => {
      setInterim('');
      /* Plain Chromium builds accept the API and then return nothing at all —
         no error, no results, just a quiet end. Left alone that reads as "it
         didn't hear me", which sends people to check their microphone. Ending
         with nothing heard is treated as this recogniser not working, and the
         audio path takes over. */
      if (!heardAnythingRef.current) {
        recognitionRef.current = null;
        void startAudioCapture();
        return;
      }
      setStage((s) => (s === 'listening' ? 'idle' : s));
    };

    recognitionRef.current = recognition;
    recognition.start();
    setStage('listening');
  }, []);

  /**
   * Records raw audio and has the runner transcribe it.
   * The fallback for every browser where Web Speech isn't available.
   */
  const startAudioCapture = useCallback(async () => {
    try {
      // WAV, not WebM: the runner transcribes raw PCM without needing a media
      // decoder, and the level meter comes from the same capture.
      const session = await startMic();
      micRef.current = session;
      setMode('audio');
      setStage('listening');
      setError(null);

      const tick = () => {
        if (!micRef.current) return;
        setLevel(micRef.current.level());
        setSeconds(micRef.current.duration());
        meterRef.current = requestAnimationFrame(tick);
      };
      meterRef.current = requestAnimationFrame(tick);
    } catch (e) {
      const message = (e as Error).message || '';
      setError(
        /denied|not allowed|permission/i.test(message)
          ? 'Microphone access was blocked. Allow it for this site, then tap the mic again.'
          : `Could not open the microphone (${message}). You can type the request instead.`,
      );
      setSupported(false);
      setStage('idle');
    }
  }, []);

  /** Finish an audio capture: encode, upload, transcribe, then plan. */
  const finishAudioCapture = useCallback(async () => {
    const session = micRef.current;
    if (!session) return;
    micRef.current = null;
    if (meterRef.current) cancelAnimationFrame(meterRef.current);
    setLevel(0);

    const heardPeak = session.peak();
    const seconds = session.duration();
    const blob = await session.stop();

    if (seconds < 0.4 || blob.size < 4096) {
      setError('That was too short to hear — hold on a moment longer while you speak.');
      setStage('idle');
      return;
    }

    // Sending silence to a transcriber only produces a confusing "I didn't
    // catch that". Say what actually went wrong.
    if (heardPeak < 0.01) {
      setError(
        'The microphone recorded silence. Check that the right input device is selected and not muted, then try again.',
      );
      setStage('idle');
      return;
    }

    setStage('transcribing');
    try {
      const { transcript: heard } = await api.transcribe(blob);
      if (!heard) throw new Error('Nothing could be made out of that recording.');
      setTranscript(heard);
      await buildPlanRef.current?.(heard);
    } catch (e) {
      setError((e as Error).message);
      setStage('idle');
    }
  }, []);

  /**
   * Transcribe on the backend when it can, in the browser when it cannot.
   *
   * Recording and sending the audio is the better path and stays the default:
   * the runner's Whisper is offline, private, and behaves the same in every
   * browser. The Web Speech API is three behaviours in three browsers — Brave
   * rejects it outright, plain Chromium accepts it and silently returns
   * nothing, and Chrome ships the audio to Google.
   *
   * But "unreliable in some browsers" beats "impossible", and on a deployment
   * with no transcriber configured that is the choice. A serverless function
   * cannot hold a Whisper model between requests, so without a hosted API key
   * the only transcriber within reach is the one already in the browser. It is
   * tried first there, and falls through to recording if it fails — which
   * produces the honest "no transcriber" message rather than silence.
   */
  const startListening = useCallback(() => {
    setError(null);
    setPlan(null);
    setRun(null);
    setEvents([]);
    setTranscript('');
    setInterim('');

    if (sttReady === false) startWebSpeech();
    else void startAudioCapture();
  }, [sttReady, startWebSpeech, startAudioCapture]);

  const stopListening = useCallback(() => {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    if (micRef.current) {
      micRef.current.cancel();
      micRef.current = null;
    }
    if (meterRef.current) cancelAnimationFrame(meterRef.current);
    setLevel(0);
  }, []);

  /* ── planning ───────────────────────────────────────────────────────── */

  const buildPlan = useCallback(
    async (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      stopListening();
      setStage('thinking');
      setError(null);

      try {
        const next = await api.voicePlan<VoicePlan>(clean, user?.id);
        setPlan(next);

        // Seed the editable values with the automation's own defaults, then
        // let whatever was actually spoken win.
        const seeded: Record<string, unknown> = {};
        for (const f of next.automation?.schema.fields ?? []) {
          if (f.exposure !== 'constant' && f.defaultValue != null) seeded[f.key] = f.defaultValue;
        }
        setValues({ ...seeded, ...next.values });
        setStage('ready');
      } catch (e) {
        /* A network-level failure has no useful message of its own — "Failed to
           fetch" tells the reader nothing about which of two very different
           things went wrong. */
        const err = e as Error;
        setError(err.name === 'TypeError' ? runnerUnreachable() : err.message);
        setStage('idle');
      }
    },
    [stopListening, user?.id],
  );

  buildPlanRef.current = buildPlan;

  /* ── running ────────────────────────────────────────────────────────── */

  const run_ = useCallback(async () => {
    if (!plan?.automationId) return;
    setStage('running');
    setStatus('running');
    setEvents([]);
    setRun(null);
    streamRef.current?.close();

    try {
      // The spoken request travels with the run so the results can be answered,
      // not just listed — "which is the best value" needs a sentence back.
      const started = await api.startRun(
        plan.automationId,
        { ...values, __request: transcript },
        { userId: user?.id },
      );
      const runId = started.runId;

      /* Already finished — a serverless run has no socket to follow. */
      if (started.run) {
        setEvents(started.run.events ?? []);
        setRun(started.run);
        setStatus(started.run.status);
        setStage('done');
        return;
      }

      streamRef.current = streamRun(runId, {
        onEvent: (event) => {
          setEvents((prev) => [...prev, event]);
          if (event.phase === 'error') setStatus('failed');
        },
        onEnd: async (finished) => {
          const final = finished ?? (await api.getRun(runId));
          setRun(final);
          setStatus(final.status);
          setStage('done');
        },
        onError: (message) => setError(message),
      });
    } catch (e) {
      setError((e as Error).message);
      setStage('ready');
    }
  }, [plan, values]);

  const listening = stage === 'listening';
  /** Anything the user shouldn't interrupt by tapping the mic again. */
  const busy = stage === 'transcribing' || stage === 'thinking' || stage === 'running';
  /**
   * While listening, show the confirmed text plus whatever is still being
   * heard. Otherwise show exactly what is typed — trimming a controlled
   * textarea on every render eats the space bar, because the trailing space
   * you just typed is removed before it can be rendered back.
   */
  const shown = listening ? `${transcript}${interim ? ` ${interim}` : ''}`.trimStart() : transcript;

  return (
    <div className="mx-auto max-w-4xl px-5 py-12">
      <header className="text-center">
        <SectionLabel>Voice</SectionLabel>
        <h1 className="mt-3 font-display text-[clamp(2.25rem,5vw,3.25rem)] leading-[1.05] text-ink-900">
          Just say what you need.
        </h1>
        <p className="mx-auto mt-4 max-w-lg text-[15px] leading-relaxed text-ink-500">
          Ask for anything on any site — &ldquo;find a room near the river for next
          weekend&rdquo;, &ldquo;check the status of permit 4821&rdquo;, &ldquo;send the weekly
          note to the team&rdquo;. Mimic builds the automation for what you asked, reusing one of
          yours only when it does exactly the same job, and shows you the plan before it runs.
        </p>
      </header>

      {/* ── mic ──────────────────────────────────────────────────────── */}
      <div className="mt-12 flex flex-col items-center">
        <button
          type="button"
          onClick={
            listening
              ? () => (mode === 'audio' ? void finishAudioCapture() : buildPlan(transcript))
              : startListening
          }
          disabled={busy}
          className={cn(
            'relative flex size-24 items-center justify-center rounded-full transition-colors disabled:opacity-60',
            listening ? 'bg-ember-500 text-white' : 'bg-white text-ink-700 ring-1 ring-sand-300 hover:ring-sand-400',
          )}
          aria-label={listening ? 'Stop and use what I said' : 'Start listening'}
        >
          {listening && (
            <>
              {/* The halo tracks the actual input level, so you can see it
                  hearing you rather than guessing whether the mic is live. */}
              <span
                className="absolute inset-0 rounded-full bg-ember-400/50 transition-transform duration-75"
                style={{ transform: `scale(${1 + level * 0.5})` }}
              />
              <motion.span
                className="absolute inset-0 rounded-full border-2 border-ember-300"
                animate={{ scale: [1, 1.3], opacity: [0.5, 0] }}
                transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
              />
            </>
          )}
          {busy && !listening && (
            <span className="absolute inset-0 animate-spin rounded-full border-2 border-sand-200 border-t-ember-500" />
          )}
          <MicIcon active={listening} />
        </button>

        <p className="mt-4 h-5 text-[13px] text-ink-400">
          {listening && mode === 'audio'
            ? `Recording ${seconds.toFixed(1)}s — tap again when you’re done`
            : !listening && !supported && stage === 'idle'
              ? 'Speech isn’t available here — type below'
              : STAGE_HINT[stage]}
        </p>
      </div>

      {/* ── transcript ───────────────────────────────────────────────── */}
      <div className="mt-8">
        <div className="relative">
          <textarea
            rows={3}
            value={shown}
            onChange={(e) => {
              setTranscript(e.target.value);
              setInterim('');
            }}
            placeholder="…or type what you want done"
            className="w-full resize-none rounded-[18px] border border-sand-300 bg-white/80 px-4 py-3.5 text-[15px] leading-relaxed text-ink-900 placeholder:text-ink-400 focus:border-ember-400 focus:outline-none focus:ring-4 focus:ring-ember-500/12"
          />
          {interim && (
            <span className="pointer-events-none absolute bottom-3 right-4 text-[11px] text-ink-400">
              hearing…
            </span>
          )}
        </div>

        <div className="mt-3 flex justify-end">
          <Button
            onClick={() => buildPlan(shown)}
            disabled={!shown.trim() || stage === 'thinking' || stage === 'running'}
            loading={stage === 'thinking'}
          >
            Work out the plan
          </Button>
        </div>
      </div>

      {error && (
        <p className="mt-4 rounded-xl border border-red-200 bg-rust-100/50 px-4 py-3 text-[13.5px] text-rust-500">
          {error}
        </p>
      )}

      {/* Two different backends can be answering, and they run out of ways to
          transcribe for different reasons — one has a local model switched
          off, the other cannot have one at all. Naming the wrong fix is worse
          than naming none, so this says which. */}
      {sttReady === false && !error && (
        <div className="mt-4 rounded-xl border border-sand-300 bg-white/60 px-4 py-3 text-[13px] leading-relaxed text-ink-500">
          <span className="font-medium text-ink-800">Typing works right now.</span>{' '}
          {onOwnMachine ? (
            <>
              Speech transcription is switched off on the runner (
              <code className="rounded bg-sand-100 px-1 font-mono text-[12px]">STT_LOCAL=0</code>).
              Remove that to use the built-in model, or set{' '}
              <code className="rounded bg-sand-100 px-1 font-mono text-[12px]">STT_API_KEY</code> to
              use a hosted one.
            </>
          ) : (
            <>
              Speech here uses your browser&rsquo;s own recogniser, which works in Chrome and Edge
              and is refused by Brave. This site has no transcriber of its own — the offline model
              needs a machine that keeps it between requests, which a serverless function cannot —
              so set{' '}
              <code className="rounded bg-sand-100 px-1 font-mono text-[12px]">STT_API_KEY</code>{' '}
              for one that works everywhere.
            </>
          )}
        </div>
      )}

      {/* ── plan ─────────────────────────────────────────────────────── */}
      <AnimatePresence>
        {plan && (
          <motion.section
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1] }}
            className="mt-10"
          >
            {plan.automation ? (
              <div className="rounded-[18px] border border-sand-200 bg-white/75 p-6">
                <div className="flex items-start gap-4">
                  <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-sand-200 bg-white text-xl">
                    {plan.automation.emoji}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-display text-xl leading-snug text-ink-900">{plan.say}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {plan.created && <Badge tone="ember">newly built</Badge>}
                      <Badge tone="outline">{plan.automation.name}</Badge>
                      <Badge tone="outline">{plan.automation.site}</Badge>
                      <Badge tone={plan.confidence > 0.75 ? 'moss' : 'ember'}>
                        {Math.round(plan.confidence * 100)}% sure
                      </Badge>
                    </div>
                    {plan.created && (
                      <p className="mt-2 text-[12.5px] leading-relaxed text-ink-500">
                        Built for this request — Mimic opened the site and worked out how to do it.
                        Check the values below before running: a first attempt gets more wrong than
                        a task somebody has already demonstrated.
                      </p>
                    )}
                  </div>
                </div>

                {/* Editable, because speech misheard is speech misheard. */}
                <div className="mt-5 grid gap-3 sm:grid-cols-2">
                  {plan.automation.schema.fields
                    .filter((f) => f.exposure !== 'constant')
                    .map((f) => (
                      <label key={f.key} className="flex flex-col gap-1.5">
                        <span className="flex items-baseline gap-2 text-[12.5px] font-medium text-ink-700">
                          {f.label}
                          {plan.values[f.key] !== undefined && <Badge tone="ember">heard</Badge>}
                        </span>
                        <input
                          className="w-full rounded-xl border border-sand-300 bg-white px-3 py-2 text-[14px] text-ink-900 focus:border-ember-400 focus:outline-none focus:ring-4 focus:ring-ember-500/12"
                          value={String(values[f.key] ?? '')}
                          onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                        />
                      </label>
                    ))}
                </div>

                {plan.missing.length > 0 && (
                  <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3.5 py-2.5 text-[13px] text-amber-800">
                    You didn&rsquo;t mention: {plan.missing.join(', ')}. Fill those in above before
                    running.
                  </p>
                )}

                <div className="mt-6 flex items-center gap-3">
                  <Button size="lg" onClick={run_} loading={stage === 'running'}>
                    {stage === 'running' ? 'Running…' : 'Run it'}
                  </Button>
                  <a
                    href={`/automations/${plan.automation.id}`}
                    className="text-[13px] text-ink-500 underline underline-offset-4 hover:text-ink-900"
                  >
                    Open the full form
                  </a>
                </div>
              </div>
            ) : (
              <div className="rounded-[18px] border border-amber-200 bg-amber-50/60 p-6">
                <p className="font-display text-xl text-ink-900">{plan.say}</p>
                {plan.suggestion && (
                  <p className="mt-2 text-[14px] leading-relaxed text-ink-600">{plan.suggestion}</p>
                )}
              </div>
            )}
          </motion.section>
        )}
      </AnimatePresence>

      {/* ── run ──────────────────────────────────────────────────────── */}
      {(stage === 'running' || run) && (
        <section className="mt-8 space-y-6">
          <RunConsole events={events} status={status} progress={progress} />
          {run && <OutputView run={run} />}
          {run && plan?.automationId && (
            <RunApiPanel run={run} automationId={plan.automationId} input={values} />
          )}
        </section>
      )}

      {stage === 'thinking' && !plan && (
        <div className="mt-8 flex items-center justify-center gap-2 text-[13px] text-ink-400">
          {/* Not "matching what you've recorded". Nothing needs to have been
              recorded: if no saved automation does exactly this, one gets
              built for the request, which is the normal path rather than the
              consolation prize. Saying otherwise made the product sound like a
              library of past recordings. */}
          <Spinner /> Working out how to do this — reusing a recording only if one fits exactly…
        </div>
      )}
    </div>
  );
}

function MicIcon({ active }: { active: boolean }) {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" className="relative" aria-hidden>
      <rect
        x="9"
        y="3"
        width="6"
        height="11"
        rx="3"
        fill={active ? 'currentColor' : 'none'}
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M5 11a7 7 0 0014 0M12 18v3"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

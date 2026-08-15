import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

/* Env lives at the repo root so the web app and the runner share one file.
   Looked for relative to the workspace *and* to wherever this was started
   from, because a script run from the repo root otherwise finds nothing and
   fails with "DEEPSEEK_API_KEY is not set" on a machine where it is set. */
const roots = [path.resolve(process.cwd(), '../..'), process.cwd()];
for (const root of roots) {
  for (const file of ['.env.local', '.env']) {
    const p = path.join(root, file);
    if (existsSync(p)) loadEnv({ path: p });
  }
}
loadEnv();

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);

const int = (v: string | undefined, fallback: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  port: int(process.env.RUNNER_PORT, 8787),
  ingestToken: process.env.MIMIC_INGEST_TOKEN || 'dev-local-token-change-me',

  /**
   * Whether the free plan's daily run limit actually refuses a run.
   *
   * Off by default. Usage is counted either way, so the dashboard shows real
   * numbers — but a cap that bites during development stops every test session
   * three runs in, for reasons that have nothing to do with what is being
   * tested. Set MIMIC_ENFORCE_QUOTA=1 to switch it on.
   */
  enforceQuota: bool(process.env.MIMIC_ENFORCE_QUOTA, false),

  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY || '',
    baseUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, ''),
    model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
    get enabled() {
      return Boolean(process.env.DEEPSEEK_API_KEY);
    },
  },

  /**
   * Speech-to-text. The browser's own Web Speech API is the first choice, but
   * Brave (and Chromium builds without Google's speech backend) refuse it with
   * a network error — so audio is uploaded here instead. Any OpenAI-compatible
   * `/audio/transcriptions` endpoint works: OpenAI, Groq, a local whisper.cpp
   * server, anything.
   */
  stt: {
    apiKey: process.env.STT_API_KEY || '',
    baseUrl: (process.env.STT_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
    model: process.env.STT_MODEL || 'whisper-1',
    /** True when a hosted provider is configured. */
    get enabled() {
      return Boolean(process.env.STT_API_KEY);
    },

    /**
     * With no provider configured, Whisper runs locally instead. The model is
     * downloaded once and cached, so voice works out of the box with no key.
     * Set STT_LOCAL=0 to turn that off.
     */
    // base.en over tiny.en: noticeably better on real microphones and accents,
    // still around a second for a short request.
    /* `small.en` rather than `base.en`.
     *
     * Base is the weakest model that works at all, and it fails precisely where
     * this product needs accuracy: proper nouns and spelled-out letters. It
     * turned "F-M-O-V-I-E-S" into "fmovidedoubleis" and "gozayaan" into
     * "gozion". Small is a larger one-off download (~250MB, cached) and a
     * couple of seconds slower, which is a good trade against a request that
     * goes to the wrong site. Override with STT_LOCAL_MODEL. */
    localModel: process.env.STT_LOCAL_MODEL || 'onnx-community/whisper-small.en',
    get localEnabled() {
      return !bool(process.env.STT_LOCAL, true) ? false : true;
    },
    /** Whether speech can be transcribed at all, by any route. */
    get available() {
      return this.enabled || this.localEnabled;
    },
  },

  browser: {
    headless: bool(process.env.RUNNER_HEADLESS, true),
    // 15s is long enough for a real page and short enough that a step which is
    // never going to succeed fails while the user is still watching.
    stepTimeoutMs: int(process.env.RUNNER_STEP_TIMEOUT_MS, 15_000),
    maxConcurrency: int(process.env.RUNNER_MAX_CONCURRENCY, 3),
    /** Slows actions slightly so sites that watch input cadence stay happy. */
    humanDelayMs: int(process.env.RUNNER_HUMAN_DELAY_MS, 120),
  },

  storageDir: path.resolve(process.cwd(), process.env.RUNNER_STORAGE_DIR || './.mimic'),

  /** Origins allowed to talk to the runner (web app + the extension). */
  corsOrigins: (process.env.RUNNER_CORS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

export type Config = typeof config;

import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

/* Env lives at the repo root so the web app and the runner share one file.
   Looked for relative to the workspace *and* to wherever this was started
   from, because a script run from the repo root otherwise finds nothing and
   fails with "DEEPSEEK_API_KEY is not set" on a machine where it is set.

   Skipped entirely when there is no `.env` file to find, which is every
   serverless deployment — the platform injects the environment directly.
   That matters for more than tidiness: a bundler cannot follow a path built
   at run time, so it gives up and includes the whole project source in every
   function rather than risk missing a file. With a 67MB browser alongside,
   that is the difference between a deployment and a size-limit failure.
   `turbopackIgnore` tells it these reads are ours to worry about. */
if (!process.env.VERCEL && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  const roots = [path.resolve(/*turbopackIgnore: true*/ process.cwd(), '../..'), process.cwd()];
  for (const root of roots) {
    for (const file of ['.env.local', '.env']) {
      const p = path.join(/*turbopackIgnore: true*/ root, file);
      if (existsSync(/*turbopackIgnore: true*/ p)) loadEnv({ path: p });
    }
  }
  loadEnv();
}

const bool = (v: string | undefined, fallback: boolean) =>
  v === undefined ? fallback : /^(1|true|yes|on)$/i.test(v);

const int = (v: string | undefined, fallback: number) => {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  /* PORT is what every host assigns — Railway, Render, Fly, Heroku all inject
     it and route to nothing else. RUNNER_PORT stays as the local override. */
  port: int(process.env.RUNNER_PORT ?? process.env.PORT, 8787),
  /* Container hosts route to the container's address, not to loopback. Binding
     127.0.0.1 there produces a service that starts cleanly, passes its own
     health check from inside, and is unreachable from the internet. */
  host: process.env.RUNNER_HOST || '0.0.0.0',
  ingestToken: process.env.MIMIC_INGEST_TOKEN || 'dev-local-token-change-me',

  /**
   * Whether the free plan's daily run limit actually refuses a run.
   *
   * On by default now that the product is being used rather than built. Usage
   * is counted either way, so the dashboard was already showing real numbers
   * before the cap started biting. Set MIMIC_ENFORCE_QUOTA=0 to turn it off
   * for a testing session.
   */
  enforceQuota: bool(process.env.MIMIC_ENFORCE_QUOTA, true),

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

  /* Only the file store reads this, and only the runner has one. The bundler
     is told to leave it alone for the same reason as the `.env` lookup above:
     an unfollowable path makes it trace the entire project into every
     function. */
  storageDir: path.resolve(/*turbopackIgnore: true*/ process.cwd(), process.env.RUNNER_STORAGE_DIR || './.mimic'),

  /** Origins allowed to talk to the runner (web app + the extension). */
  corsOrigins: (process.env.RUNNER_CORS || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

/**
 * Is this origin allowed to talk to the runner?
 *
 * Entries may use `*` as a wildcard for one label — `https://*.vercel.app`.
 * Every Vercel preview deployment gets its own generated hostname, so a fixed
 * list either misses them all or gets widened to everything; a wildcard that
 * cannot cross a dot is the honest middle.
 */
export function originAllowed(origin: string): boolean {
  return config.corsOrigins.some((pattern) => {
    if (pattern === origin) return true;
    if (!pattern.includes('*')) return false;

    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^./]+');
    return new RegExp(`^${escaped}$`).test(origin);
  });
}

export type Config = typeof config;

import 'server-only';

/**
 * The runner's own code, running inside this site's server.
 *
 * Recording, running and voice all need a real browser, and a Next route can
 * have one: `@sparticuz/chromium` is a Chromium build compiled for exactly
 * this, and the replay engine does not care which binary it drives. So rather
 * than a second implementation, the same engine runs here.
 *
 * Isolated behind this one module deliberately. It pulls in Playwright and a
 * 50MB browser, so anything importing it is committing that route to a heavy
 * cold start — and `server-only` makes an accidental import from a component a
 * build error rather than a mystery.
 */

export {
  authorAutomation,
  compileTrace,
  config as runnerConfig,
  normalizeTrace,
  planFromTranscript,
  repairHostnames,
  resolveSpelling,
  runAutomation,
  saveAutomation,
  sitesNamedIn,
  transcribeAudio,
} from '@mimic/runner/serverless';

/**
 * How long a run may take here.
 *
 * Vercel stops a function at 60 seconds on Hobby and 300 on Pro, and stopping
 * mid-scrape returns nothing at all — the worst possible outcome, because it
 * looks identical to a site that had no results. So the engine is given a
 * budget a little under the platform's and told to come back with whatever it
 * has, which is a partial answer clearly labelled as one.
 */
export const runBudgetMs = Number(process.env.MIMIC_RUN_BUDGET_MS ?? 55_000);

/** Long-form work is refused rather than started and killed. */
export const OVER_BUDGET =
  'This site runs automations inside a serverless function, which is stopped after about a minute. This one needs longer. Deploy the runner (see DEPLOYING.md) and it will run to completion with no limit.';

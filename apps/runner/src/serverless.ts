/**
 * The runner's work, without the runner.
 *
 * Everything in `apps/runner` except `index.ts` is ordinary code — it drives a
 * browser and talks to DeepSeek, and neither of those needs an Express server
 * to be running. `index.ts` is a server: it listens on a port, holds a
 * websocket, keeps a queue. That is the only part a serverless function cannot
 * be.
 *
 * So this file is the seam. It names exactly what the deployed site is allowed
 * to reach into, which keeps the boundary explicit rather than letting the web
 * app import arbitrary internals and discover the limits at build time.
 *
 * Imported only from server code. It pulls in Playwright.
 */

export { runAutomation } from './replay/engine';
export { compileTrace } from './compile/index';
export { normalizeTrace } from './replay/normalize';
export { authorAutomation, type AuthorResult } from './authoring';
export {
  planFromTranscript,
  repairHostnames,
  resolveSpelling,
  sameHost,
  sitesNamedIn,
  transcribeAudio,
} from './voice';
export { config } from './config';
export {
  deleteAutomation,
  getAutomation,
  getRun,
  listAutomations,
  listRuns,
  saveAutomation,
  saveRun,
  store,
  storeBackend,
} from './store';
export { checkQuota, recordRun } from './quota';

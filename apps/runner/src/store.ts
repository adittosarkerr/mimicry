import {
  createLibrary,
  supabaseStoreFromEnv,
  type Collection as CoreCollection,
  type Store,
} from '@mimic/core';
import { config } from './config';
import type { Automation, Run } from '@mimic/schema';
import type { FileStore } from './store-file';

/**
 * Where records live.
 *
 * Two backends behind one set of functions. Files are the default and are the
 * right thing on a laptop: no server to run, and you can read a record in a
 * text editor. They are the wrong thing everywhere else — a read-only
 * filesystem has nowhere to put them, and a container that redeploys without a
 * volume forgets everything.
 *
 * So when Supabase credentials are present, the same functions read and write
 * Postgres, and the deployed site and the runner see the same data. Nothing
 * above this file knows which one it got.
 */

export type Collection = 'profiles' | 'listings' | 'subscriptions' | 'methods' | 'invoices' | 'usage';

const postgres = supabaseStoreFromEnv(process.env);

/**
 * The file store, loaded on first use and never otherwise.
 *
 * `import()` rather than a top-level import because every path in that module
 * is built at run time from a configured directory. A bundler cannot follow
 * those, so rather than risk missing a file it includes the whole project
 * source in any function that can reach the code — which, alongside a 67MB
 * browser, is the difference between a deployment and a size-limit failure.
 * Deferred like this, a serverless build never reaches it.
 */
let loading: Promise<FileStore> | null = null;
const files = (): Promise<FileStore> =>
  (loading ??= import('./store-file').then((m) => m.createFileStore(config.storageDir)));

/* Chosen once, at startup, rather than per call — a store that changed its
   mind halfway through a run would write half a subscription to each. */
export const store: Store = postgres ?? {
  get: async (c, id) => (await files()).get(c, id),
  put: async (c, r) => (await files()).put(c, r),
  list: async (c, w) => (await files()).list(c, w),
  remove: async (c, id) => (await files()).remove(c, id),
};

/** True when records are going to Postgres — reported by /health. */
export const storeBackend: 'supabase' | 'files' = postgres ? 'supabase' : 'files';

const library = createLibrary(store);

// ── automations and runs ───────────────────────────────────────────────────
export const saveAutomation = (a: Automation) => library.saveAutomation(a);
export const getAutomation = (id: string) => library.getAutomation(id);
export const deleteAutomation = (id: string) => library.deleteAutomation(id);
export const listAutomations = (ownerId?: string) => library.listAutomations(ownerId);
export const saveRun = (run: Run) => library.saveRun(run);
export const getRun = (id: string) => library.getRun(id);
export const listRuns = (automationId?: string, limit = 50) => library.listRuns(automationId, limit);

// ── generic collections ────────────────────────────────────────────────────
export const put = <T extends { id?: string }>(collection: Collection, record: T) =>
  store.put(collection as CoreCollection, record);
export const get = <T>(collection: Collection, id: string) =>
  store.get<T>(collection as CoreCollection, id);
export const list = <T>(collection: Collection, where?: (record: T) => boolean) =>
  store.list<T>(collection as CoreCollection, where);
export const remove = (collection: Collection, id: string) =>
  store.remove(collection as CoreCollection, id);

/* ── screenshots ────────────────────────────────────────────────────────────
   On disk in both modes. They are large, they are only ever fetched by the run
   that produced them, and putting a few hundred kilobytes of base64 into every
   row would make the records table expensive for a picture nobody looks at
   twice. On a host with no volume they simply do not survive a restart, which
   is the right trade for what they are. */

export const saveScreenshot = async (key: string, buf: Buffer): Promise<string> =>
  (await files()).saveScreenshot(key, buf);

export const readScreenshot = async (key: string): Promise<Buffer | null> =>
  (await files()).readScreenshot(key);

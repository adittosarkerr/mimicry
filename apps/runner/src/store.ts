import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  createLibrary,
  supabaseStoreFromEnv,
  type Collection as CoreCollection,
  type Store,
} from '@mimic/core';
import { config } from './config.js';
import type { Automation, Run } from '@mimic/schema';

/**
 * Where records live.
 *
 * Two backends behind one set of functions. The file-backed one is the
 * default and is deliberately boring: one file per record, atomic writes via
 * rename, no server to run. It is the right thing on a laptop and the wrong
 * thing everywhere else — Vercel's filesystem is read-only, and a container
 * that redeploys without a volume forgets everything.
 *
 * So when Supabase credentials are present, the same functions read and write
 * Postgres instead, and the deployed site and the runner see the same data.
 * Nothing above this file knows which one it got.
 */

const dirs = {
  automations: path.join(config.storageDir, 'automations'),
  runs: path.join(config.storageDir, 'runs'),
  screenshots: path.join(config.storageDir, 'screenshots'),
  // Accounts, marketplace and the payment sandbox.
  profiles: path.join(config.storageDir, 'profiles'),
  listings: path.join(config.storageDir, 'listings'),
  subscriptions: path.join(config.storageDir, 'subscriptions'),
  methods: path.join(config.storageDir, 'methods'),
  invoices: path.join(config.storageDir, 'invoices'),
  usage: path.join(config.storageDir, 'usage'),
};

export type Collection = 'profiles' | 'listings' | 'subscriptions' | 'methods' | 'invoices' | 'usage';

let ready: Promise<void> | null = null;

async function init() {
  if (!ready) {
    ready = (async () => {
      await Promise.all(Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })));
    })();
  }
  return ready;
}

async function writeJson(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

const safeId = (id: string) => /^[\w-]+$/.test(id);

/** The folder-per-collection store. */
const fileStore: Store = {
  async get<T>(collection: CoreCollection, id: string): Promise<T | null> {
    await init();
    if (!safeId(id)) return null;
    return readJson<T>(path.join(dirs[collection], `${id}.json`));
  },

  async put<T extends { id?: string }>(collection: CoreCollection, record: T): Promise<T> {
    await init();
    const id = record.id;
    /* `id?` rather than `id`, deliberately: how strictly `z.infer` reports a
       required field depends on how the schema package resolves, which differs
       between the workspace and a bare install of one app. This runtime guard
       is the real check and always was. */
    if (!id || !safeId(id)) throw new Error(`Unsafe id for ${collection}: ${String(id)}`);
    await writeJson(path.join(dirs[collection], `${id}.json`), record);
    return record;
  },

  async list<T>(collection: CoreCollection, where?: (record: T) => boolean): Promise<T[]> {
    await init();
    const files = await fs.readdir(dirs[collection]).catch(() => [] as string[]);
    const all: (T | null)[] = await Promise.all(
      files
        .filter((f) => f.endsWith('.json'))
        .map((f) => readJson<T>(path.join(dirs[collection], f))),
    );
    const present = all.filter((r): r is T => r !== null);
    return where ? present.filter(where) : present;
  },

  async remove(collection: CoreCollection, id: string): Promise<boolean> {
    await init();
    if (!safeId(id)) return false;
    try {
      await fs.unlink(path.join(dirs[collection], `${id}.json`));
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Postgres when it is configured, files otherwise.
 *
 * Chosen once, at startup, rather than per call — a store that changes its mind
 * halfway through a run would write half a subscription to each.
 */
export const store: Store = supabaseStoreFromEnv(process.env) ?? fileStore;

/** True when records are going to Postgres — reported by /health. */
export const storeBackend: 'supabase' | 'files' = store === fileStore ? 'files' : 'supabase';

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
  store.put(collection, record);
export const get = <T>(collection: Collection, id: string) => store.get<T>(collection, id);
export const list = <T>(collection: Collection, where?: (record: T) => boolean) =>
  store.list<T>(collection, where);
export const remove = (collection: Collection, id: string) => store.remove(collection, id);

/* ── screenshots ────────────────────────────────────────────────────────────
   Left on disk in both modes. They are large, they are only ever fetched by
   the run that produced them, and putting a few hundred kilobytes of base64
   into every row would make the records table expensive for a picture nobody
   looks at twice. On a host with no volume they simply do not survive a
   restart, which is the right trade for what they are. */

export async function saveScreenshot(key: string, buf: Buffer): Promise<string> {
  await init();
  await fs.writeFile(path.join(dirs.screenshots, `${key}.png`), buf);
  return key;
}

export async function readScreenshot(key: string): Promise<Buffer | null> {
  await init();
  // Keys come from URLs — refuse anything that could climb out of the folder.
  if (!/^[\w-]+$/.test(key)) return null;
  try {
    return await fs.readFile(path.join(dirs.screenshots, `${key}.png`));
  } catch {
    return null;
  }
}

export const storeDirs = dirs;

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import type { Automation, Run } from '@mimic/schema';

/**
 * File-backed JSON store. Deliberately boring: one file per record, an index
 * kept in memory, atomic writes via rename. Swapping this for Postgres later
 * means reimplementing this module's exports, nothing else.
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

// ── automations ────────────────────────────────────────────────────────────
export async function saveAutomation(a: Automation): Promise<Automation> {
  await init();
  await writeJson(path.join(dirs.automations, `${a.id}.json`), a);
  return a;
}

export async function getAutomation(id: string): Promise<Automation | null> {
  await init();
  return readJson<Automation>(path.join(dirs.automations, `${id}.json`));
}

export async function listAutomations(ownerId?: string): Promise<Automation[]> {
  await init();
  const files = await fs.readdir(dirs.automations).catch(() => [] as string[]);
  const all = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<Automation>(path.join(dirs.automations, f))),
  );
  return all
    .filter((a): a is Automation => !!a)
    .filter((a) => !ownerId || a.ownerId === ownerId || a.visibility === 'public')
    .sort((x, y) => y.updatedAt - x.updatedAt);
}

export async function deleteAutomation(id: string): Promise<boolean> {
  await init();
  try {
    await fs.unlink(path.join(dirs.automations, `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

// ── runs ───────────────────────────────────────────────────────────────────
export async function saveRun(run: Run): Promise<Run> {
  await init();
  await writeJson(path.join(dirs.runs, `${run.id}.json`), run);
  return run;
}

export async function getRun(id: string): Promise<Run | null> {
  await init();
  return readJson<Run>(path.join(dirs.runs, `${id}.json`));
}

export async function listRuns(automationId?: string, limit = 50): Promise<Run[]> {
  await init();
  const files = await fs.readdir(dirs.runs).catch(() => [] as string[]);
  const all = await Promise.all(
    files.filter((f) => f.endsWith('.json')).map((f) => readJson<Run>(path.join(dirs.runs, f))),
  );
  return all
    .filter((r): r is Run => !!r)
    .filter((r) => !automationId || r.automationId === automationId)
    .sort((x, y) => y.startedAt - x.startedAt)
    .slice(0, limit);
}

// ── screenshots ────────────────────────────────────────────────────────────
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

/* ── generic collections ────────────────────────────────────────────────────
   Accounts, listings, subscriptions, payment methods and invoices are all the
   same shape of problem: a folder of JSON records with an id. One set of
   helpers rather than five copies of the three above. */

const safeId = (id: string) => /^[\w-]+$/.test(id);

export async function put<T extends { id: string }>(collection: Collection, record: T): Promise<T> {
  await init();
  if (!safeId(record.id)) throw new Error(`Unsafe id for ${collection}: ${record.id}`);
  await writeJson(path.join(dirs[collection], `${record.id}.json`), record);
  return record;
}

export async function get<T>(collection: Collection, id: string): Promise<T | null> {
  await init();
  if (!safeId(id)) return null;
  return readJson<T>(path.join(dirs[collection], `${id}.json`));
}

export async function list<T>(collection: Collection, where?: (record: T) => boolean): Promise<T[]> {
  await init();
  const files = await fs.readdir(dirs[collection]).catch(() => [] as string[]);
  const all: (T | null)[] = await Promise.all(
    files
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJson<T>(path.join(dirs[collection], f))),
  );
  const present = all.filter((r): r is T => r !== null);
  return where ? present.filter(where) : present;
}

export async function remove(collection: Collection, id: string): Promise<boolean> {
  await init();
  if (!safeId(id)) return false;
  try {
    await fs.unlink(path.join(dirs[collection], `${id}.json`));
    return true;
  } catch {
    return false;
  }
}

export const storeDirs = dirs;

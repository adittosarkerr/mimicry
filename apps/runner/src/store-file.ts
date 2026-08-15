import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Collection, Store } from '@mimic/core';

/**
 * Records as JSON files. One file per record, an index read from the
 * directory, atomic writes via rename.
 *
 * Deliberately boring, and deliberately in its own module. Every path here is
 * built at run time from a configured directory, which a bundler cannot
 * follow — so rather than guess, it includes the entire project source in any
 * function that can reach this code. Alongside a 67MB browser that is the
 * difference between a deployment and a size-limit failure, and the deployed
 * site has no use for a filesystem store anyway. `store.ts` imports this
 * lazily, so a serverless build never pulls it in at all.
 */

const safeId = (id: string) => /^[\w-]+$/.test(id);

export interface FileStore extends Store {
  saveScreenshot(key: string, buf: Buffer): Promise<string>;
  readScreenshot(key: string): Promise<Buffer | null>;
  dirs: Record<string, string>;
}

export function createFileStore(storageDir: string): FileStore {
  const dirs: Record<Collection | 'screenshots', string> = {
    automations: path.join(storageDir, 'automations'),
    runs: path.join(storageDir, 'runs'),
    screenshots: path.join(storageDir, 'screenshots'),
    // Accounts, marketplace and the payment sandbox.
    profiles: path.join(storageDir, 'profiles'),
    listings: path.join(storageDir, 'listings'),
    subscriptions: path.join(storageDir, 'subscriptions'),
    methods: path.join(storageDir, 'methods'),
    invoices: path.join(storageDir, 'invoices'),
    usage: path.join(storageDir, 'usage'),
  };

  let ready: Promise<void> | null = null;
  const init = () => (ready ??= Promise.all(
    Object.values(dirs).map((d) => fs.mkdir(d, { recursive: true })),
  ).then(() => undefined));

  async function writeJson(file: string, data: unknown) {
    // Written beside the target and renamed, so a crash mid-write cannot leave
    // a half-parsed record where a whole one used to be.
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

  return {
    dirs,

    async get<T>(collection: Collection, id: string): Promise<T | null> {
      await init();
      if (!safeId(id)) return null;
      return readJson<T>(path.join(dirs[collection], `${id}.json`));
    },

    async put<T extends { id?: string }>(collection: Collection, record: T): Promise<T> {
      await init();
      const id = record.id;
      /* `id?` rather than `id`, deliberately: how strictly `z.infer` reports a
         required field depends on how the schema package resolves, which
         differs between the workspace and a bare install of one app. This
         runtime guard is the real check and always was. */
      if (!id || !safeId(id)) throw new Error(`Unsafe id for ${collection}: ${String(id)}`);
      await writeJson(path.join(dirs[collection], `${id}.json`), record);
      return record;
    },

    async list<T>(collection: Collection, where?: (record: T) => boolean): Promise<T[]> {
      await init();
      // See the note at the top: these paths are ours, not the bundler's.
      const files = await fs
        .readdir(/*turbopackIgnore: true*/ dirs[collection])
        .catch(() => [] as string[]);
      const all: (T | null)[] = await Promise.all(
        files
          .filter((f) => f.endsWith('.json'))
          .map((f) => readJson<T>(path.join(dirs[collection], f))),
      );
      const present = all.filter((r): r is T => r !== null);
      return where ? present.filter(where) : present;
    },

    async remove(collection: Collection, id: string): Promise<boolean> {
      await init();
      if (!safeId(id)) return false;
      try {
        await fs.unlink(path.join(dirs[collection], `${id}.json`));
        return true;
      } catch {
        return false;
      }
    },

    async saveScreenshot(key: string, buf: Buffer): Promise<string> {
      await init();
      await fs.writeFile(path.join(dirs.screenshots, `${key}.png`), buf);
      return key;
    },

    async readScreenshot(key: string): Promise<Buffer | null> {
      await init();
      // Keys come from URLs — refuse anything that could climb out of the folder.
      if (!safeId(key)) return null;
      try {
        return await fs.readFile(path.join(dirs.screenshots, `${key}.png`));
      } catch {
        return null;
      }
    },
  };
}

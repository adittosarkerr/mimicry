/**
 * Re-forms saved automations for sites that now have a profile.
 *
 * Their fields were inferred from a URL that welded route and dates into one
 * string, so the form could not drive the run. This swaps in the profile's
 * fields, keeping whatever the recording knew as the defaults.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { profileFor } from '../apps/runner/src/sites/profiles.js';
import { toAirportCode } from '../apps/runner/src/sites/airports.js';
import type { Automation } from '@mimic/schema';

const dir = path.resolve('apps/runner/.mimic/automations');
const dryRun = !process.argv.includes('--write');

/**
 * Puts back the separator the recorder used to lose.
 *
 * `textContent` joined an autocomplete row's two lines with nothing between
 * them — "Cox's Bazar" over "Bangladesh" became "Cox'sBazarBangladesh" — and
 * that string is now the saved default on every automation recorded before the
 * fix. Only applied where the seam is unmistakable and no comma is present.
 */
function unweld(value: unknown): unknown {
  const s = String(value ?? '');
  if (!s || s.includes(',')) return value;
  const fixed = s.replace(/([a-z])([A-Z])/g, '$1, $2');
  return fixed === s ? value : fixed;
}

/** Pulls the recorded trip out of whatever shape the old schema left it in. */
function seedFrom(a: Automation): Record<string, unknown> {
  const byKey = new Map(a.schema.fields.map((f) => [f.key, f.defaultValue]));
  const seed: Record<string, unknown> = {};

  const trips = String(byKey.get('trips') ?? '');
  const legs = trips.split(',').map((s) => s.trim()).filter(Boolean);
  if (legs.length >= 3) {
    seed.origin = legs[0];
    seed.destination = legs[1];
    seed.depart_date = legs[2];
    if (legs.length >= 6) seed.return_date = legs[5];
  }

  // Kayak keeps the route and dates in the path.
  const template = a.schema.urlTemplate ?? '';
  const path_ = template.match(/\/flights\/([A-Z]{3})-([A-Z]{3})\/(\d{4}-\d{2}-\d{2})(?:\/(\d{4}-\d{2}-\d{2}))?/);
  if (path_) {
    seed.origin ??= path_[1];
    seed.destination ??= path_[2];
    seed.depart_date ??= path_[3];
    if (path_[4]) seed.return_date ??= path_[4];
  }

  /* The recording itself, which outlives every reshaping of the schema.
     Without this the script is destructive on a second run: the fields it
     reads were replaced by the first run, so it finds nothing and writes the
     profile's blank defaults over a perfectly good trip. */
  const finalUrl = String((a as unknown as { trace?: { finalUrl?: string } }).trace?.finalUrl ?? '');
  const fromUrl = finalUrl.match(/trips=([A-Z]{3}),([A-Z]{3}),(\d{4}-\d{2}-\d{2})(?:,[A-Z]{3},[A-Z]{3},(\d{4}-\d{2}-\d{2}))?/);
  if (fromUrl) {
    seed.origin ??= fromUrl[1];
    seed.destination ??= fromUrl[2];
    seed.depart_date ??= fromUrl[3];
    if (fromUrl[4]) seed.return_date ??= fromUrl[4];
  }
  const kayakUrl = finalUrl.match(/\/flights\/([A-Z]{3})-([A-Z]{3})\/(\d{4}-\d{2}-\d{2})(?:\/(\d{4}-\d{2}-\d{2}))?/);
  if (kayakUrl) {
    seed.origin ??= kayakUrl[1];
    seed.destination ??= kayakUrl[2];
    seed.depart_date ??= kayakUrl[3];
    if (kayakUrl[4]) seed.return_date ??= kayakUrl[4];
  }

  // Otherwise fall back to whatever the current fields hold.
  seed.depart_date ??= byKey.get('depart_date');
  seed.return_date ??= byKey.get('return_date');
  /* Booking keeps one value per parameter, so its seeds come straight off the
     old field names — including the two destination fields the inferred schema
     produced, of which the plain-text one is the value the site actually used. */
  const ss = finalUrl.match(/[?&]ss=([^&]+)/);
  seed.destination ??= byKey.get('destination') ?? (ss ? decodeURIComponent(ss[1].replace(/\+/g, ' ')) : undefined);
  seed.check_in ??= byKey.get('check_in') ?? (finalUrl.match(/[?&]checkin=(\d{4}-\d{2}-\d{2})/) ?? [])[1];
  seed.check_out ??= byKey.get('check_out') ?? (finalUrl.match(/[?&]checkout=(\d{4}-\d{2}-\d{2})/) ?? [])[1];
  seed.rooms ??= byKey.get('rooms') ?? Number((finalUrl.match(/[?&]no_rooms=(\d+)/) ?? [])[1]);

  /* A product search keeps its term in one parameter, but not under a name
     this script could guess: the compiler names fields after the control's own
     label, so Daraz's search box came out as `search_in_daraz`. The old URL
     template says which field fed `q=`, which is general enough to work for the
     next shop as well as this one. */
  const qKey = template.match(/[?&]q=\{([a-z0-9_]+)\}/i)?.[1];
  const qUrl = finalUrl.match(/[?&]q=([^&]+)/);
  seed.query ??=
    (qKey ? byKey.get(qKey) : undefined) ??
    byKey.get('query') ??
    (qUrl ? decodeURIComponent(qUrl[1].replace(/\+/g, ' ')) : undefined);

  seed.origin ??= toAirportCode(byKey.get('origin')) ?? byKey.get('origin');
  seed.destination ??= toAirportCode(byKey.get('destination')) ?? byKey.get('destination');
  seed.adults ??= byKey.get('adult') ?? byKey.get('adults') ?? 1;
  seed.children ??= byKey.get('child') ?? byKey.get('children') ?? 0;
  seed.infants ??= byKey.get('infant') ?? byKey.get('infants') ?? 0;
  seed.cabin_class ??= byKey.get('cabin_class');
  return seed;
}

const files = await fs.readdir(dir);
let changed = 0;

for (const file of files.filter((f) => f.endsWith('.json'))) {
  const full = path.join(dir, file);
  const a = JSON.parse(await fs.readFile(full, 'utf8')) as Automation;
  const profile = profileFor(a.site);
  if (!profile) continue;

  const seed = seedFrom(a);
  /* A carried-over value only counts if the new field can hold it. The old
     schemas have `cabin_class: true` (a radio the compiler read as a boolean)
     and "Premium Economy" where this site's URL wants "premium" — both would
     go straight into the path and produce a URL the site cannot read. */
  const fields = profile.fields.map((f) => {
    let value = seed[f.key];
    if (value === undefined || value === null || value === '') return { ...f };

    if (f.options.length && !f.options.some((o) => o.value === String(value))) return { ...f };
    if (f.kind === 'number') {
      const n = Number(value);
      if (!Number.isFinite(n)) return { ...f };
      value = f.key === 'adults' ? Math.max(1, n) : Math.max(0, n);
    }
    if (f.kind === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return { ...f };
    if (f.key === 'destination') value = unweld(value);

    return { ...f, defaultValue: value as never };
  });

  /* The old description counted the old fields, so a re-formed automation
     showed "2 editable fields" beside a chip reading "4 fields". Only the count
     is rewritten — the rest of the sentence is still true, because the
     recording it describes has not changed.

     It is stored twice: the automation carries its own copy and so does the
     schema, and the detail page renders the automation's. Rewriting only the
     schema's fixed the JSON and left the screen saying the wrong thing. */
  const recount = (text: string) =>
    text.replace(
      /\d+ editable fields?/,
      `${fields.length} editable field${fields.length === 1 ? '' : 's'}`,
    );

  const next: Automation = {
    ...a,
    name: a.name.includes('flight') || a.name.includes('Flight') ? a.name : profile.name,
    description: recount(a.description),
    category: profile.category,
    emoji: profile.emoji,
    schema: {
      ...a.schema,
      fields,
      description: recount(a.schema.description),
      groups: Array.from(new Set(fields.map((f) => f.group))),
      urlTemplate: undefined,
      output: profile.output,
      compiledBy: `${profile.id} profile`,
      compiledAt: Date.now(),
    },
    updatedAt: Date.now(),
  };

  const preview = profile.buildUrl(Object.fromEntries(fields.map((f) => [f.key, f.defaultValue])));
  console.log(`${dryRun ? '[dry] ' : ''}${a.site} — ${a.name}`);
  console.log(`   fields: ${fields.map((f) => `${f.key}=${String(f.defaultValue)}`).join(', ')}`);
  console.log(`   url:    ${preview ?? '(cannot build — will replay the page)'}`);

  if (!dryRun) await fs.writeFile(full, JSON.stringify(next, null, 2), 'utf8');
  changed += 1;
}

console.log(`\n${changed} automation(s)${dryRun ? ' would be' : ''} updated. ${dryRun ? 'Re-run with --write to apply.' : ''}`);

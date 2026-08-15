/**
 * Does a model's own field naming survive the move onto a site profile?
 *
 * Authoring lets the model name fields however it likes — `star_rating`,
 * `breakfast_included`, `checkin_date` — and then rebuilds the automation
 * around the profile's canonical fields. The values have to follow. When they
 * do not, the run silently drops half of what was asked for, which is worse
 * than refusing: a five-star search that quietly returns hostels.
 *
 *   npx tsx scripts/profile-mapping-test.mts
 */
import { applyProfileForTest } from '../apps/runner/src/authoring.ts';
import { profileFor } from '../apps/runner/src/sites/profiles.ts';
import type { Automation, FormField } from '@mimic/schema';

const field = (key: string, label: string, kind: string, defaultValue: unknown): FormField =>
  ({
    key,
    label,
    kind,
    defaultValue,
    group: 'Details',
    order: 0,
    required: false,
    options: [],
    validation: {},
    bindsTo: [],
    exposure: 'variable',
  }) as unknown as FormField;

/* Names a model actually produced for a Booking request, none of which match
   the profile's spelling. */
const authored = {
  id: 'au_test',
  name: 'Booking.com Hotel Search',
  site: 'www.booking.com',
  category: 'hotels',
  emoji: '🏨',
  description: '',
  createdAt: 1,
  updatedAt: 1,
  stats: { runs: 0, successes: 0, failures: 0 },
  visibility: 'private',
  trace: { id: 'tr_x', steps: [] },
  schema: {
    id: 'fs_x',
    traceId: 'tr_x',
    version: 1,
    name: 'x',
    description: '',
    site: 'www.booking.com',
    category: 'hotels',
    groups: ['Details'],
    compiledBy: 'deepseek (authored)',
    fields: [
      field('destination', 'Where to', 'text', "Cox's Bazar"),
      field('checkin_date', 'Check-in date', 'date', '2026-08-26'),
      field('checkout_date', 'Check-out date', 'date', '2026-09-02'),
      field('adults', 'Adults', 'number', 2),
      field('children', 'Children', 'number', 1),
      field('rooms', 'Rooms', 'number', 2),
      field('star_rating', 'Star rating', 'number', 5),
      field('breakfast_included', 'Breakfast included', 'checkbox', true),
    ],
  },
} as unknown as Automation;

const profile = profileFor('www.booking.com');
if (!profile) throw new Error('booking profile missing');

const out = applyProfileForTest(authored, profile);
const got = Object.fromEntries(out.schema.fields.map((f) => [f.key, f.defaultValue]));

const expected: Record<string, unknown> = {
  destination: "Cox's Bazar",
  check_in: '2026-08-26',
  check_out: '2026-09-02',
  adults: 2,
  children: 1,
  rooms: 2,
  stars: '5',
  breakfast: true,
  free_cancellation: false,
};

let bad = 0;
for (const [key, want] of Object.entries(expected)) {
  const ok = JSON.stringify(got[key]) === JSON.stringify(want);
  if (!ok) bad += 1;
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${key}: ${JSON.stringify(got[key])}${ok ? '' : ` (wanted ${JSON.stringify(want)})`}`);
}

console.log(`\noutput selector: ${out.schema.output?.itemLocator}`);
console.log(`verified: ${Boolean(out.verifiedAt)}`);
console.log(bad ? `\n${bad} wrong` : '\nall mapped');
process.exit(bad ? 1 : 0);

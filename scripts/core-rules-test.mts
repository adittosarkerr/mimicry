/**
 * Exercises the shared rules against an in-memory store.
 *
 * The runner and the deployed site now apply the same billing, quota and
 * library code over different databases. This checks the rules themselves —
 * including the failure paths, which are the ones that go untested and are the
 * only reason the sandbox has a declining card at all.
 *
 *   npx tsx scripts/core-rules-test.mts
 */
import {
  createBilling,
  createLibrary,
  createQuota,
  issueOtp,
  verifyOtp,
  type Collection,
  type Store,
} from '@mimic/core';
import type { Listing } from '@mimic/schema';

const memory = new Map<string, unknown>();
const key = (c: Collection, id: string) => `${c}/${id}`;

const store: Store = {
  async get<T>(c: Collection, id: string) {
    return (memory.get(key(c, id)) as T) ?? null;
  },
  async put<T extends { id?: string }>(c: Collection, record: T) {
    memory.set(key(c, record.id!), record);
    return record;
  },
  async list<T>(c: Collection, where?: (r: T) => boolean) {
    const all = [...memory.entries()]
      .filter(([k]) => k.startsWith(`${c}/`))
      .map(([, v]) => v as T);
    return where ? all.filter(where) : all;
  },
  async remove(c: Collection, id: string) {
    return memory.delete(key(c, id));
  },
};

let failures = 0;
const check = (label: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${label}${ok ? '' : `  → ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
};

const billing = createBilling(store);
const library = createLibrary(store);
const quota = createQuota(store, { enforce: true });

const USER = 'user-1';
const OTHER = 'user-2';

/* ── payment methods ─────────────────────────────────────────────────────── */

const otp = issueOtp(USER, 'add:bkash');
check('a one-time code is issued', /^\d{6}$/.test(otp.code));
check('a wrong code is refused', !verifyOtp(otp.challengeId, '000000').ok);
check('the right code is accepted', verifyOtp(otp.challengeId, otp.code).ok);
check('a code cannot be used twice', !verifyOtp(otp.challengeId, otp.code).ok);

const bkash = await billing.addPaymentMethod({
  userId: USER,
  kind: 'bkash',
  account: '01712345678',
});
check('only the last four digits are kept', bkash.last4 === '5678' && !bkash.label.includes('1712'), bkash.label);
check('the first method added is the default', bkash.isDefault);
check('every method is stamped sandbox', bkash.sandbox === true);

const declining = await billing.addPaymentMethod({
  userId: USER,
  kind: 'card',
  account: '4111 1111 1111 0000',
});
check('a second method is not made default', !declining.isDefault);

await billing.setDefaultMethod(USER, declining.id);
const methods = await billing.listPaymentMethods(USER);
check('exactly one method is default', methods.filter((m) => m.isDefault).length === 1);

check(
  "another account's method cannot be removed",
  (await billing.removePaymentMethod(OTHER, bkash.id)) === false,
);

/* ── charging ────────────────────────────────────────────────────────────── */

const listing: Listing = {
  id: 'lst_test',
  automationId: 'au_test',
  sellerId: OTHER,
  sellerName: 'Someone else',
  title: 'Flight watcher',
  tagline: '',
  description: '',
  category: 'flights',
  tags: [],
  coverEmoji: '✈️',
  priceMinor: 900,
  currency: 'USD',
  interval: 'month',
  trialDays: 0,
  rating: 0,
  ratingCount: 0,
  subscribers: 0,
  runsThisMonth: 0,
  featured: false,
  createdAt: Date.now(),
};
await store.put('listings', listing);

let declinedInvoice: unknown;
try {
  await billing.subscribe(USER, listing, declining.id);
  check('a card ending 0000 declines', false);
} catch (err) {
  declinedInvoice = (err as { invoice?: { status?: string } }).invoice;
  check('a card ending 0000 declines', true);
  check(
    'the declined attempt still writes a receipt',
    (declinedInvoice as { status?: string })?.status === 'failed',
    declinedInvoice,
  );
}
check(
  'a declined charge starts no subscription',
  (await billing.listSubscriptions(USER)).length === 0,
);

const { subscription, invoice } = await billing.subscribe(USER, listing, bkash.id);
check('a good method subscribes', subscription.status === 'active');
check('the receipt is paid and sandboxed', invoice?.status === 'paid' && invoice?.sandbox === true);
check(
  'subscribing twice is refused',
  await billing
    .subscribe(USER, listing, bkash.id)
    .then(() => false)
    .catch(() => true),
);

const cancelled = await billing.cancelSubscription(USER, subscription.id);
check('cancelling stops the renewal, not the access', cancelled?.cancelAtPeriodEnd === true && cancelled?.status === 'active');
check(
  "another account cannot cancel it",
  (await billing.cancelSubscription(OTHER, subscription.id)) === null,
);

const invoices = await billing.listInvoices(USER);
check('both receipts are kept, newest first', invoices.length === 2 && invoices[0].createdAt >= invoices[1].createdAt);
check('receipts are per-account', (await billing.listInvoices(OTHER)).length === 0);

/* ── the daily allowance ─────────────────────────────────────────────────── */

const QUOTA_USER = 'user-3';
check('the free plan allows five a day', (await quota.quotaFor(QUOTA_USER)).limit === 5);
for (let i = 0; i < 5; i += 1) await quota.recordRun(QUOTA_USER);

const spent = await quota.checkQuota(QUOTA_USER);
check('the sixth run is refused', !spent.allowed);
check('the refusal says how many and when it resets', /5 automations a day/.test(spent.message ?? ''), spent.message);
check('anonymous use is never blocked', (await quota.checkQuota(undefined)).allowed);
check(
  'a paying account is not held to the free cap',
  (await quota.planFor(USER)) === 'starter',
);

/* ── the library ─────────────────────────────────────────────────────────── */

const automation = {
  id: 'au_lib',
  ownerId: USER,
  name: 'Test',
  description: '',
  site: 'example.com',
  category: 'general',
  emoji: '⚡',
  schema: { fields: [] },
  trace: { steps: [] },
  stats: { runs: 0, successes: 0, failures: 0 },
  visibility: 'private',
  createdAt: 1,
  updatedAt: 2,
} as unknown as Parameters<typeof library.saveAutomation>[0];

await library.saveAutomation(automation);
check('an owner sees their own automation', (await library.listAutomations(USER)).length === 1);
check('someone else does not', (await library.listAutomations(OTHER)).length === 0);

await library.saveAutomation({ ...automation, visibility: 'public' });
check('a published one is visible to everyone', (await library.listAutomations(OTHER)).length === 1);

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);

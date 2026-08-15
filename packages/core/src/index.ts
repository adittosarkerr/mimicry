import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { nanoid } from 'nanoid';
import type {
  Automation,
  Invoice,
  Listing,
  PaymentMethod,
  Run,
  Subscription,
  UserProfile,
} from '@mimic/schema';

/**
 * The half of Mimicry that has nothing to do with a browser.
 *
 * Accounts, the marketplace, the payment sandbox and the daily allowance are
 * all plain records and rules about them. They used to live inside the runner,
 * which meant a deployment without a runner — the entire point of putting the
 * site on Vercel — had no dashboard, no marketplace and no billing, only a page
 * that said "Failed to fetch".
 *
 * So the rules live here, taking a `Store` rather than reaching for one. The
 * runner passes the JSON files it has always used; the web app passes Supabase.
 * Identical behaviour either side, which is the only way "works locally" and
 * "works deployed" can stay the same sentence.
 */

/* ── storage ────────────────────────────────────────────────────────────── */

export type Collection =
  | 'automations'
  | 'runs'
  | 'profiles'
  | 'listings'
  | 'subscriptions'
  | 'methods'
  | 'invoices'
  | 'usage';

/**
 * Everything the rules below need from a database.
 *
 * Four methods, no query language. That is deliberate: it is the whole surface
 * a JSON folder can honestly implement, so the file-backed store and the
 * Postgres one cannot drift into behaving differently.
 */
export interface Store {
  get<T>(collection: Collection, id: string): Promise<T | null>;
  put<T extends { id?: string }>(collection: Collection, record: T): Promise<T>;
  list<T>(collection: Collection, where?: (record: T) => boolean): Promise<T[]>;
  remove(collection: Collection, id: string): Promise<boolean>;
}

/**
 * Supabase as a document store.
 *
 * One table of JSON documents rather than eight typed tables, because the
 * records here are the same objects the file store writes and the schema that
 * defines them is already Zod. Mirroring every field into columns would mean
 * two definitions of each record that have to be kept in step by hand, and the
 * first time they drift is the first time a receipt loses a field on the way to
 * a screen. Volumes are per-account and small, so the filtering the file store
 * does in memory is done the same way here.
 */
export class SupabaseStore implements Store {
  private readonly db: SupabaseClient;

  constructor(url: string, serviceKey: string) {
    this.db = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }

  async get<T>(collection: Collection, id: string): Promise<T | null> {
    const { data } = await this.db
      .from('records')
      .select('data')
      .eq('collection', collection)
      .eq('id', id)
      .maybeSingle();
    return (data?.data as T) ?? null;
  }

  async put<T extends { id?: string }>(collection: Collection, record: T): Promise<T> {
    const id = record.id;
    if (!id) throw new Error(`Cannot store a ${collection} record without an id.`);

    /* `owner_id` is lifted out of the document so row-level security has
       something to check. It stays in the document too — the document is the
       record, and a copy that has been stripped of a field is a different
       object from the one the file store round-trips. */
    const owner =
      (record as { ownerId?: string; userId?: string; sellerId?: string }).ownerId ??
      (record as { userId?: string }).userId ??
      (record as { sellerId?: string }).sellerId ??
      null;

    const { error } = await this.db
      .from('records')
      .upsert(
        { collection, id, owner_id: isUuid(owner) ? owner : null, data: record as object },
        { onConflict: 'collection,id' },
      );
    if (error) throw new Error(`Could not save ${collection}/${id}: ${error.message}`);
    return record;
  }

  async list<T>(collection: Collection, where?: (record: T) => boolean): Promise<T[]> {
    const { data, error } = await this.db
      .from('records')
      .select('data')
      .eq('collection', collection)
      .limit(2000);
    if (error) throw new Error(`Could not read ${collection}: ${error.message}`);
    const all = (data ?? []).map((row) => row.data as T);
    return where ? all.filter(where) : all;
  }

  async remove(collection: Collection, id: string): Promise<boolean> {
    const { error } = await this.db
      .from('records')
      .delete()
      .eq('collection', collection)
      .eq('id', id);
    return !error;
  }
}

/** Supabase's `owner_id` column is a uuid; a local stub id is not one. */
const isUuid = (v: string | null): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/**
 * A Supabase store built from the environment, or nothing.
 *
 * Returning null rather than throwing is what lets both halves say "use
 * Postgres if it is configured, otherwise carry on" in one line.
 */
export function supabaseStoreFromEnv(env: Record<string, string | undefined>): Store | null {
  const url = env.SUPABASE_URL || env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return new SupabaseStore(url, key);
}

/* ── automations and runs ───────────────────────────────────────────────── */

/**
 * The two collections the browser half writes, read back the way the
 * dashboard wants them: newest first, and only what this person may see.
 */
export function createLibrary(store: Store) {
  return {
    saveAutomation: (a: Automation) => store.put('automations', a),
    getAutomation: (id: string) => store.get<Automation>('automations', id),
    deleteAutomation: (id: string) => store.remove('automations', id),

    listAutomations: async (ownerId?: string): Promise<Automation[]> => {
      const all = await store.list<Automation>('automations');
      return all
        .filter((a) => !ownerId || a.ownerId === ownerId || a.visibility === 'public')
        .sort((x, y) => y.updatedAt - x.updatedAt);
    },

    saveRun: (run: Run) => store.put('runs', run),
    getRun: (id: string) => store.get<Run>('runs', id),

    listRuns: async (automationId?: string, limit = 50): Promise<Run[]> => {
      const all = await store.list<Run>('runs');
      return all
        .filter((r) => !automationId || r.automationId === automationId)
        .sort((x, y) => y.startedAt - x.startedAt)
        .slice(0, limit);
    },
  };
}

/* ── plans and the daily allowance ──────────────────────────────────────── */

/**
 * What each plan actually allows.
 *
 * Every run drives a real headless browser for thirty seconds or more, so the
 * limits are what that costs rather than round numbers picked to look
 * generous. "2,000 runs a day" was neither believable nor affordable — it is
 * roughly seventeen hours of continuous browser time.
 */
export const PLANS = {
  free: {
    label: 'Free',
    runsPerDay: 5,
    automations: 5,
    priceMinor: 0,
    currency: 'USD',
    seats: 1,
    /** Cents per run once the daily allowance is gone; 0 means it simply stops. */
    overageMinor: 0,
    blurb: 'Enough to see whether it works for you.',
  },
  starter: {
    label: 'Starter',
    runsPerDay: 25,
    automations: 25,
    priceMinor: 900,
    currency: 'USD',
    seats: 1,
    overageMinor: 5,
    blurb: 'For one person with a handful of things to keep an eye on.',
  },
  pro: {
    label: 'Pro',
    runsPerDay: 100,
    automations: 200,
    priceMinor: 2900,
    currency: 'USD',
    seats: 1,
    overageMinor: 3,
    blurb: 'Scheduled runs, priority queue, and the REST API without limits.',
  },
  team: {
    label: 'Team',
    runsPerDay: 500,
    automations: 1000,
    priceMinor: 9900,
    currency: 'USD',
    seats: 5,
    overageMinor: 2,
    blurb: 'Five seats, shared automations, and usage billed per run beyond the allowance.',
  },
} as const;

export type PlanName = keyof typeof PLANS;

/** Today, where the server is — the day a person would say it is. */
export const today = (at = Date.now()): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
};

interface UsageRecord {
  /** `${userId}__${day}` — one record per person per day. */
  id: string;
  userId: string;
  day: string;
  runs: number;
  updatedAt: number;
}

const usageId = (userId: string, day: string) => `${userId.replace(/[^\w-]/g, '')}__${day}`;

export interface QuotaState {
  plan: PlanName;
  planLabel: string;
  used: number;
  limit: number;
  remaining: number;
  day: string;
  /** True when the limit is being applied rather than merely counted. */
  enforced: boolean;
  /** True when this run would be refused with enforcement on. */
  wouldBlock: boolean;
}

export interface QuotaVerdict {
  allowed: boolean;
  state: QuotaState;
  message?: string;
}

/**
 * The free plan's cap.
 *
 * Counting happens always and refusing happens only when asked, so the
 * dashboard's numbers are real before the limit is ever switched on — and
 * switching it on changes one boolean rather than starting a fresh count.
 */
export function createQuota(store: Store, opts: { enforce: boolean }) {
  const planFor = async (userId: string | undefined): Promise<PlanName> => {
    if (!userId) return 'free';
    const profile = await store.get<UserProfile>('profiles', userId);
    if (profile?.plan && profile.plan in PLANS) return profile.plan as PlanName;

    /* A paid subscription to anything counts as Starter. The marketplace sells
       individual automations rather than plan tiers, and somebody paying for
       one should not also be held to the free cap — but nor should one $2
       automation silently grant the top tier. */
    const subs = await store.list<Subscription>(
      'subscriptions',
      (s) => s.userId === userId && (s.status === 'active' || s.status === 'trialing'),
    );
    return subs.length ? 'starter' : 'free';
  };

  const quotaFor = async (userId: string | undefined): Promise<QuotaState> => {
    const plan = await planFor(userId);
    const limit = PLANS[plan].runsPerDay;
    const day = today();

    const record = userId ? await store.get<UsageRecord>('usage', usageId(userId, day)) : null;
    const used = record?.runs ?? 0;

    return {
      plan,
      planLabel: PLANS[plan].label,
      used,
      limit,
      remaining: Math.max(0, limit - used),
      day,
      enforced: opts.enforce,
      wouldBlock: used >= limit,
    };
  };

  return {
    planFor,
    quotaFor,

    /** Counts a run. Always — the numbers stay honest whether or not the cap bites. */
    recordRun: async (userId: string | undefined): Promise<void> => {
      if (!userId) return;
      const day = today();
      const id = usageId(userId, day);
      const record = (await store.get<UsageRecord>('usage', id)) ?? {
        id,
        userId,
        day,
        runs: 0,
        updatedAt: Date.now(),
      };
      await store.put('usage', { ...record, runs: record.runs + 1, updatedAt: Date.now() });
    },

    /**
     * Asked before a run starts.
     *
     * Anonymous use is never blocked: there is no account to attribute it to,
     * and refusing on an id the caller invented would be trivially bypassed.
     */
    checkQuota: async (userId: string | undefined): Promise<QuotaVerdict> => {
      const state = await quotaFor(userId);
      if (!userId || !state.enforced || !state.wouldBlock) return { allowed: true, state };

      return {
        allowed: false,
        state,
        message: `The ${state.planLabel} plan runs ${state.limit} automations a day, and today's ${state.used} are used. It resets tomorrow — or upgrade for more.`,
      };
    },
  };
}

/* ── the payment sandbox ────────────────────────────────────────────────── */

/**
 * Nothing here touches money. Every method is fabricated, every charge
 * succeeds or fails according to rules written below, and every record is
 * stamped `sandbox: true` so no screen can accidentally present one as real.
 * That flag is in the schema rather than in this file on purpose — a receipt
 * that loses its provenance on the way to the UI is exactly the thing that
 * gets mistaken for a real one.
 *
 * It exists so the subscribe → pay → receipt path can be built, demonstrated
 * and tested end to end without a gateway account, and so swapping in a real
 * provider later means reimplementing this section and nothing else.
 */
export const SANDBOX_NOTICE =
  'Sandbox — no real payment is taken and no real card or wallet details are accepted.';

export interface Gateway {
  kind: PaymentMethod['kind'];
  label: string;
  /** What the person types to add one. Never a real credential. */
  accountHint: string;
  /** Does this gateway ask for a one-time code? */
  otp: boolean;
  brandColor: string;
}

export const GATEWAYS: Gateway[] = [
  { kind: 'bkash', label: 'bKash', accountHint: '01XXXXXXXXX', otp: true, brandColor: '#e2136e' },
  { kind: 'nagad', label: 'Nagad', accountHint: '01XXXXXXXXX', otp: true, brandColor: '#ec1c24' },
  { kind: 'rocket', label: 'Rocket', accountHint: '01XXXXXXXXX', otp: true, brandColor: '#8c3494' },
  { kind: 'card', label: 'Card', accountHint: '4111 1111 1111 1111', otp: true, brandColor: '#1a1f71' },
  { kind: 'bank', label: 'Bank transfer', accountHint: 'Account number', otp: false, brandColor: '#0f766e' },
];

export const gatewayFor = (kind: string): Gateway | undefined =>
  GATEWAYS.find((g) => g.kind === kind);

export const formatMinor = (minor: number, currency = 'BDT') =>
  `${currency} ${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 0 })}`;

/**
 * A number that is obviously not somebody's real one.
 *
 * The sandbox must never store a string that could be a live wallet or card,
 * even if a person pastes one in — so only the last four digits survive, and
 * the rest is never written anywhere.
 */
function maskOf(kind: PaymentMethod['kind'], account: string): { label: string; last4: string } {
  const digits = account.replace(/\D/g, '');
  const last4 = digits.slice(-4).padStart(4, '0');
  const gateway = gatewayFor(kind);
  const name = gateway?.label ?? kind;
  return {
    label: kind === 'bank' ? `${name} ••••${last4}` : `${name} •••• ${last4}`,
    last4,
  };
}

export interface AddMethodInput {
  userId: string;
  kind: PaymentMethod['kind'];
  account: string;
  brand?: string;
  expiry?: string;
  makeDefault?: boolean;
}

export interface ChargeInput {
  userId: string;
  paymentMethodId: string;
  amountMinor: number;
  currency?: string;
  description: string;
  listingId?: string;
}

export interface IssuedChallenge {
  challengeId: string;
  /** Shown on screen, because there is no real phone to send it to. */
  code: string;
  expiresAt: number;
  notice: string;
}

export interface SubscribeResult {
  subscription: Subscription;
  invoice?: Invoice;
}

interface Challenge {
  id: string;
  userId: string;
  code: string;
  purpose: string;
  attempts: number;
  expiresAt: number;
}

/* Deliberately in memory: a one-time code that outlives a restart is not a
   one-time code, and there is nothing here worth persisting. */
const challenges = new Map<string, Challenge>();

export function issueOtp(userId: string, purpose: string): IssuedChallenge {
  const challenge: Challenge = {
    id: `otp_${nanoid(10)}`,
    userId,
    // Fixed digits would be guessable across users; random ones read as real.
    code: String(Math.floor(100_000 + Math.random() * 900_000)),
    purpose,
    attempts: 0,
    expiresAt: Date.now() + 5 * 60_000,
  };
  challenges.set(challenge.id, challenge);

  // Housekeeping — expired codes are worthless and shouldn't accumulate.
  for (const [id, c] of challenges) if (c.expiresAt < Date.now()) challenges.delete(id);

  return {
    challengeId: challenge.id,
    code: challenge.code,
    expiresAt: challenge.expiresAt,
    notice: `${SANDBOX_NOTICE} The code is shown here because nothing is sent to a real phone.`,
  };
}

export function verifyOtp(challengeId: string, code: string): { ok: boolean; error?: string } {
  const challenge = challenges.get(challengeId);
  if (!challenge) return { ok: false, error: 'That code has expired. Ask for a new one.' };
  if (challenge.expiresAt < Date.now()) {
    challenges.delete(challengeId);
    return { ok: false, error: 'That code has expired. Ask for a new one.' };
  }

  challenge.attempts += 1;
  if (challenge.attempts > 5) {
    challenges.delete(challengeId);
    return { ok: false, error: 'Too many attempts. Ask for a new code.' };
  }
  if (challenge.code !== code.trim()) {
    return { ok: false, error: 'That code is not right.' };
  }

  challenges.delete(challengeId);
  return { ok: true };
}

const PERIOD_MS: Record<Listing['interval'], number> = {
  month: 30 * 24 * 3600_000,
  year: 365 * 24 * 3600_000,
  one_time: 100 * 365 * 24 * 3600_000,
};

export function createBilling(store: Store) {
  const listPaymentMethods = (userId: string) =>
    store
      .list<PaymentMethod>('methods', (m) => m.userId === userId)
      .then((all) =>
        all.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.createdAt - a.createdAt),
      );

  /**
   * Charges a sandbox method and writes the receipt either way.
   *
   * A failure path that cannot be reached is a failure path nobody has tested,
   * so a method ending 0000 always declines. It is the only rule — everything
   * else succeeds — and it gives the UI a real error to render.
   */
  const charge = async (input: ChargeInput): Promise<Invoice> => {
    const method = await store.get<PaymentMethod>('methods', input.paymentMethodId);
    if (!method || method.userId !== input.userId) throw new Error('No such payment method.');

    const declined = method.last4 === '0000';
    const invoice: Invoice = {
      id: `inv_${nanoid(12)}`,
      userId: input.userId,
      listingId: input.listingId,
      amountMinor: input.amountMinor,
      currency: input.currency ?? 'BDT',
      status: declined ? 'failed' : 'paid',
      description: input.description,
      paymentMethodId: method.id,
      createdAt: Date.now(),
      paidAt: declined ? undefined : Date.now(),
      sandbox: true,
    };

    await store.put('invoices', invoice);
    if (declined) {
      throw Object.assign(new Error(`${method.label} declined the payment.`), { invoice });
    }
    return invoice;
  };

  return {
    listPaymentMethods,
    charge,

    addPaymentMethod: async (input: AddMethodInput): Promise<PaymentMethod> => {
      const gateway = gatewayFor(input.kind);
      if (!gateway) throw new Error(`Unknown payment method: ${input.kind}`);

      const digits = input.account.replace(/\D/g, '');
      if (digits.length < 4) {
        throw new Error(`Enter a ${gateway.label} account (${gateway.accountHint}).`);
      }

      const { label, last4 } = maskOf(input.kind, input.account);
      const existing = await listPaymentMethods(input.userId);

      const method: PaymentMethod = {
        id: `pm_${nanoid(12)}`,
        userId: input.userId,
        kind: input.kind,
        label,
        last4,
        brand: input.brand,
        expiry: input.expiry,
        // The first one added is the default, whatever the caller asked for.
        isDefault: input.makeDefault ?? existing.length === 0,
        createdAt: Date.now(),
        sandbox: true,
      };

      if (method.isDefault) {
        for (const other of existing.filter((m) => m.isDefault)) {
          await store.put('methods', { ...other, isDefault: false });
        }
      }

      return store.put('methods', method);
    },

    removePaymentMethod: async (userId: string, id: string): Promise<boolean> => {
      const method = await store.get<PaymentMethod>('methods', id);
      if (!method || method.userId !== userId) return false;
      const ok = await store.remove('methods', id);

      // Never leave an account with methods but no default.
      if (ok && method.isDefault) {
        const rest = await listPaymentMethods(userId);
        if (rest[0]) await store.put('methods', { ...rest[0], isDefault: true });
      }
      return ok;
    },

    setDefaultMethod: async (userId: string, id: string): Promise<PaymentMethod | null> => {
      const method = await store.get<PaymentMethod>('methods', id);
      if (!method || method.userId !== userId) return null;
      for (const other of await listPaymentMethods(userId)) {
        if (other.isDefault && other.id !== id) {
          await store.put('methods', { ...other, isDefault: false });
        }
      }
      return store.put('methods', { ...method, isDefault: true });
    },

    listInvoices: (userId: string) =>
      store
        .list<Invoice>('invoices', (i) => i.userId === userId)
        .then((all) => all.sort((a, b) => b.createdAt - a.createdAt)),

    listSubscriptions: (userId: string) =>
      store
        .list<Subscription>('subscriptions', (s) => s.userId === userId)
        .then((all) => all.sort((a, b) => b.startedAt - a.startedAt)),

    /**
     * Starts a subscription, charging now unless the listing offers a trial.
     *
     * A trial deliberately still requires a payment method on file: it is how
     * the real thing behaves, and building the flow without it would leave the
     * "trial ended, now pay" case untested.
     */
    subscribe: async (
      userId: string,
      listing: Listing,
      paymentMethodId: string,
    ): Promise<SubscribeResult> => {
      const existing = await store.list<Subscription>(
        'subscriptions',
        (s) => s.userId === userId && s.listingId === listing.id && s.status !== 'cancelled',
      );
      if (existing.length) throw new Error('You are already subscribed to this automation.');

      const trialing = listing.trialDays > 0;
      const now = Date.now();

      let invoice: Invoice | undefined;
      if (!trialing && listing.priceMinor > 0) {
        invoice = await charge({
          userId,
          paymentMethodId,
          amountMinor: listing.priceMinor,
          currency: listing.currency,
          description: `${listing.title} — ${
            listing.interval === 'one_time' ? 'one-time' : listing.interval
          }`,
          listingId: listing.id,
        });
      }

      const subscription: Subscription = {
        id: `sub_${nanoid(12)}`,
        userId,
        listingId: listing.id,
        status: trialing ? 'trialing' : 'active',
        startedAt: now,
        currentPeriodEnd:
          now + (trialing ? listing.trialDays * 24 * 3600_000 : PERIOD_MS[listing.interval]),
        cancelAtPeriodEnd: false,
        paymentMethodId,
      };

      await store.put('subscriptions', subscription);
      await store.put('listings', { ...listing, subscribers: listing.subscribers + 1 });

      return { subscription, invoice };
    },

    cancelSubscription: async (userId: string, id: string): Promise<Subscription | null> => {
      const sub = await store.get<Subscription>('subscriptions', id);
      if (!sub || sub.userId !== userId) return null;

      /* Cancelling stops the renewal, it does not take away what was paid for.
         Ending access the instant somebody clicks cancel is how a subscription
         becomes something people are afraid to touch. */
      return store.put('subscriptions', { ...sub, cancelAtPeriodEnd: true });
    },
  };
}

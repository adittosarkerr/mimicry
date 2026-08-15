import type { Subscription, UserProfile } from '@mimic/schema';
import { config } from './config.js';
import { get, list, put } from './store.js';

/**
 * Free-plan limits.
 *
 * Written in full and switched off by default. Enforcing a daily cap while the
 * product is still being tested means every session ends in an artificial wall
 * that has nothing to do with the thing being tested — so the counting happens
 * always (the dashboard can show it, and the numbers are real when the cap is
 * turned on) and the refusal happens only when `MIMIC_ENFORCE_QUOTA` says so.
 *
 * Turn it on with `MIMIC_ENFORCE_QUOTA=1` in the environment.
 */

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
    runsPerDay: 3,
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

/** Today, in the runner's timezone — the day a person would say it is. */
export const today = (at = Date.now()): string => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

export async function planFor(userId: string | undefined): Promise<PlanName> {
  if (!userId) return 'free';
  const profile = await get<UserProfile>('profiles', userId);
  if (profile?.plan && profile.plan in PLANS) return profile.plan as PlanName;

  /* A paid subscription to anything counts as Starter. The marketplace sells
     individual automations rather than plan tiers, and somebody paying for one
     should not also be held to the free cap — but nor should one $2 automation
     silently grant the top tier. */
  const subs = await list<Subscription>(
    'subscriptions',
    (s) => s.userId === userId && (s.status === 'active' || s.status === 'trialing'),
  );
  return subs.length ? 'starter' : 'free';
}

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

export async function quotaFor(userId: string | undefined): Promise<QuotaState> {
  const plan = await planFor(userId);
  const limit = PLANS[plan].runsPerDay;
  const day = today();

  const record = userId ? await get<UsageRecord>('usage', usageId(userId, day)) : null;
  const used = record?.runs ?? 0;

  return {
    plan,
    planLabel: PLANS[plan].label,
    used,
    limit,
    remaining: Math.max(0, limit - used),
    day,
    enforced: config.enforceQuota,
    wouldBlock: used >= limit,
  };
}

/** Counts a run. Always — the numbers stay honest whether or not the cap bites. */
export async function recordRun(userId: string | undefined): Promise<void> {
  if (!userId) return;
  const day = today();
  const id = usageId(userId, day);
  const record = (await get<UsageRecord>('usage', id)) ?? {
    id,
    userId,
    day,
    runs: 0,
    updatedAt: Date.now(),
  };
  await put('usage', { ...record, runs: record.runs + 1, updatedAt: Date.now() });
}

export interface QuotaVerdict {
  allowed: boolean;
  state: QuotaState;
  message?: string;
}

/**
 * Asked before a run starts.
 *
 * Anonymous use is never blocked: there is no account to attribute it to, and
 * refusing on an id the caller invented would be trivially bypassed anyway.
 */
export async function checkQuota(userId: string | undefined): Promise<QuotaVerdict> {
  const state = await quotaFor(userId);
  if (!userId || !state.enforced || !state.wouldBlock) return { allowed: true, state };

  return {
    allowed: false,
    state,
    message: `The ${state.planLabel} plan runs ${state.limit} automations a day, and today's ${state.used} are used. It resets tomorrow — or upgrade for more.`,
  };
}

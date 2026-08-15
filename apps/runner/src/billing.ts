import { nanoid } from 'nanoid';
import type { Invoice, Listing, PaymentMethod, Subscription } from '@mimic/schema';
import { get, list, put, remove } from './store.js';

/**
 * The payment sandbox.
 *
 * Nothing here touches money. Every method is fabricated, every charge
 * succeeds or fails according to rules written below, and every record is
 * stamped `sandbox: true` so no screen can accidentally present one as real.
 * That flag is in the schema rather than in this file on purpose — a receipt
 * that loses its provenance on the way to the UI is exactly the thing that
 * gets mistaken for a real one.
 *
 * It exists so the subscribe → pay → receipt path can be built, demonstrated
 * and tested end to end without a gateway account, and so swapping in a real
 * provider later means reimplementing this module's exports and nothing else.
 */

export const SANDBOX_NOTICE =
  'Sandbox — no real payment is taken and no real card or wallet details are accepted.';

/* ── gateways ───────────────────────────────────────────────────────────── */

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

/* ── payment methods ────────────────────────────────────────────────────── */

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

export async function addPaymentMethod(input: AddMethodInput): Promise<PaymentMethod> {
  const gateway = gatewayFor(input.kind);
  if (!gateway) throw new Error(`Unknown payment method: ${input.kind}`);

  const digits = input.account.replace(/\D/g, '');
  if (digits.length < 4) throw new Error(`Enter a ${gateway.label} account (${gateway.accountHint}).`);

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
      await put('methods', { ...other, isDefault: false });
    }
  }

  return put('methods', method);
}

export const listPaymentMethods = (userId: string) =>
  list<PaymentMethod>('methods', (m) => m.userId === userId).then((all) =>
    all.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || b.createdAt - a.createdAt),
  );

export async function removePaymentMethod(userId: string, id: string): Promise<boolean> {
  const method = await get<PaymentMethod>('methods', id);
  if (!method || method.userId !== userId) return false;
  const ok = await remove('methods', id);

  // Never leave an account with methods but no default.
  if (ok && method.isDefault) {
    const rest = await listPaymentMethods(userId);
    if (rest[0]) await put('methods', { ...rest[0], isDefault: true });
  }
  return ok;
}

export async function setDefaultMethod(userId: string, id: string): Promise<PaymentMethod | null> {
  const method = await get<PaymentMethod>('methods', id);
  if (!method || method.userId !== userId) return null;
  for (const other of await listPaymentMethods(userId)) {
    if (other.isDefault && other.id !== id) await put('methods', { ...other, isDefault: false });
  }
  return put('methods', { ...method, isDefault: true });
}

/* ── the one-time code ──────────────────────────────────────────────────── */

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

export interface IssuedChallenge {
  challengeId: string;
  /** Shown on screen, because there is no real phone to send it to. */
  code: string;
  expiresAt: number;
  notice: string;
}

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

/* ── charging ───────────────────────────────────────────────────────────── */

export const formatMinor = (minor: number, currency = 'BDT') =>
  `${currency} ${(minor / 100).toLocaleString(undefined, { minimumFractionDigits: 0 })}`;

export interface ChargeInput {
  userId: string;
  paymentMethodId: string;
  amountMinor: number;
  currency?: string;
  description: string;
  listingId?: string;
}

/**
 * Charges a sandbox method and writes the receipt either way.
 *
 * A failure path that cannot be reached is a failure path nobody has tested,
 * so a method ending 0000 always declines. It is the only rule — everything
 * else succeeds — and it gives the UI a real error to render.
 */
export async function charge(input: ChargeInput): Promise<Invoice> {
  const method = await get<PaymentMethod>('methods', input.paymentMethodId);
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

  await put('invoices', invoice);
  if (declined) {
    throw Object.assign(new Error(`${method.label} declined the payment.`), { invoice });
  }
  return invoice;
}

export const listInvoices = (userId: string) =>
  list<Invoice>('invoices', (i) => i.userId === userId).then((all) =>
    all.sort((a, b) => b.createdAt - a.createdAt),
  );

/* ── subscriptions ──────────────────────────────────────────────────────── */

const PERIOD_MS: Record<Listing['interval'], number> = {
  month: 30 * 24 * 3600_000,
  year: 365 * 24 * 3600_000,
  one_time: 100 * 365 * 24 * 3600_000,
};

export interface SubscribeResult {
  subscription: Subscription;
  invoice?: Invoice;
}

/**
 * Starts a subscription, charging now unless the listing offers a trial.
 *
 * A trial deliberately still requires a payment method on file: it is how the
 * real thing behaves, and building the flow without it would leave the
 * "trial ended, now pay" case untested.
 */
export async function subscribe(
  userId: string,
  listing: Listing,
  paymentMethodId: string,
): Promise<SubscribeResult> {
  const existing = await list<Subscription>(
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
      description: `${listing.title} — ${listing.interval === 'one_time' ? 'one-time' : listing.interval}`,
      listingId: listing.id,
    });
  }

  const subscription: Subscription = {
    id: `sub_${nanoid(12)}`,
    userId,
    listingId: listing.id,
    status: trialing ? 'trialing' : 'active',
    startedAt: now,
    currentPeriodEnd: now + (trialing ? listing.trialDays * 24 * 3600_000 : PERIOD_MS[listing.interval]),
    cancelAtPeriodEnd: false,
    paymentMethodId,
  };

  await put('subscriptions', subscription);
  await put('listings', { ...listing, subscribers: listing.subscribers + 1 });

  return { subscription, invoice };
}

export async function cancelSubscription(
  userId: string,
  id: string,
): Promise<Subscription | null> {
  const sub = await get<Subscription>('subscriptions', id);
  if (!sub || sub.userId !== userId) return null;

  /* Cancelling stops the renewal, it does not take away what was paid for.
     Ending access the instant somebody clicks cancel is how a subscription
     becomes something people are afraid to touch. */
  return put('subscriptions', { ...sub, cancelAtPeriodEnd: true });
}

export const listSubscriptions = (userId: string) =>
  list<Subscription>('subscriptions', (s) => s.userId === userId).then((all) =>
    all.sort((a, b) => b.startedAt - a.startedAt),
  );

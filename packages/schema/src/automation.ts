import { z } from 'zod';
import { FormSchema } from './form.js';
import { Trace } from './trace.js';

export const Automation = z.object({
  id: z.string(),
  ownerId: z.string().optional(),
  name: z.string(),
  description: z.string(),
  site: z.string(),
  category: z.string().default('general'),
  emoji: z.string().default('⚡'),
  createdAt: z.number(),
  updatedAt: z.number(),
  schema: FormSchema,
  trace: Trace,
  /** Denormalised counters for the dashboard. */
  stats: z
    .object({
      runs: z.number().default(0),
      successes: z.number().default(0),
      failures: z.number().default(0),
      lastRunAt: z.number().optional(),
      avgDurationMs: z.number().optional(),
    })
    .default({ runs: 0, successes: 0, failures: 0 }),
  /**
   * True while the AI pass is still improving the form.
   *
   * Ingest saves the rule-based form immediately and refines afterwards, so the
   * extension never waits on a model call. The automation is runnable the whole
   * time; this only tells the UI that better field names are on the way.
   */
  refining: z.boolean().default(false),
  /** Set when that second pass failed, so the UI can say so rather than hide it. */
  refineWarning: z.string().optional(),
  /**
   * When an authored automation was last confirmed to return real results.
   *
   * A recording needs no such proof — a person did the task and Mimic watched.
   * One written from a description does: the URL pattern in it may be entirely
   * invented, and an invented URL usually loads something, so nothing errors.
   * Only automations carrying this are offered as matches for a spoken request.
   */
  verifiedAt: z.number().optional(),
  /** Present once published to the marketplace. */
  listingId: z.string().optional(),
  visibility: z.enum(['private', 'unlisted', 'public']).default('private'),
});
export type Automation = z.infer<typeof Automation>;

export const Listing = z.object({
  id: z.string(),
  automationId: z.string(),
  sellerId: z.string(),
  sellerName: z.string(),
  title: z.string(),
  tagline: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()).default([]),
  coverEmoji: z.string().default('⚡'),
  /** Monthly price in the smallest currency unit (poisha for BDT). */
  priceMinor: z.number().int().default(0),
  currency: z.string().default('BDT'),
  interval: z.enum(['month', 'year', 'one_time']).default('month'),
  /** Free trial length in days, 0 = none. */
  trialDays: z.number().int().default(0),
  rating: z.number().default(0),
  ratingCount: z.number().int().default(0),
  subscribers: z.number().int().default(0),
  runsThisMonth: z.number().int().default(0),
  featured: z.boolean().default(false),
  createdAt: z.number(),
});
export type Listing = z.infer<typeof Listing>;

export const Subscription = z.object({
  id: z.string(),
  userId: z.string(),
  listingId: z.string(),
  status: z.enum(['trialing', 'active', 'past_due', 'cancelled']),
  startedAt: z.number(),
  currentPeriodEnd: z.number(),
  cancelAtPeriodEnd: z.boolean().default(false),
  paymentMethodId: z.string().optional(),
});
export type Subscription = z.infer<typeof Subscription>;

/** Sandbox payment instrument. No real card data is ever accepted or stored. */
export const PaymentMethod = z.object({
  id: z.string(),
  userId: z.string(),
  kind: z.enum(['bkash', 'nagad', 'rocket', 'card', 'bank']),
  label: z.string(), // "bKash •••• 4521"
  /** Last 4 of the masked, fake identifier. */
  last4: z.string(),
  brand: z.string().optional(), // Visa / Mastercard / BRAC Bank
  expiry: z.string().optional(),
  isDefault: z.boolean().default(false),
  createdAt: z.number(),
  /** Always true in this build — the whole payment layer is a simulation. */
  sandbox: z.literal(true).default(true),
});
export type PaymentMethod = z.infer<typeof PaymentMethod>;

export const Invoice = z.object({
  id: z.string(),
  userId: z.string(),
  listingId: z.string().optional(),
  amountMinor: z.number().int(),
  currency: z.string().default('BDT'),
  status: z.enum(['pending', 'paid', 'failed', 'refunded']),
  description: z.string(),
  paymentMethodId: z.string().optional(),
  createdAt: z.number(),
  paidAt: z.number().optional(),
  sandbox: z.literal(true).default(true),
});
export type Invoice = z.infer<typeof Invoice>;

export const UserProfile = z.object({
  id: z.string(),
  email: z.string(),
  displayName: z.string().optional(),
  avatarUrl: z.string().optional(),
  createdAt: z.number(),
  plan: z.enum(['free', 'pro', 'team']).default('free'),
});
export type UserProfile = z.infer<typeof UserProfile>;

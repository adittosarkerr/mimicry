import { nanoid } from 'nanoid';
import type { Automation, Listing, PaymentMethod, UserProfile } from '@mimic/schema';
import {
  GATEWAYS,
  PLANS,
  SANDBOX_NOTICE,
  gatewayFor,
  issueOtp,
  verifyOtp,
} from '@mimic/core';
import {
  billing,
  library,
  quota,
  store,
  unavailableReason,
  userIdFrom,
} from '@/lib/server/backend';

/**
 * The site answering for itself.
 *
 * Every one of these paths matches a route on the runner exactly, because that
 * is what makes the fallback invisible: the client asks the runner first and,
 * when there is no runner to ask, sends the identical request here instead. Two
 * implementations of one API is a liability, so the rules underneath are shared
 * — this file is routing, argument checking, and nothing else.
 *
 * What is deliberately *not* here: recording, running, and voice. Those need a
 * real browser, which a serverless function has no business pretending to have.
 * Asking for one returns a plain explanation rather than a timeout.
 */

export const dynamic = 'force-dynamic';

/**
 * The few that still belong to the runner.
 *
 * Runs, recordings and voice have their own routes now and really do drive a
 * browser here. What is left are the two that stream bytes rather than JSON —
 * a screenshot the runner holds on its own disk, and an image proxied from
 * whatever site a result came from — plus the debug extractor, which is a
 * development tool and has no business on a public deployment.
 */
const RUNNER_ONLY =
  'This one is served by the runner. Deploy it (see DEPLOYING.md) and set NEXT_PUBLIC_RUNNER_URL.';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

const fail = (message: string, status = 400) => json({ error: message }, status);

type Ctx = { params: Promise<{ path: string[] }> };

export async function GET(req: Request, ctx: Ctx) {
  return handle(req, await ctx.params, 'GET');
}
export async function POST(req: Request, ctx: Ctx) {
  return handle(req, await ctx.params, 'POST');
}
export async function PUT(req: Request, ctx: Ctx) {
  return handle(req, await ctx.params, 'PUT');
}
export async function PATCH(req: Request, ctx: Ctx) {
  return handle(req, await ctx.params, 'PATCH');
}
export async function DELETE(req: Request, ctx: Ctx) {
  return handle(req, await ctx.params, 'DELETE');
}

async function handle(req: Request, params: { path: string[] }, method: string): Promise<Response> {
  const seg = params.path ?? [];
  const at = (i: number) => seg[i] ?? '';

  /* The gateway list is a constant. Answering it without a database means the
     payment screen renders its options even on a site that has none yet, and
     says what is missing where it matters rather than everywhere. */
  if (at(0) === 'payment' && at(1) === 'gateways' && method === 'GET') {
    return json({ gateways: GATEWAYS, notice: SANDBOX_NOTICE });
  }

  if (at(0) === 'debug' || at(0) === 'image' || at(0) === 'screenshots') {
    return fail(RUNNER_ONLY, 503);
  }

  if (!store || !billing || !library || !quota) return fail(unavailableReason(), 503);

  const body = await readBody(req);
  const userId = await userIdFrom(req);
  const mustBeSignedIn = () => fail('Sign in to do that.', 401);

  try {
    /* ── automations ──────────────────────────────────────────────────── */
    if (at(0) === 'automations') {
      const id = at(1);

      if (!id && method === 'GET') {
        const ownerId = new URL(req.url).searchParams.get('ownerId') ?? undefined;
        const all = await library.listAutomations(ownerId);
        // Traces are heavy — the list view never needs them.
        return json(all.map(({ trace, ...rest }) => ({ ...rest, stepCount: trace.steps.length })));
      }

      if (id && method === 'GET') {
        const automation = await library.getAutomation(id);
        if (!automation) return fail('No automation with that id.', 404);
        const { trace, ...rest } = automation;
        return json({
          ...rest,
          stepCount: trace.steps.length,
          startUrl: trace.startUrl,
          finalUrl: trace.finalUrl,
        });
      }

      if (id && method === 'PATCH') {
        const automation = await library.getAutomation(id);
        if (!automation) return fail('No automation with that id.', 404);

        const next: Automation = {
          ...automation,
          name: typeof body.name === 'string' ? body.name.slice(0, 120) : automation.name,
          description:
            typeof body.description === 'string'
              ? body.description.slice(0, 600)
              : automation.description,
          visibility: (['private', 'unlisted', 'public'] as const).includes(
            body.visibility as 'private',
          )
            ? (body.visibility as Automation['visibility'])
            : automation.visibility,
          ownerId: typeof body.ownerId === 'string' ? body.ownerId : automation.ownerId,
          // Field-level edits (labels, exposure, defaults) come back whole.
          schema: (body.schema as Automation['schema']) ?? automation.schema,
          updatedAt: Date.now(),
        };

        await library.saveAutomation(next);
        const { trace, ...rest } = next;
        return json(rest);
      }

      if (id && method === 'DELETE') return json({ ok: await library.deleteAutomation(id) });
    }

    /* ── runs ─────────────────────────────────────────────────────────── */
    if (at(0) === 'runs' && method === 'GET') {
      const id = at(1);
      if (id) {
        const run = await library.getRun(id);
        return run ? json(run) : fail('No run with that id.', 404);
      }
      const query = new URL(req.url).searchParams;
      return json(
        await library.listRuns(
          query.get('automationId') ?? undefined,
          Math.min(200, Number(query.get('limit') ?? 20) || 20),
        ),
      );
    }

    /* ── the account ──────────────────────────────────────────────────── */
    if (at(0) === 'me') {
      if (method === 'GET') {
        const profile = userId ? await store.get<UserProfile>('profiles', userId) : null;
        return json({ profile, quota: await quota.quotaFor(userId ?? undefined), plans: PLANS });
      }

      if (method === 'PUT') {
        if (!userId) return mustBeSignedIn();
        const existing = await store.get<UserProfile>('profiles', userId);
        const profile: UserProfile = {
          id: userId,
          email: String(body.email ?? existing?.email ?? '').slice(0, 200),
          displayName: (body.displayName as string | undefined)?.slice(0, 80) ?? existing?.displayName,
          avatarUrl: existing?.avatarUrl,
          createdAt: existing?.createdAt ?? Date.now(),
          plan: (['free', 'pro', 'team'] as const).includes(body.plan as 'free')
            ? (body.plan as UserProfile['plan'])
            : (existing?.plan ?? 'free'),
        };
        return json(await store.put('profiles', profile));
      }
    }

    /* ── marketplace ──────────────────────────────────────────────────── */
    if (at(0) === 'listings') {
      const id = at(1);

      if (!id && method === 'GET') {
        const listings = await store.list<Listing>('listings');
        return json(
          listings.sort(
            (a, b) => Number(b.featured) - Number(a.featured) || b.createdAt - a.createdAt,
          ),
        );
      }

      if (!id && method === 'POST') {
        if (!userId) return mustBeSignedIn();
        const automation = body.automationId
          ? await library.getAutomation(String(body.automationId))
          : null;
        if (!automation) return fail('Publish an automation you own.');
        if (automation.ownerId && automation.ownerId !== userId) {
          return fail('That automation belongs to someone else.', 403);
        }

        const listing: Listing = {
          id: `lst_${nanoid(12)}`,
          automationId: automation.id,
          sellerId: userId,
          sellerName: String(body.sellerName ?? 'A Mimic user').slice(0, 80),
          title: String(body.title ?? automation.name).slice(0, 120),
          tagline: String(body.tagline ?? automation.description).slice(0, 160),
          description: String(body.description ?? automation.description).slice(0, 2000),
          category: automation.category,
          tags: ((body.tags as string[]) ?? []).slice(0, 8).map((t) => String(t).slice(0, 24)),
          coverEmoji: String(body.coverEmoji ?? automation.emoji).slice(0, 8),
          priceMinor: Math.max(0, Math.round(Number(body.priceMinor ?? 0))),
          currency: String(body.currency ?? 'BDT').slice(0, 8),
          interval: (['month', 'year', 'one_time'] as const).includes(body.interval as 'month')
            ? (body.interval as Listing['interval'])
            : 'month',
          trialDays: Math.max(0, Math.min(60, Math.round(Number(body.trialDays ?? 0)))),
          rating: 0,
          ratingCount: 0,
          subscribers: 0,
          runsThisMonth: 0,
          featured: false,
          createdAt: Date.now(),
        };

        await store.put('listings', listing);
        await library.saveAutomation({ ...automation, listingId: listing.id, visibility: 'public' });
        return json(listing);
      }

      if (id && method === 'DELETE') {
        if (!userId) return mustBeSignedIn();
        const listing = await store.get<Listing>('listings', id);
        if (!listing || listing.sellerId !== userId) return fail('No such listing.', 404);
        return json({ ok: await store.remove('listings', listing.id) });
      }
    }

    /* ── the payment sandbox ──────────────────────────────────────────── */
    if (at(0) === 'payment' && at(1) === 'methods') {
      if (!userId) return mustBeSignedIn();
      const id = at(2);

      if (!id && method === 'GET') return json(await billing.listPaymentMethods(userId));

      if (id === 'start' && method === 'POST') {
        const gateway = gatewayFor(String(body.kind ?? ''));
        if (!gateway) return fail(`Unknown payment method: ${String(body.kind ?? '')}`);
        // Bank transfer has nothing to confirm, so it skips straight to adding.
        return json(
          gateway.otp ? issueOtp(userId, `add:${gateway.kind}`) : { challengeId: null, code: null },
        );
      }

      if (!id && method === 'POST') {
        const gateway = gatewayFor(String(body.kind ?? ''));
        if (!gateway) return fail('Choose a payment method.');

        if (gateway.otp) {
          const verdict = verifyOtp(String(body.challengeId ?? ''), String(body.code ?? ''));
          if (!verdict.ok) return fail(verdict.error ?? 'That code is not right.');
        }

        return json(
          await billing.addPaymentMethod({
            userId,
            kind: body.kind as PaymentMethod['kind'],
            account: String(body.account ?? ''),
            brand: body.brand as string | undefined,
            expiry: body.expiry as string | undefined,
            makeDefault: body.makeDefault as boolean | undefined,
          }),
        );
      }

      if (id && at(3) === 'default' && method === 'POST') {
        const method_ = await billing.setDefaultMethod(userId, id);
        return method_ ? json(method_) : fail('No such payment method.', 404);
      }

      if (id && method === 'DELETE') {
        return json({ ok: await billing.removePaymentMethod(userId, id) });
      }
    }

    if (at(0) === 'payment' && at(1) === 'invoices' && method === 'GET') {
      if (!userId) return mustBeSignedIn();
      return json(await billing.listInvoices(userId));
    }

    /* ── subscriptions ────────────────────────────────────────────────── */
    if (at(0) === 'subscriptions') {
      if (!userId) return mustBeSignedIn();
      const id = at(1);

      if (!id && method === 'GET') {
        const subs = await billing.listSubscriptions(userId);
        const listings = await store.list<Listing>('listings');
        return json(
          subs.map((s) => ({ ...s, listing: listings.find((l) => l.id === s.listingId) ?? null })),
        );
      }

      if (!id && method === 'POST') {
        const listing = await store.get<Listing>('listings', String(body.listingId ?? ''));
        if (!listing) return fail('No such listing.', 404);
        if (listing.sellerId === userId) {
          return fail('This is your own automation — you already have it.');
        }
        return json(
          await billing.subscribe(userId, listing, String(body.paymentMethodId ?? '')),
        );
      }

      if (id && at(2) === 'cancel' && method === 'POST') {
        const sub = await billing.cancelSubscription(userId, id);
        return sub ? json(sub) : fail('No such subscription.', 404);
      }
    }

    return fail(`No route for ${method} /api/${seg.join('/')}`, 404);
  } catch (err) {
    /* A declined sandbox charge throws with the receipt attached, and that
       receipt is the whole point of the failure path — the UI shows it. */
    const invoice = (err as { invoice?: unknown }).invoice;
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message.slice(0, 400), invoice }, 400);
  }
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (req.method === 'GET' || req.method === 'DELETE') return {};
  try {
    return ((await req.json()) as Record<string, unknown>) ?? {};
  } catch {
    return {};
  }
}

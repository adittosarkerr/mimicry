'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Invoice, Listing, PaymentMethod } from '@mimic/schema';
import { useAuth } from '@/lib/auth-context';
import { api, formatMoney, type SubscriptionWithListing } from '@/lib/api';
import { Badge, Button, ButtonLink, Card, EmptyState, SectionLabel, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';

export function Marketplace() {
  const { user } = useAuth();
  const [listings, setListings] = useState<Listing[]>([]);
  const [subs, setSubs] = useState<SubscriptionWithListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [buying, setBuying] = useState<Listing | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [all, mine] = await Promise.all([
        api.listListings(),
        user ? api.listSubscriptions(user.id).catch(() => []) : Promise.resolve([]),
      ]);
      setListings(all);
      setSubs(mine as SubscriptionWithListing[]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  const subscribedTo = new Set(
    subs.filter((s) => s.status !== 'cancelled').map((s) => s.listingId),
  );

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <SectionLabel>Marketplace</SectionLabel>
      <h1 className="mt-3 font-display text-[clamp(2rem,4.5vw,3rem)] leading-tight text-ink-900">
        Automations other people already built.
      </h1>
      <p className="mt-3 max-w-xl text-[15px] leading-relaxed text-ink-500">
        Subscribe and run them with your own values. Every payment here is a sandbox — nothing real
        is charged.
      </p>

      {error && (
        <p className="mt-6 rounded-xl border border-red-200 bg-rust-100 px-4 py-3 text-[13px] text-rust-500">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : listings.length ? (
        <div className="mt-10 grid gap-5 md:grid-cols-2 lg:grid-cols-3">
          {listings.map((l) => (
            <ListingCard
              key={l.id}
              listing={l}
              owned={subscribedTo.has(l.id)}
              mine={l.sellerId === user?.id}
              onSubscribe={() => setBuying(l)}
            />
          ))}
        </div>
      ) : (
        <div className="mt-10">
          <EmptyState
            title="Nothing listed yet"
            body="Publish one of your own automations from the dashboard and it shows up here for everyone."
            action={<ButtonLink href="/dashboard">Go to the dashboard</ButtonLink>}
          />
        </div>
      )}

      <AnimatePresence>
        {buying && (
          <CheckoutDialog
            listing={buying}
            onClose={() => setBuying(null)}
            onDone={() => {
              setBuying(null);
              void load();
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function ListingCard({
  listing,
  owned,
  mine,
  onSubscribe,
}: {
  listing: Listing;
  owned: boolean;
  mine: boolean;
  onSubscribe: () => void;
}) {
  return (
    <Card className="flex flex-col gap-3" interactive>
      <div className="flex items-start justify-between gap-3">
        <span className="text-3xl leading-none">{listing.coverEmoji}</span>
        {listing.featured && <Badge tone="ember">featured</Badge>}
      </div>

      <div>
        <h2 className="font-display text-xl leading-snug text-ink-900">{listing.title}</h2>
        <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-500">{listing.tagline}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge tone="outline">{listing.category}</Badge>
        {listing.subscribers > 0 && <Badge tone="outline">{listing.subscribers} subscribed</Badge>}
        {listing.trialDays > 0 && <Badge tone="moss">{listing.trialDays}-day trial</Badge>}
      </div>

      <div className="mt-auto flex items-end justify-between gap-3 pt-2">
        <div>
          <p className="font-display text-2xl text-ink-900">
            {formatMoney(listing.priceMinor, listing.currency)}
          </p>
          {listing.priceMinor > 0 && (
            <p className="text-[12px] text-ink-400">
              {listing.interval === 'one_time' ? 'one-time' : `per ${listing.interval}`}
            </p>
          )}
        </div>

        {mine ? (
          <Badge tone="neutral">yours</Badge>
        ) : owned ? (
          <ButtonLink href={`/automations/${listing.automationId}`} size="sm" variant="secondary">
            Open
          </ButtonLink>
        ) : (
          <Button size="sm" onClick={onSubscribe}>
            {listing.priceMinor ? 'Subscribe' : 'Get it'}
          </Button>
        )}
      </div>
    </Card>
  );
}

/* ── checkout ─────────────────────────────────────────────────────────── */

/**
 * Pick a saved method, pay, see the receipt.
 *
 * A person with no payment method is sent to the dashboard rather than shown
 * an inline form: adding one has its own two-step flow with a code, and
 * nesting that inside a checkout dialog makes both harder to follow.
 */
function CheckoutDialog({
  listing,
  onClose,
  onDone,
}: {
  listing: Listing;
  onClose: () => void;
  onDone: () => void;
}) {
  const { user } = useAuth();
  const router = useRouter();

  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Invoice | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!user) return;
    void (async () => {
      try {
        const list = await api.listMethods(user.id);
        setMethods(list);
        setChosen(list.find((m) => m.isDefault)?.id ?? list[0]?.id ?? null);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setLoading(false);
      }
    })();
  }, [user]);

  if (!user) {
    return (
      <Shell onClose={onClose}>
        <h2 className="font-display text-2xl text-ink-900">Sign in first</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-500">
          Subscriptions belong to an account, so you’ll need one before taking this.
        </p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Not now
          </Button>
          <Button onClick={() => router.push('/sign-in?next=/marketplace')}>Sign in</Button>
        </div>
      </Shell>
    );
  }

  const pay = async () => {
    if (!chosen) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.subscribe(user.id, listing.id, chosen);
      setReceipt(res.invoice ?? null);
      setDone(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell onClose={onClose}>
      {done ? (
        <>
          <div className="flex size-11 items-center justify-center rounded-full bg-moss-100 text-lime-800">✓</div>
          <h2 className="mt-4 font-display text-2xl text-ink-900">You’re subscribed.</h2>
          <p className="mt-1 text-[14px] text-ink-500">
            {listing.title} is on your dashboard now.
          </p>

          {receipt && (
            <div className="mt-5 rounded-xl border border-sand-200 bg-sand-100/50 p-4 text-[13px]">
              <div className="flex items-center justify-between">
                <span className="text-ink-500">Receipt</span>
                <Badge tone="ember">sandbox</Badge>
              </div>
              <p className="mt-2 font-mono text-[12px] text-ink-500">{receipt.id}</p>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-ink-700">{receipt.description}</span>
                <span className="tabular font-medium text-ink-900">
                  {formatMoney(receipt.amountMinor, receipt.currency)}
                </span>
              </div>
              <p className="mt-2 text-[12px] text-ink-400">
                No money moved. This receipt exists so the flow can be tested end to end.
              </p>
            </div>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={onDone}>
              Close
            </Button>
            <Button onClick={() => router.push(`/automations/${listing.automationId}`)}>Run it</Button>
          </div>
        </>
      ) : (
        <>
          <h2 className="font-display text-2xl text-ink-900">{listing.title}</h2>
          <p className="mt-1 text-[14px] text-ink-500">{listing.tagline}</p>

          <div className="mt-4 flex items-baseline gap-2">
            <span className="font-display text-3xl text-ink-900">
              {formatMoney(listing.priceMinor, listing.currency)}
            </span>
            {listing.priceMinor > 0 && (
              <span className="text-[13px] text-ink-400">
                {listing.interval === 'one_time' ? 'one-time' : `per ${listing.interval}`}
              </span>
            )}
          </div>
          {listing.trialDays > 0 && (
            <p className="mt-1 text-[13px] text-lime-800">
              Free for {listing.trialDays} days — nothing is charged today.
            </p>
          )}

          <div className="mt-5">
            <SectionLabel>Pay with</SectionLabel>
            {loading ? (
              <div className="py-6 text-center">
                <Spinner />
              </div>
            ) : methods.length ? (
              <div className="mt-2 space-y-2">
                {methods.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => setChosen(m.id)}
                    className={cn(
                      'flex w-full items-center justify-between rounded-xl border px-3 py-2.5 text-left text-[13.5px] transition-colors',
                      chosen === m.id
                        ? 'border-ember-400 bg-ember-100/50 text-ink-900'
                        : 'border-sand-300 bg-white text-ink-700 hover:border-sand-400',
                    )}
                  >
                    <span>{m.label}</span>
                    {m.isDefault && <Badge tone="outline">default</Badge>}
                  </button>
                ))}
              </div>
            ) : (
              <p className="mt-2 rounded-xl border border-dashed border-sand-300 px-4 py-5 text-center text-[13px] text-ink-400">
                No payment method yet. Add one on the dashboard, then come back.
              </p>
            )}
          </div>

          {error && (
            <p className="mt-4 rounded-xl border border-red-200 bg-rust-100 px-3 py-2 text-[13px] text-rust-500">
              {error}
            </p>
          )}

          <div className="mt-6 flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {methods.length ? (
              <Button loading={busy} onClick={pay} disabled={!chosen}>
                {listing.trialDays > 0 ? 'Start the trial' : listing.priceMinor ? 'Pay and subscribe' : 'Subscribe'}
              </Button>
            ) : (
              <Button onClick={() => router.push('/dashboard')}>Add a payment method</Button>
            )}
          </div>
        </>
      )}
    </Shell>
  );
}

function Shell({ children, onClose }: { children: React.ReactNode; onClose: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink-900/30 p-5 backdrop-blur-sm"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98 }}
        transition={{ duration: 0.22 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md rounded-[20px] border border-sand-200 bg-white p-6 shadow-xl"
      >
        {children}
      </motion.div>
    </motion.div>
  );
}

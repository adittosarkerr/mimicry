'use client';

import { useCallback, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { Invoice, PaymentMethod } from '@mimic/schema';
import {
  api,
  formatMoney,
  type AccountState,
  type Gateway,
  type SubscriptionWithListing,
} from '@/lib/api';
import { Badge, Button, Card, SectionLabel, Spinner } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * Everything to do with money — none of which is real.
 *
 * The sandbox notice is repeated at the top of the panel and on the receipt
 * rather than tucked into a footnote, because the one thing this screen must
 * never do is let somebody believe a payment happened.
 */

export function BillingPanel({
  userId,
  account,
  subscriptions,
  onChanged,
}: {
  userId: string;
  account: AccountState | null;
  subscriptions: SubscriptionWithListing[];
  onChanged: () => void;
}) {
  const [methods, setMethods] = useState<PaymentMethod[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [gateways, setGateways] = useState<Gateway[]>([]);
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [m, i, g] = await Promise.all([
        api.listMethods(userId),
        api.listInvoices(userId),
        api.gateways(),
      ]);
      setMethods(m);
      setInvoices(i);
      setGateways(g.gateways);
      setNotice(g.notice);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex justify-center py-16">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="space-y-10">
      <p className="rounded-xl border border-ember-200 bg-ember-100/60 px-4 py-3 text-[13px] leading-relaxed text-ember-700">
        <span className="font-semibold">Sandbox.</span> {notice}
      </p>

      {error && (
        <p className="rounded-xl border border-red-200 bg-rust-100 px-4 py-3 text-[13px] text-rust-500">{error}</p>
      )}

      {/* ── plan ────────────────────────────────────────────────────────── */}
      <section>
        <SectionLabel>Plan</SectionLabel>
        <div className="mt-3 grid gap-4 sm:grid-cols-3">
          {Object.entries(account?.plans ?? {}).map(([key, plan]) => {
            const current = account?.quota.plan === key;
            return (
              <Card key={key} className={cn(current && 'border-ember-300 ring-2 ring-ember-500/15')}>
                <div className="flex items-center justify-between">
                  <p className="font-display text-xl text-ink-900">{plan.label}</p>
                  {current && <Badge tone="ember">current</Badge>}
                </div>
                <p className="mt-1 font-display text-2xl text-ink-900">
                  {plan.priceMinor ? formatMoney(plan.priceMinor) : 'Free'}
                  {plan.priceMinor > 0 && <span className="text-[13px] text-ink-400"> /month</span>}
                </p>
                <ul className="mt-3 space-y-1 text-[13px] text-ink-500">
                  <li>{plan.runsPerDay.toLocaleString()} runs a day</li>
                  <li>{plan.automations.toLocaleString()} automations</li>
                </ul>
              </Card>
            );
          })}
        </div>
        {account && !account.quota.enforced && (
          <p className="mt-3 text-[12.5px] text-ink-400">
            Limits are being counted but not applied — the free plan’s {account.plans.free?.runsPerDay} runs a
            day switch on when <code className="font-mono">MIMIC_ENFORCE_QUOTA=1</code> is set on the runner.
          </p>
        )}
      </section>

      {/* ── methods ─────────────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between">
          <SectionLabel>Payment methods</SectionLabel>
          <Button size="sm" variant="secondary" onClick={() => setAdding((v) => !v)}>
            {adding ? 'Cancel' : 'Add a method'}
          </Button>
        </div>

        <AnimatePresence initial={false}>
          {adding && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden"
            >
              <AddMethodForm
                userId={userId}
                gateways={gateways}
                onDone={() => {
                  setAdding(false);
                  void load();
                }}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {methods.length ? (
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {methods.map((m) => (
              <Card key={m.id} className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink-900">{m.label}</p>
                  <p className="text-[12.5px] text-ink-400">
                    {m.expiry ? `Expires ${m.expiry} · ` : ''}Added {new Date(m.createdAt).toLocaleDateString()}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {m.isDefault ? (
                    <Badge tone="moss">default</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await api.setDefaultMethod(userId, m.id);
                        void load();
                      }}
                    >
                      Make default
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-rust-500 hover:bg-rust-100"
                    onClick={async () => {
                      await api.removeMethod(userId, m.id);
                      void load();
                    }}
                  >
                    Remove
                  </Button>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          !adding && (
            <p className="mt-4 rounded-xl border border-dashed border-sand-300 px-4 py-6 text-center text-[13.5px] text-ink-400">
              No payment methods yet. You need one to subscribe to anything in the marketplace.
            </p>
          )
        )}
      </section>

      {/* ── subscriptions ───────────────────────────────────────────────── */}
      <section>
        <SectionLabel>Subscriptions</SectionLabel>
        {subscriptions.length ? (
          <div className="mt-3 space-y-3">
            {subscriptions.map((s) => (
              <Card key={s.id} className="flex flex-wrap items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-medium text-ink-900">
                    {s.listing?.coverEmoji} {s.listing?.title ?? 'A removed listing'}
                  </p>
                  <p className="text-[12.5px] text-ink-400">
                    {s.cancelAtPeriodEnd ? 'Ends' : 'Renews'} {new Date(s.currentPeriodEnd).toLocaleDateString()}
                    {s.listing ? ` · ${formatMoney(s.listing.priceMinor, s.listing.currency)}` : ''}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={s.status === 'active' ? 'moss' : s.status === 'trialing' ? 'ember' : 'neutral'}>
                    {s.cancelAtPeriodEnd ? 'cancelling' : s.status}
                  </Badge>
                  {!s.cancelAtPeriodEnd && s.status !== 'cancelled' && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await api.cancelSubscription(userId, s.id);
                        onChanged();
                      }}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <p className="mt-3 rounded-xl border border-dashed border-sand-300 px-4 py-6 text-center text-[13.5px] text-ink-400">
            Nothing subscribed yet.
          </p>
        )}
      </section>

      {/* ── receipts ────────────────────────────────────────────────────── */}
      <section>
        <SectionLabel>Receipts</SectionLabel>
        {invoices.length ? (
          <div className="mt-3 overflow-x-auto rounded-[18px] border border-sand-200 bg-white/60">
            <table className="w-full min-w-[520px] text-left text-[13.5px]">
              <thead className="border-b border-sand-200 text-[12px] uppercase tracking-[0.08em] text-ink-400">
                <tr>
                  <th className="px-4 py-3 font-medium">Description</th>
                  <th className="px-4 py-3 font-medium">Amount</th>
                  <th className="px-4 py-3 font-medium">Status</th>
                  <th className="px-4 py-3 font-medium">Date</th>
                </tr>
              </thead>
              <tbody>
                {invoices.map((i) => (
                  <tr key={i.id} className="border-b border-sand-100 last:border-0">
                    <td className="px-4 py-3 text-ink-800">
                      {i.description}
                      <span className="ml-2 text-[11px] uppercase tracking-wide text-ink-400">sandbox</span>
                    </td>
                    <td className="px-4 py-3 tabular text-ink-800">{formatMoney(i.amountMinor, i.currency)}</td>
                    <td className="px-4 py-3">
                      <Badge tone={i.status === 'paid' ? 'moss' : i.status === 'failed' ? 'rust' : 'neutral'}>
                        {i.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-ink-500">{new Date(i.createdAt).toLocaleDateString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="mt-3 rounded-xl border border-dashed border-sand-300 px-4 py-6 text-center text-[13.5px] text-ink-400">
            No receipts yet.
          </p>
        )}
      </section>
    </div>
  );
}

/* ── adding a method ──────────────────────────────────────────────────── */

/**
 * Two steps, like the real thing: choose a wallet or card, then confirm the
 * code. The code is displayed rather than sent, because there is no phone at
 * the other end and pretending otherwise would leave the flow untestable.
 */
function AddMethodForm({
  userId,
  gateways,
  onDone,
}: {
  userId: string;
  gateways: Gateway[];
  onDone: () => void;
}) {
  const [kind, setKind] = useState(gateways[0]?.kind ?? 'bkash');
  const [account, setAccount] = useState('');
  const [expiry, setExpiry] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [issuedCode, setIssuedCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const gateway = gateways.find((g) => g.kind === kind);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.startAddMethod(userId, kind);
      if (res.challengeId) {
        setChallengeId(res.challengeId);
        setIssuedCode(res.code);
      } else {
        // Bank transfer has nothing to confirm.
        await finish(null);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const finish = async (withChallenge: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await api.addMethod(userId, {
        kind,
        account,
        expiry: expiry || undefined,
        challengeId: withChallenge,
        code,
      });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="mt-4">
      <div className="flex flex-wrap gap-2">
        {gateways.map((g) => (
          <button
            key={g.kind}
            onClick={() => {
              setKind(g.kind);
              setChallengeId(null);
              setIssuedCode(null);
            }}
            className={cn(
              'rounded-xl border px-3 py-2 text-[13px] font-medium transition-colors',
              kind === g.kind
                ? 'border-transparent text-white'
                : 'border-sand-300 bg-white text-ink-700 hover:border-sand-400',
            )}
            style={kind === g.kind ? { backgroundColor: g.brandColor } : undefined}
          >
            {g.label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5">
          <span className="text-[13px] font-medium text-ink-700">
            {kind === 'card' ? 'Card number' : kind === 'bank' ? 'Account number' : 'Wallet number'}
          </span>
          <input
            value={account}
            onChange={(e) => setAccount(e.target.value)}
            placeholder={gateway?.accountHint}
            inputMode="numeric"
            className="input"
            disabled={Boolean(challengeId)}
          />
          <span className="text-[12px] text-ink-400">
            Only the last four digits are stored. Use one ending 0000 to see a declined payment.
          </span>
        </label>

        {kind === 'card' && (
          <label className="flex flex-col gap-1.5">
            <span className="text-[13px] font-medium text-ink-700">Expiry</span>
            <input
              value={expiry}
              onChange={(e) => setExpiry(e.target.value)}
              placeholder="09/29"
              className="input"
              disabled={Boolean(challengeId)}
            />
          </label>
        )}
      </div>

      {challengeId && (
        <div className="mt-4 rounded-xl border border-sand-300 bg-sand-100/60 p-4">
          <p className="text-[13px] text-ink-700">
            {gateway?.label} would text you a code. There is no real phone here, so it is:{' '}
            <span className="font-mono text-base font-semibold text-ink-900">{issuedCode}</span>
          </p>
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Enter the 6-digit code"
            inputMode="numeric"
            className="input mt-3 max-w-[220px]"
          />
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-xl border border-red-200 bg-rust-100 px-3 py-2 text-[13px] text-rust-500">
          {error}
        </p>
      )}

      <div className="mt-4 flex gap-2">
        {challengeId ? (
          <Button loading={busy} onClick={() => finish(challengeId)}>
            Confirm and save
          </Button>
        ) : (
          <Button loading={busy} onClick={start} disabled={account.replace(/\D/g, '').length < 4}>
            Continue
          </Button>
        )}
      </div>
    </Card>
  );
}

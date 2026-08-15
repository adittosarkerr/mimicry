'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'motion/react';
import type { Run } from '@mimic/schema';
import { useAuth } from '@/lib/auth-context';
import {
  api,
  formatMoney,
  type AccountState,
  type AutomationSummary,
  type SubscriptionWithListing,
} from '@/lib/api';
import { Badge, Button, ButtonLink, Card, EmptyState, SectionLabel, Spinner } from '@/components/ui';
import { BillingPanel } from '@/components/dashboard/billing-panel';
import { PublishDialog } from '@/components/dashboard/publish-dialog';
import { cn } from '@/lib/utils';

type Tab = 'automations' | 'runs' | 'billing';

export function Dashboard() {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const [tab, setTab] = useState<Tab>('automations');
  const [automations, setAutomations] = useState<AutomationSummary[]>([]);
  const [unclaimed, setUnclaimed] = useState<AutomationSummary[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  const [account, setAccount] = useState<AccountState | null>(null);
  const [subs, setSubs] = useState<SubscriptionWithListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [publishing, setPublishing] = useState<AutomationSummary | null>(null);

  useEffect(() => {
    if (!authLoading && !user) router.replace('/sign-in?next=/dashboard');
  }, [authLoading, user, router]);

  const load = useCallback(async () => {
    if (!user) return;
    setLoading(true);
    setError(null);
    try {
      const [everything, recent, me, subscriptions] = await Promise.all([
        api.listAutomations(),
        api.listRuns(undefined, 25),
        api.me(user.id),
        api.listSubscriptions(user.id).catch(() => [] as SubscriptionWithListing[]),
      ]);

      /* The extension has no idea who is signed in — it talks to the runner,
         not the browser session — so a recording arrives with no owner. Rather
         than making people paste a user id into the extension, anything
         unclaimed on this runner is offered here to be adopted. */
      setAutomations(everything.filter((a) => a.ownerId === user.id));
      setUnclaimed(everything.filter((a) => !a.ownerId));
      setRuns(recent);
      setAccount(me);
      setSubs(subscriptions);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [user]);

  useEffect(() => {
    void load();
  }, [load]);

  /* Keep the account record in step with whoever is signed in, so the runner
     can attribute runs and show the right plan without a session layer. */
  useEffect(() => {
    if (user) void api.saveProfile(user.id, { email: user.email, displayName: user.displayName }).catch(() => {});
  }, [user]);

  if (authLoading || !user) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const succeeded = runs.filter((r) => r.status === 'succeeded').length;
  const totalRuns = automations.reduce((sum, a) => sum + a.stats.runs, 0);

  return (
    <div className="mx-auto max-w-6xl px-5 py-12">
      <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.45 }}>
        <SectionLabel>Dashboard</SectionLabel>
        <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
          <h1 className="font-display text-[clamp(2rem,4.5vw,3rem)] leading-tight text-ink-900">
            {user.displayName ? `Hello, ${user.displayName}.` : 'Your automations.'}
          </h1>
          <div className="flex gap-2">
            <ButtonLink href="/voice" variant="secondary" size="sm">
              Ask by voice
            </ButtonLink>
            <ButtonLink href="/marketplace" size="sm">
              Browse marketplace
            </ButtonLink>
          </div>
        </div>
      </motion.div>

      {/* ── the numbers ─────────────────────────────────────────────────── */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Automations" value={automations.length} />
        <Stat label="Runs, all time" value={totalRuns} />
        <Stat label="Recent successes" value={`${succeeded}/${runs.length}`} />
        <UsageStat account={account} />
      </div>

      <nav className="mt-10 flex gap-1 border-b border-sand-200">
        {(['automations', 'runs', 'billing'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={cn(
              'relative px-4 py-2.5 text-[14px] font-medium capitalize transition-colors',
              tab === t ? 'text-ink-900' : 'text-ink-400 hover:text-ink-700',
            )}
          >
            {t}
            {tab === t && (
              <motion.span
                layoutId="dash-tab"
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-ember-500"
              />
            )}
          </button>
        ))}
      </nav>

      {error && (
        <p className="mt-6 rounded-xl border border-red-200 bg-rust-100 px-4 py-3 text-[13px] text-rust-500">
          {error}
        </p>
      )}

      {loading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : (
        <div className="mt-8">
          {tab === 'automations' && (
            <>
              {unclaimed.length > 0 && (
                <UnclaimedList automations={unclaimed} userId={user.id} onClaimed={load} />
              )}
              <AutomationList
                automations={automations}
                userId={user.id}
                onPublish={setPublishing}
                onChanged={load}
              />
            </>
          )}
          {tab === 'runs' && <RunList runs={runs} automations={automations} />}
          {tab === 'billing' && (
            <BillingPanel
              userId={user.id}
              account={account}
              subscriptions={subs}
              onChanged={load}
            />
          )}
        </div>
      )}

      {publishing && (
        <PublishDialog
          automation={publishing}
          userId={user.id}
          sellerName={user.displayName ?? user.email}
          onClose={() => setPublishing(null)}
          onPublished={() => {
            setPublishing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

/* ── pieces ───────────────────────────────────────────────────────────── */

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <Card>
      <p className="text-[12px] font-medium uppercase tracking-[0.1em] text-ink-400">{label}</p>
      <p className="mt-2 font-display text-3xl text-ink-900 tabular">{value}</p>
    </Card>
  );
}

/**
 * Today's usage against the plan.
 *
 * Shown even when the cap isn't being enforced, and says so — a number that
 * silently means nothing is worse than no number, and this is the one place
 * somebody would look to find out whether the limit is on.
 */
function UsageStat({ account }: { account: AccountState | null }) {
  if (!account) return <Stat label="Today" value="—" />;
  const { used, limit, planLabel, enforced } = account.quota;
  const pct = Math.min(100, Math.round((used / Math.max(1, limit)) * 100));

  return (
    <Card>
      <p className="text-[12px] font-medium uppercase tracking-[0.1em] text-ink-400">
        Today · {planLabel}
      </p>
      <p className="mt-2 font-display text-3xl text-ink-900 tabular">
        {used}
        <span className="text-lg text-ink-400">/{limit}</span>
      </p>
      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-sand-200">
        <div
          className={cn('h-full rounded-full transition-[width] duration-500', pct >= 100 ? 'bg-rust-500' : 'bg-ember-500')}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!enforced && (
        <p className="mt-2 text-[11.5px] leading-snug text-ink-400">
          Counting only — the daily limit isn’t being applied yet.
        </p>
      )}
    </Card>
  );
}

/**
 * Recordings on this runner that belong to nobody yet.
 *
 * Shown separately and only until adopted, so a shared development runner
 * doesn't quietly hand one person's recordings to whoever signs in next —
 * claiming is a deliberate act, not a side effect of loading the page.
 */
function UnclaimedList({
  automations,
  userId,
  onClaimed,
}: {
  automations: AutomationSummary[];
  userId: string;
  onClaimed: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);

  return (
    <section className="mb-8 rounded-[18px] border border-dashed border-ember-300 bg-ember-100/30 p-5">
      <SectionLabel>Unclaimed recordings</SectionLabel>
      <p className="mt-1 text-[13px] text-ink-500">
        Recorded with the extension before you signed in. Claim one to keep it on your account.
      </p>
      <div className="mt-4 space-y-2">
        {automations.map((a) => (
          <div key={a.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-white/70 px-3 py-2">
            <span>{a.emoji}</span>
            <span className="min-w-0 flex-1 truncate text-[13.5px] text-ink-800">{a.name}</span>
            <Badge tone="outline">{a.site}</Badge>
            <Button
              size="sm"
              variant="secondary"
              loading={busy === a.id}
              onClick={async () => {
                setBusy(a.id);
                await api.updateAutomation(a.id, { ownerId: userId }).catch(() => {});
                setBusy(null);
                onClaimed();
              }}
            >
              Claim
            </Button>
          </div>
        ))}
      </div>
    </section>
  );
}

function AutomationList({
  automations,
  userId,
  onPublish,
  onChanged,
}: {
  automations: AutomationSummary[];
  userId: string;
  onPublish: (a: AutomationSummary) => void;
  onChanged: () => void;
}) {
  const [removing, setRemoving] = useState<string | null>(null);

  if (!automations.length) {
    return (
      <EmptyState
        title="Nothing recorded yet"
        body="Record a task with the extension, or just say what you need and Mimic will build the automation for you."
        action={<ButtonLink href="/voice">Say what you need</ButtonLink>}
      />
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {automations.map((a) => (
        <Card key={a.id} className="flex flex-col gap-3">
          <div className="flex items-start gap-3">
            <span className="text-2xl leading-none">{a.emoji}</span>
            <div className="min-w-0 flex-1">
              <Link href={`/automations/${a.id}`} className="font-display text-xl leading-snug text-ink-900 hover:underline">
                {a.name}
              </Link>
              <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed text-ink-500">{a.description}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="outline">{a.site}</Badge>
            <Badge tone="outline">{a.schema.fields.length} fields</Badge>
            {a.stats.runs > 0 && (
              <Badge tone={a.stats.successes > 0 ? 'moss' : 'rust'}>
                {a.stats.successes}/{a.stats.runs} succeeded
              </Badge>
            )}
            {a.listingId && <Badge tone="ember">published</Badge>}
            {a.refining && <Badge tone="ember">refining…</Badge>}
          </div>

          <div className="mt-auto flex flex-wrap gap-2 pt-1">
            <ButtonLink href={`/automations/${a.id}`} size="sm" variant="secondary">
              Open
            </ButtonLink>
            {a.listingId ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={async () => {
                  if (!confirm(`Take “${a.name}” off the marketplace? Existing subscribers keep it.`)) return;
                  await api.unpublishListing(userId, a.listingId!).catch(() => {});
                  await api.updateAutomation(a.id, { visibility: 'private' }).catch(() => {});
                  onChanged();
                }}
              >
                Unpublish
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => onPublish(a)}>
                Publish
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              loading={removing === a.id}
              onClick={async () => {
                if (!confirm(`Delete “${a.name}”? Its run history goes too.`)) return;
                setRemoving(a.id);
                await api.deleteAutomation(a.id).catch(() => {});
                setRemoving(null);
                onChanged();
              }}
              className="text-rust-500 hover:bg-rust-100"
            >
              Delete
            </Button>
          </div>
        </Card>
      ))}
    </div>
  );
}

function RunList({ runs, automations }: { runs: Run[]; automations: AutomationSummary[] }) {
  if (!runs.length) {
    return <EmptyState title="No runs yet" body="Run an automation and its history shows up here." />;
  }

  const nameOf = (id: string) => automations.find((a) => a.id === id)?.name ?? id;

  return (
    <div className="overflow-x-auto rounded-[18px] border border-sand-200 bg-white/60">
      <table className="w-full min-w-[560px] text-left text-[13.5px]">
        <thead className="border-b border-sand-200 text-[12px] uppercase tracking-[0.08em] text-ink-400">
          <tr>
            <th className="px-4 py-3 font-medium">Automation</th>
            <th className="px-4 py-3 font-medium">Status</th>
            <th className="px-4 py-3 font-medium">Results</th>
            <th className="px-4 py-3 font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.id} className="border-b border-sand-100 last:border-0">
              <td className="px-4 py-3">
                <Link href={`/automations/${r.automationId}`} className="text-ink-800 hover:underline">
                  {nameOf(r.automationId)}
                </Link>
              </td>
              <td className="px-4 py-3">
                <Badge tone={r.status === 'succeeded' ? 'moss' : r.status === 'failed' ? 'rust' : 'neutral'}>
                  {r.status}
                </Badge>
              </td>
              <td className="px-4 py-3 tabular text-ink-500">{r.output?.items?.length ?? 0}</td>
              <td className="px-4 py-3 text-ink-500">{new Date(r.startedAt).toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

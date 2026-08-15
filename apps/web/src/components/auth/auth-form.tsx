'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { useAuth } from '@/lib/auth-context';
import { Button, Card } from '@/components/ui';

/**
 * One form, two modes.
 *
 * Sign-in and sign-up differ by a single field and a verb, and keeping them in
 * one component keeps the error handling, the local-account notice and the
 * redirect behaviour identical between them — which is what people actually
 * notice when they get one wrong and are bounced to the other.
 */

export function AuthForm({ mode }: { mode: 'sign-in' | 'sign-up' }) {
  const router = useRouter();
  const params = useSearchParams();
  const { signIn, signUp, user, isLocal, loading } = useAuth();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const next = params.get('next') || '/dashboard';
  const signingUp = mode === 'sign-up';

  // Already signed in — nothing to do here.
  useEffect(() => {
    if (!loading && user) router.replace(next);
  }, [loading, user, next, router]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (signingUp) await signUp(email, password, displayName.trim() || undefined);
      else await signIn(email, password);
      router.push(next);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex min-h-[70vh] max-w-md flex-col justify-center px-5 py-16">
      <motion.div initial={{ opacity: 0, y: 14 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5 }}>
        <h1 className="font-display text-[clamp(2rem,5vw,2.75rem)] leading-tight text-ink-900">
          {signingUp ? 'Create your account.' : 'Welcome back.'}
        </h1>
        <p className="mt-3 text-[15px] leading-relaxed text-ink-500">
          {signingUp
            ? 'Automations, runs and billing all live under your account.'
            : 'Sign in to reach your automations and their run history.'}
        </p>

        <Card className="mt-8">
          <form onSubmit={submit} className="space-y-4">
            {signingUp && (
              <Field label="Name" hint="Shown on anything you publish.">
                <input
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  autoComplete="name"
                  placeholder="Your name"
                  className="input"
                />
              </Field>
            )}

            <Field label="Email">
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                placeholder="you@example.com"
                className="input"
              />
            </Field>

            <Field label="Password" hint={signingUp ? 'At least 8 characters.' : undefined}>
              <input
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={signingUp ? 'new-password' : 'current-password'}
                placeholder="••••••••"
                className="input"
              />
            </Field>

            {error && (
              <p role="alert" className="rounded-xl border border-red-200 bg-rust-100 px-3 py-2 text-[13px] text-rust-500">
                {error}
              </p>
            )}

            <Button type="submit" size="lg" loading={busy} className="w-full">
              {signingUp ? 'Create account' : 'Sign in'}
            </Button>
          </form>
        </Card>

        <p className="mt-5 text-center text-[13px] text-ink-500">
          {signingUp ? 'Already have an account? ' : 'No account yet? '}
          <Link
            href={signingUp ? '/sign-in' : '/sign-up'}
            className="font-medium text-ember-600 underline underline-offset-2"
          >
            {signingUp ? 'Sign in' : 'Create one'}
          </Link>
        </p>

        {/* Never let a local development account look like a real one. */}
        {isLocal && (
          <p className="mt-6 rounded-xl border border-sand-300 bg-sand-100/60 px-4 py-3 text-[12.5px] leading-relaxed text-ink-500">
            <span className="font-medium text-ink-700">Local account.</span> Supabase isn’t
            configured, so this account is stored in this browser only — it isn’t secure and it
            won’t exist on another device. Set <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code>{' '}
            and <code className="font-mono">NEXT_PUBLIC_SUPABASE_ANON_KEY</code> to use real accounts.
          </p>
        )}
      </motion.div>
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-ink-700">{label}</span>
      {children}
      {hint && <span className="text-[12px] text-ink-400">{hint}</span>}
    </label>
  );
}

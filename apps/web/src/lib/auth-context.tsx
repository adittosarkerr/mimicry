'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { getSupabase, supabaseConfigured } from './supabase';

/**
 * Auth with two backends.
 *
 * With Supabase credentials present, this is a thin wrapper over Supabase auth.
 * Without them it falls back to a local, browser-only account store so the
 * dashboard, marketplace, and payment flows are all reachable during
 * development. The stub never pretends to be secure — it says so in the UI.
 */

export interface MimicUser {
  id: string;
  email: string;
  displayName?: string;
  createdAt: number;
}

interface AuthValue {
  user: MimicUser | null;
  loading: boolean;
  /** True when running on the local stub rather than Supabase. */
  isLocal: boolean;
  signUp: (email: string, password: string, displayName?: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

const STORE_KEY = 'mimic:local-users';
const SESSION_KEY = 'mimic:local-session';

interface LocalRecord {
  id: string;
  email: string;
  displayName?: string;
  passwordHash: string;
  createdAt: number;
}

async function hash(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(`mimic::${input}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

const readUsers = (): LocalRecord[] => {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? '[]') as LocalRecord[];
  } catch {
    return [];
  }
};

const writeUsers = (users: LocalRecord[]) => localStorage.setItem(STORE_KEY, JSON.stringify(users));

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<MimicUser | null>(null);
  const [loading, setLoading] = useState(true);
  const supabase = supabaseConfigured ? getSupabase() : null;

  // Restore whichever session exists.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      if (supabase) {
        /* A leftover from before this project had Supabase keys.
           The stub's session is not an account here, and leaving it in storage
           means the app half-believes somebody is signed in — the header shows
           their name while every API call is anonymous. */
        localStorage.removeItem(SESSION_KEY);

        const { data } = await supabase.auth.getSession();
        if (!cancelled && data.session?.user) {
          const u = data.session.user;
          setUser({
            id: u.id,
            email: u.email ?? '',
            displayName: (u.user_metadata?.display_name as string) ?? undefined,
            createdAt: Date.parse(u.created_at ?? '') || Date.now(),
          });
        }
        setLoading(false);

        const { data: sub } = supabase.auth.onAuthStateChange((_evt, session) => {
          const su = session?.user;
          setUser(
            su
              ? {
                  id: su.id,
                  email: su.email ?? '',
                  displayName: (su.user_metadata?.display_name as string) ?? undefined,
                  createdAt: Date.parse(su.created_at ?? '') || Date.now(),
                }
              : null,
          );
        });
        return () => sub.subscription.unsubscribe();
      }

      try {
        const raw = localStorage.getItem(SESSION_KEY);
        if (raw && !cancelled) setUser(JSON.parse(raw) as MimicUser);
      } catch {
        /* corrupt session — ignore */
      }
      setLoading(false);
      return undefined;
    })();

    return () => {
      cancelled = true;
    };
  }, [supabase]);

  const signUp = useCallback(
    async (email: string, password: string, displayName?: string) => {
      const clean = email.trim().toLowerCase();
      if (!clean.includes('@')) throw new Error('That email address does not look right.');
      if (password.length < 8) throw new Error('Use at least 8 characters for your password.');

      if (supabase) {
        const { error } = await supabase.auth.signUp({
          email: clean,
          password,
          options: { data: { display_name: displayName } },
        });
        if (error) throw new Error(error.message);
        return;
      }

      const users = readUsers();
      if (users.some((u) => u.email === clean)) {
        throw new Error('An account with that email already exists on this device.');
      }
      const record: LocalRecord = {
        id: `usr_${crypto.randomUUID().slice(0, 12)}`,
        email: clean,
        displayName,
        passwordHash: await hash(password),
        createdAt: Date.now(),
      };
      writeUsers([...users, record]);

      const session: MimicUser = {
        id: record.id,
        email: record.email,
        displayName: record.displayName,
        createdAt: record.createdAt,
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      setUser(session);
    },
    [supabase],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      const clean = email.trim().toLowerCase();

      if (supabase) {
        const { error } = await supabase.auth.signInWithPassword({ email: clean, password });
        if (error) throw new Error(error.message);
        return;
      }

      const record = readUsers().find((u) => u.email === clean);
      const attempted = await hash(password);
      if (!record || record.passwordHash !== attempted) {
        throw new Error('That email and password do not match an account on this device.');
      }
      const session: MimicUser = {
        id: record.id,
        email: record.email,
        displayName: record.displayName,
        createdAt: record.createdAt,
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      setUser(session);
    },
    [supabase],
  );

  const signOut = useCallback(async () => {
    if (supabase) await supabase.auth.signOut();
    localStorage.removeItem(SESSION_KEY);
    setUser(null);
  }, [supabase]);

  const value = useMemo<AuthValue>(
    () => ({ user, loading, isLocal: !supabaseConfigured, signUp, signIn, signOut }),
    [user, loading, signUp, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

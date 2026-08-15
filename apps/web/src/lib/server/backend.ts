import { createClient } from '@supabase/supabase-js';
import {
  createBilling,
  createQuota,
  createLibrary,
  supabaseStoreFromEnv,
  type Store,
} from '@mimic/core';

/**
 * The site's own backend, for everything that does not need a browser.
 *
 * Mimicry's runner drives a real Chromium, so it cannot live on Vercel — but
 * almost nothing on the dashboard needs one. Accounts, saved automations, the
 * marketplace, the payment sandbox and the daily allowance are all records and
 * rules about them, and a deployed site that answers "Failed to fetch" to every
 * one of those is broken in a way that has nothing to do with browsers.
 *
 * So the site can serve them itself, from Supabase, using the same rules the
 * runner applies. The runner is still preferred when it is reachable — it is
 * the one that can actually run things — and this takes over only when it is
 * not. Locally, where the runner is always up, none of this is ever reached.
 */

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const store: Store | null = supabaseStoreFromEnv(
  process.env as Record<string, string | undefined>,
);

/**
 * Why this backend cannot answer, in terms the reader can act on.
 *
 * Two keys are needed and they come from different places in the Supabase
 * dashboard, so "not configured" is not specific enough to fix.
 */
export function unavailableReason(): string {
  if (!url || !anonKey) {
    return 'This site has no Supabase project connected, so there is nowhere to keep accounts or automations. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, then redeploy.';
  }
  return 'This site can sign people in but has no server key to read or write their data with. Set SUPABASE_SERVICE_ROLE_KEY (Supabase → Project Settings → API → service_role) and redeploy. Keep it server-side — it bypasses row-level security.';
}

export const billing = store ? createBilling(store) : null;
export const library = store ? createLibrary(store) : null;

/**
 * The daily allowance.
 *
 * Enforced here unless explicitly switched off, matching the runner's default.
 * A cap that applies on one deployment and not the other is not a cap.
 */
export const quota = store
  ? createQuota(store, { enforce: process.env.MIMIC_ENFORCE_QUOTA !== '0' })
  : null;

/**
 * Who is asking.
 *
 * The access token is verified against Supabase rather than trusted, because
 * this backend writes payment records and a user id in a header is something
 * anyone can type. `x-mimic-user` is still accepted when no Supabase project is
 * connected at all — that is the local stub, where there are no real accounts
 * to impersonate and the runner is doing the work anyway.
 */
export async function userIdFrom(req: Request): Promise<string | null> {
  const bearer = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '');

  if (bearer && url && anonKey) {
    const auth = createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data } = await auth.auth.getUser(bearer);
    return data.user?.id ?? null;
  }

  if (!url || !anonKey) return req.headers.get('x-mimic-user');
  return null;
}

import type {
  Automation,
  FormSchema,
  Invoice,
  Listing,
  PaymentMethod,
  Run,
  RunEvent,
  Subscription,
  UserProfile,
} from '@mimic/schema';
import { getSupabase } from './supabase';

/**
 * Client for the Mimic runner. Everything the web app knows about automations
 * and runs comes through here.
 *
 * The runner is asked first, always — it is the one that can actually do
 * things. When there is no runner to ask, requests that do not need a browser
 * fall through to this site's own API routes, which apply the same rules
 * against the same records. That fallback is what makes a deployment without a
 * runner a usable site rather than a page of "Failed to fetch".
 */

export const RUNNER_URL = process.env.NEXT_PUBLIC_RUNNER_URL || 'http://localhost:8787';
export const RUNNER_WS = process.env.NEXT_PUBLIC_RUNNER_WS || 'ws://localhost:8787';

/** Automation without the (heavy) trace, which the list and detail views never need. */
export type AutomationSummary = Omit<Automation, 'trace'> & {
  stepCount: number;
  startUrl?: string;
  finalUrl?: string;
};

/**
 * Why the runner could not be reached, in terms the reader can act on.
 *
 * "Failed to fetch" is what the browser says and it explains nothing. The two
 * real causes have completely different fixes, and both are detectable from
 * here: a deployed site still pointing at localhost was never given the
 * runner's address, and a reachable-looking address that refuses the request
 * is usually CORS.
 */
export function runnerUnreachable(): string {
  const local = /localhost|127\.0\.0\.1/.test(RUNNER_URL);
  const deployed = typeof window !== 'undefined' && !/localhost|127\.0\.0\.1/.test(window.location.host);

  if (deployed && local) {
    return `Those need a runner — a long-lived server with a real browser on it — and this site has not been told where one is. It is currently looking at ${RUNNER_URL}, which is your own machine rather than a server. Deploy the runner (see DEPLOYING.md), then set NEXT_PUBLIC_RUNNER_URL and NEXT_PUBLIC_RUNNER_WS and redeploy. Everything else on this site works without one.`;
  }
  if (local) {
    return `Can't reach the Mimic runner at ${RUNNER_URL}. Start it with \`npm run dev:runner\`.`;
  }
  return `Can't reach the Mimic runner at ${RUNNER_URL}. It may still be starting — a cold start boots a browser and takes a few seconds. If it persists, check the runner is running and that this site's domain is in its RUNNER_CORS list.`;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * The few things only the runner can serve.
 *
 * Everything else the site can answer for itself — including running an
 * automation, which happens in a serverless function with a Chromium built for
 * one. What is left are the two that stream bytes it does not hold (a
 * screenshot on the runner's own disk, an image proxied from a scraped site),
 * the debug extractor, and its bare `/health`, which has no counterpart here.
 */
const NEEDS_THE_RUNNER = [/^\/api\/screenshots/, /^\/api\/image/, /^\/api\/debug/, /^\/health$/];

/**
 * Whether the runner answered last time we tried.
 *
 * Remembered so a deployment without one does not spend a failed request per
 * call working it out again — and re-checked on a real reply, because a runner
 * that was asleep and has woken up should be used.
 */
let runnerReachable: boolean | null = null;

/**
 * The signed-in person's Supabase token, when there is one.
 *
 * Sent to this site's own API routes only. They verify it rather than trusting
 * it — those routes write payment records, and a user id in a header is
 * something anyone can type. The runner uses the simpler header because it is
 * the thing being run on your own machine.
 */
async function accessToken(): Promise<string | null> {
  const supabase = getSupabase();
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = { 'content-type': 'application/json', ...(init?.headers ?? {}) };
  const runnerOnly = NEEDS_THE_RUNNER.some((re) => re.test(path));

  let res: Response | null = null;

  if (runnerReachable !== false || runnerOnly) {
    try {
      res = await fetch(`${RUNNER_URL}${path}`, { ...init, headers, cache: 'no-store' });
      runnerReachable = true;
    } catch {
      runnerReachable = false;
      if (runnerOnly) throw new ApiError(runnerUnreachable(), 0);
    }
  }

  /* No runner, and this is something the site can answer for itself. Same
     path, same body, same shapes — the only difference is who replies. */
  if (!res) {
    const token = await accessToken();
    try {
      res = await fetch(path, {
        ...init,
        headers: token ? { ...headers, authorization: `Bearer ${token}` } : headers,
        cache: 'no-store',
      });
    } catch {
      throw new ApiError(runnerUnreachable(), 0);
    }
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; missing?: string[] };
    throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () =>
    request<{ ok: boolean; ai: string; headless: boolean; activeRuns: number }>('/health'),

  /**
   * What this backend can actually do, whichever one answers.
   *
   * Asked before someone speaks rather than after: Brave ships the Web Speech
   * API and blocks the backend it needs, so without this the failure only
   * appears once they have already said their piece.
   */
  capabilities: () =>
    request<{
      ok: boolean;
      ai: string | false;
      stt: string | false;
      browser: boolean;
      /** 'files' on a runner, 'supabase' on either, 'none' when unconfigured. */
      store: 'files' | 'supabase' | 'none';
    }>('/api/health'),

  listAutomations: (ownerId?: string) =>
    request<AutomationSummary[]>(`/api/automations${ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : ''}`),

  getAutomation: (id: string) => request<AutomationSummary>(`/api/automations/${id}`),

  updateAutomation: (
    id: string,
    patch: Partial<{ name: string; description: string; visibility: string; ownerId: string; schema: FormSchema }>,
  ) => request<AutomationSummary>(`/api/automations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteAutomation: (id: string) => request<{ ok: boolean }>(`/api/automations/${id}`, { method: 'DELETE' }),

  /**
   * Kicks off a run.
   *
   * The runner answers immediately with an id to follow over the websocket.
   * This site, having no socket to offer, runs it to completion and answers
   * with the finished run — so `run` being present means there is nothing to
   * stream and the results are already here.
   */
  startRun: (
    id: string,
    values: Record<string, unknown>,
    opts?: { headful?: boolean; userId?: string },
  ) =>
    request<{ runId: string; status: string; run?: Run }>(
      `/api/automations/${id}/run${opts?.headful ? '?headful=1' : ''}`,
      {
        method: 'POST',
        // Who ran it, so the day's usage lands on the right account.
        headers: userHeader(opts?.userId),
        body: JSON.stringify(values),
      },
    ),

  getRun: (runId: string) => request<Run>(`/api/runs/${runId}`),

  /* ── voice ──────────────────────────────────────────────────────────────
     Routed through the same client as everything else rather than fetched
     directly. Going straight to the runner is why the voice page answered a
     missing backend with the browser's own "Failed to fetch" — three words
     naming neither what failed nor what to do — while every other page
     explained itself. */

  transcribe: (audio: Blob, mimeType = 'audio/wav') =>
    request<{ transcript: string; heard?: string }>('/api/voice/transcribe', {
      method: 'POST',
      headers: { 'content-type': mimeType },
      body: audio,
    }),

  voicePlan: <T>(transcript: string, ownerId?: string) =>
    request<T>('/api/voice/plan', {
      method: 'POST',
      body: JSON.stringify({ transcript, ownerId }),
    }),

  listRuns: (automationId?: string, limit = 20) =>
    request<Run[]>(
      `/api/runs?limit=${limit}${automationId ? `&automationId=${encodeURIComponent(automationId)}` : ''}`,
    ),

  screenshotUrl: (key: string) => `${RUNNER_URL}/api/screenshots/${key}`,

  /**
   * Result thumbnails, fetched through the runner.
   *
   * Plenty of sites serve their images with `Cross-Origin-Resource-Policy:
   * same-site`, so the browser refuses to paint them on a page that isn't
   * theirs — the request fails with ERR_BLOCKED_BY_RESPONSE and the card shows
   * a hole. Nothing about the URL says in advance whether that will happen, so
   * every remote image goes through the runner, which has no such restriction.
   */
  imageUrl: (src: string) =>
    /^https?:\/\//i.test(src) ? `${RUNNER_URL}/api/image?u=${encodeURIComponent(src)}` : src,

  /* ── account, marketplace, sandbox payments ────────────────────────────
     The signed-in id travels in a header rather than a cookie: this build has
     no session layer, and the sandbox moves no money. A real deployment
     replaces this with the auth provider's token and nothing else changes. */

  me: (userId?: string) => request<AccountState>('/api/me', { headers: userHeader(userId) }),

  saveProfile: (userId: string, patch: { email?: string; displayName?: string; plan?: string }) =>
    request<UserProfile>('/api/me', {
      method: 'PUT',
      headers: userHeader(userId),
      body: JSON.stringify(patch),
    }),

  listListings: () => request<Listing[]>('/api/listings'),

  publishListing: (userId: string, body: PublishInput) =>
    request<Listing>('/api/listings', {
      method: 'POST',
      headers: userHeader(userId),
      body: JSON.stringify(body),
    }),

  unpublishListing: (userId: string, id: string) =>
    request<{ ok: boolean }>(`/api/listings/${id}`, { method: 'DELETE', headers: userHeader(userId) }),

  gateways: () => request<{ gateways: Gateway[]; notice: string }>('/api/payment/gateways'),

  listMethods: (userId: string) =>
    request<PaymentMethod[]>('/api/payment/methods', { headers: userHeader(userId) }),

  startAddMethod: (userId: string, kind: string) =>
    request<{ challengeId: string | null; code: string | null; notice?: string }>(
      '/api/payment/methods/start',
      { method: 'POST', headers: userHeader(userId), body: JSON.stringify({ kind }) },
    ),

  addMethod: (userId: string, body: AddMethodInput) =>
    request<PaymentMethod>('/api/payment/methods', {
      method: 'POST',
      headers: userHeader(userId),
      body: JSON.stringify(body),
    }),

  setDefaultMethod: (userId: string, id: string) =>
    request<PaymentMethod>(`/api/payment/methods/${id}/default`, {
      method: 'POST',
      headers: userHeader(userId),
    }),

  removeMethod: (userId: string, id: string) =>
    request<{ ok: boolean }>(`/api/payment/methods/${id}`, {
      method: 'DELETE',
      headers: userHeader(userId),
    }),

  listInvoices: (userId: string) =>
    request<Invoice[]>('/api/payment/invoices', { headers: userHeader(userId) }),

  listSubscriptions: (userId: string) =>
    request<SubscriptionWithListing[]>('/api/subscriptions', { headers: userHeader(userId) }),

  subscribe: (userId: string, listingId: string, paymentMethodId: string) =>
    request<{ subscription: Subscription; invoice?: Invoice }>('/api/subscriptions', {
      method: 'POST',
      headers: userHeader(userId),
      body: JSON.stringify({ listingId, paymentMethodId }),
    }),

  cancelSubscription: (userId: string, id: string) =>
    request<Subscription>(`/api/subscriptions/${id}/cancel`, {
      method: 'POST',
      headers: userHeader(userId),
    }),
};

const userHeader = (userId?: string): Record<string, string> =>
  userId ? { 'x-mimic-user': userId } : {};

export interface Gateway {
  kind: PaymentMethod['kind'];
  label: string;
  accountHint: string;
  otp: boolean;
  brandColor: string;
}

export interface Plan {
  label: string;
  runsPerDay: number;
  automations: number;
  priceMinor: number;
}

export interface QuotaState {
  plan: string;
  planLabel: string;
  used: number;
  limit: number;
  remaining: number;
  day: string;
  enforced: boolean;
  wouldBlock: boolean;
}

export interface AccountState {
  profile: UserProfile | null;
  quota: QuotaState;
  plans: Record<string, Plan>;
}

export interface PublishInput {
  automationId: string;
  title?: string;
  tagline?: string;
  description?: string;
  sellerName?: string;
  priceMinor?: number;
  currency?: string;
  interval?: 'month' | 'year' | 'one_time';
  trialDays?: number;
  tags?: string[];
  coverEmoji?: string;
}

export interface AddMethodInput {
  kind: string;
  account: string;
  brand?: string;
  expiry?: string;
  challengeId?: string | null;
  code?: string;
  makeDefault?: boolean;
}

export type SubscriptionWithListing = Subscription & { listing: Listing | null };

/** Money as the person would read it. Minor units in, one string out. */
export function formatMoney(minor: number, currency = 'BDT'): string {
  if (!minor) return 'Free';
  return `${currency} ${(minor / 100).toLocaleString()}`;
}

export interface RunStream {
  close: () => void;
}

/**
 * Subscribe to a run's live events. The server replays everything that already
 * happened on connect, so a late subscriber still sees the full console.
 */
export function streamRun(
  runId: string,
  handlers: {
    onEvent?: (event: RunEvent) => void;
    onEnd?: (run: Run | null) => void;
    onError?: (message: string) => void;
  },
): RunStream {
  let socket: WebSocket | null = null;
  let closed = false;

  try {
    socket = new WebSocket(`${RUNNER_WS}/ws?runId=${encodeURIComponent(runId)}`);
  } catch {
    handlers.onError?.('Could not open a live connection to the runner.');
    return { close: () => {} };
  }

  socket.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data as string) as
        | { type: 'ready' }
        | { type: 'event'; event: RunEvent }
        | { type: 'end'; run: Run | null }
        | { type: 'error'; message: string };

      if (data.type === 'event') handlers.onEvent?.(data.event);
      else if (data.type === 'end') handlers.onEnd?.(data.run);
      else if (data.type === 'error') handlers.onError?.(data.message);
    } catch {
      /* ignore malformed frames */
    }
  };

  socket.onerror = () => {
    if (!closed) handlers.onError?.('Lost the live connection to the runner.');
  };

  return {
    close: () => {
      closed = true;
      socket?.close();
    },
  };
}

/** The generated REST snippet shown on the automation page. */
export function curlSnippet(automationId: string, values: Record<string, unknown>): string {
  const body = JSON.stringify(values, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : `  ${line}`))
    .join('\n');
  return `curl -X POST ${RUNNER_URL}/api/automations/${automationId}/run?wait=1 \\
  -H "Content-Type: application/json" \\
  -d '${body}'`;
}

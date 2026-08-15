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

/**
 * Client for the Mimic runner. Everything the web app knows about automations
 * and runs comes through here.
 */

export const RUNNER_URL = process.env.NEXT_PUBLIC_RUNNER_URL || 'http://localhost:8787';
export const RUNNER_WS = process.env.NEXT_PUBLIC_RUNNER_WS || 'ws://localhost:8787';

/** Automation without the (heavy) trace, which the list and detail views never need. */
export type AutomationSummary = Omit<Automation, 'trace'> & {
  stepCount: number;
  startUrl?: string;
  finalUrl?: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${RUNNER_URL}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
      cache: 'no-store',
    });
  } catch {
    /* The advice has to match where this is running. Telling somebody using
       the deployed site to run `npm run dev:runner` is worse than saying
       nothing — the runner they need is a server, not a terminal command. */
    const local = /localhost|127\.0\.0\.1/.test(RUNNER_URL);
    throw new ApiError(
      local
        ? `Can't reach the Mimic runner at ${RUNNER_URL}. Start it with \`npm run dev:runner\`.`
        : `Can't reach the Mimic runner at ${RUNNER_URL}. It may be starting up — a cold start boots a browser and takes a few seconds. If this persists, check that the runner is deployed and that this site's domain is in its RUNNER_CORS list.`,
      0,
    );
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

  listAutomations: (ownerId?: string) =>
    request<AutomationSummary[]>(`/api/automations${ownerId ? `?ownerId=${encodeURIComponent(ownerId)}` : ''}`),

  getAutomation: (id: string) => request<AutomationSummary>(`/api/automations/${id}`),

  updateAutomation: (
    id: string,
    patch: Partial<{ name: string; description: string; visibility: string; ownerId: string; schema: FormSchema }>,
  ) => request<AutomationSummary>(`/api/automations/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  deleteAutomation: (id: string) => request<{ ok: boolean }>(`/api/automations/${id}`, { method: 'DELETE' }),

  /** Kicks off a run and returns immediately; follow it with `streamRun`. */
  startRun: (
    id: string,
    values: Record<string, unknown>,
    opts?: { headful?: boolean; userId?: string },
  ) =>
    request<{ runId: string; status: string }>(
      `/api/automations/${id}/run${opts?.headful ? '?headful=1' : ''}`,
      {
        method: 'POST',
        // Who ran it, so the day's usage lands on the right account.
        headers: userHeader(opts?.userId),
        body: JSON.stringify(values),
      },
    ),

  getRun: (runId: string) => request<Run>(`/api/runs/${runId}`),

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

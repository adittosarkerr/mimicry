/**
 * Mimic — service worker.
 *
 * Owns the trace. Content scripts send raw events; this is where they get
 * merged into replayable steps (typing runs collapse, a combobox search plus
 * its dropdown pick become one step, calendar clicks become dates), where
 * navigations and XHR traffic get folded in, and where the finished trace is
 * shipped to the runner.
 *
 * MV3 service workers get evicted aggressively, so all state lives in
 * chrome.storage.session and every handler rehydrates before touching it.
 */

const DEFAULTS = {
  runnerUrl: 'http://localhost:8787',
  webUrl: 'http://localhost:3000',
  ingestToken: 'dev-local-token-change-me',
};

const STATE_KEY = 'mimic:state';
const MAX_STEPS = 4000;
const MAX_REQUESTS = 300;

// ── state ──────────────────────────────────────────────────────────────────
const blank = () => ({
  recording: false,
  tabId: null,
  traceId: null,
  startedAt: 0,
  startUrl: '',
  origin: '',
  steps: [],
  requests: [],
  /** Client ids already stored, so a retried step is not recorded twice. */
  seen: [],
});

async function getState() {
  const got = await chrome.storage.session.get(STATE_KEY);
  return got[STATE_KEY] || blank();
}

async function setState(next) {
  await chrome.storage.session.set({ [STATE_KEY]: next });
  return next;
}

async function getSettings() {
  const got = await chrome.storage.local.get('mimic:settings');
  return { ...DEFAULTS, ...(got['mimic:settings'] || {}) };
}

const uid = (p = 's') => `${p}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;

// ── merge logic ────────────────────────────────────────────────────────────

/** Do two steps point at the same element? Compares the top locator candidate. */
function sameTarget(a, b) {
  const ac = a?.target?.candidates?.[0];
  const bc = b?.target?.candidates?.[0];
  if (!ac || !bc) return false;
  return ac.strategy === bc.strategy && ac.value === bc.value && ac.name === bc.name;
}

/** Pull an ISO date out of a calendar cell's markup, if the site exposes one. */
function isoFromCalendarCell(step) {
  const attrs = step?.target?.snapshot?.attributes || {};
  const direct =
    attrs['data-date'] ||
    attrs['data-day'] ||
    attrs['data-iso'] ||
    attrs['data-value'] ||
    attrs['datetime'];
  if (direct && /\d{4}-\d{2}-\d{2}/.test(direct)) return direct.match(/\d{4}-\d{2}-\d{2}/)[0];

  // Many pickers put the full date in the accessible name: "12 September 2025".
  const label = `${attrs['aria-label'] || ''} ${step?.target?.snapshot?.accessibleName || ''}`;
  const parsed = Date.parse(label);
  if (label.trim() && !Number.isNaN(parsed)) {
    const d = new Date(parsed);
    if (d.getFullYear() > 1990 && d.getFullYear() < 2100) {
      return d.toISOString().slice(0, 10);
    }
  }
  return undefined;
}

/**
 * Fold a freshly received event into the step list.
 * Returns the updated list.
 */
function mergeStep(steps, incoming) {
  const step = {
    id: uid('st'),
    ...incoming,
    hints: incoming.hints || {},
    meta: incoming.meta || { kind: 'unknown', options: [], required: false },
  };
  const prev = steps[steps.length - 1];

  // 1. Repeated typing into the same box — keep only the final value.
  if (step.type === 'input' && prev?.type === 'input' && sameTarget(prev, step)) {
    steps[steps.length - 1] = { ...prev, value: step.value, ts: step.ts };
    return steps;
  }

  // 2. Combobox: the user typed, then clicked a suggestion. One step, not two.
  //    The click is rarely the very next event — sites fire focus changes and
  //    re-renders in between — so look back a few steps for the query that
  //    this suggestion belongs to.
  if (step.type === 'click' && step.hints?.inDropdown) {
    for (let i = steps.length - 1; i >= Math.max(0, steps.length - 4); i -= 1) {
      const candidate = steps[i];
      if (candidate.type !== 'input' || !candidate.value) continue;
      if (step.ts - candidate.ts > 25_000) break; // too far apart to be related

      steps[i] = {
        ...candidate,
        type: 'select',
        meta: {
          ...candidate.meta,
          kind: 'combobox',
          resolvedOptionText: step.value || step.target?.snapshot?.accessibleName,
          options: candidate.meta?.options?.length ? candidate.meta.options : [],
        },
        secondaryTarget: step.target,
        note: 'typed a query, then picked from the dropdown',
        ts: step.ts,
      };
      return steps;
    }
    // No query to attach it to — keep the click as its own step.
  }

  // 3. Calendar day click — becomes a date step with a real ISO value.
  if (step.type === 'click' && step.hints?.inCalendar) {
    const iso = isoFromCalendarCell(step);
    step.type = 'input';
    step.meta = { ...step.meta, kind: 'date' };
    step.hints = { ...step.hints, isoDate: iso };
    if (iso) step.value = iso;
    step.note = iso ? `picked ${iso} from the calendar` : 'picked a day from the calendar';

    // The click that opened the picker is setup, not data — mark it so the
    // compiler keeps it as a constant instead of exposing it as a field.
    // Its label is also the only sensible name for this field: the day cell
    // says "20", the opener says "Check-in".
    if (prev?.type === 'click' && !prev.hints?.inCalendar) {
      steps[steps.length - 1] = { ...prev, note: prev.note || 'opens the date picker' };
      const openerLabel = prev.meta?.label || prev.target?.snapshot?.accessibleName;
      if (openerLabel) step.meta = { ...step.meta, label: openerLabel, openerLabel };
    }
    steps.push(step);
    return steps;
  }

  // 4. Double-fired click on the same element inside 400ms — browser noise.
  if (step.type === 'click' && prev?.type === 'click' && sameTarget(prev, step) && step.ts - prev.ts < 400) {
    return steps;
  }

  // 5. Consecutive scrolls collapse to the furthest point.
  if (step.type === 'scroll' && prev?.type === 'scroll') {
    steps[steps.length - 1] = { ...prev, value: step.value, ts: step.ts };
    return steps;
  }

  steps.push(step);
  return steps;
}

async function pushStep(raw) {
  const state = await getState();
  if (!state.recording) return false;
  if (state.steps.length >= MAX_STEPS) return true;

  /* The content script retries anything it didn't get an acknowledgement for,
     so the same step can legitimately arrive twice — the delivery failed, or
     the reply did. `cid` is stable across retries; the step id is not. */
  if (raw?.cid) {
    state.seen = state.seen || [];
    if (state.seen.includes(raw.cid)) return true;
    state.seen.push(raw.cid);
    if (state.seen.length > 400) state.seen = state.seen.slice(-400);
  }

  state.steps = mergeStep(state.steps, raw);
  await setState(state);
  await updateBadge(state.steps.length);

  if (state.tabId != null) {
    chrome.tabs.sendMessage(state.tabId, { type: 'mimic:count', count: state.steps.length }).catch(() => {});
  }
  return true;
}

async function updateBadge(count) {
  try {
    await chrome.action.setBadgeText({ text: count ? String(count) : '' });
    await chrome.action.setBadgeBackgroundColor({ color: '#F97316' });
  } catch {
    /* badge is cosmetic */
  }
}

// ── messages ───────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const state = await getState();

    switch (msg?.type) {
      case 'mimic:hello':
        sendResponse({ recording: state.recording && sender.tab?.id === state.tabId });
        return;

      case 'mimic:ping':
        // Nothing to do — receiving the message is what keeps the worker alive.
        return sendResponse({ ok: true, recording: state.recording });

      case 'mimic:step': {
        /* Say *why* it was refused. A frame that isn't the recorded tab must
           stop retrying; a delivery that merely failed must keep trying. */
        if (sender.tab?.id !== state.tabId || !state.recording) {
          return sendResponse({ ok: false, reason: 'not-recording' });
        }
        const stored = await pushStep(msg.step);
        return sendResponse(stored ? { ok: true } : { ok: false, reason: 'not-recording' });
      }

      case 'mimic:request-pick':
        if (state.tabId != null) {
          chrome.tabs.sendMessage(state.tabId, { type: 'mimic:pick-output' }).catch(() => {});
        }
        return sendResponse({ ok: true });

      case 'mimic:status':
        return sendResponse({
          recording: state.recording,
          steps: state.steps.length,
          startedAt: state.startedAt,
          startUrl: state.startUrl,
          settings: await getSettings(),
        });

      case 'mimic:start':
        return sendResponse(await startRecording());

      case 'mimic:stop':
        return sendResponse(await stopRecording(msg.meta || {}));

      case 'mimic:discard':
        await setState(blank());
        await updateBadge(0);
        return sendResponse({ ok: true });

      case 'mimic:save-settings':
        await chrome.storage.local.set({ 'mimic:settings': msg.settings });
        return sendResponse({ ok: true });

      case 'mimic:check-settings':
        return sendResponse(await checkSettings(msg.settings));

      default:
        return sendResponse({ ok: false, error: 'unknown message' });
    }
  })();
  return true; // async response
});

// ── start / stop ───────────────────────────────────────────────────────────
async function startRecording() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url || /^(chrome|edge|about|brave):/i.test(tab.url)) {
    return { ok: false, error: 'Open a normal website tab first — browser pages cannot be recorded.' };
  }

  const state = blank();
  state.recording = true;
  state.tabId = tab.id;
  state.traceId = uid('tr');
  state.startedAt = Date.now();
  state.startUrl = tab.url;
  try {
    state.origin = new URL(tab.url).hostname;
  } catch {
    state.origin = '';
  }
  state.steps = [
    {
      id: uid('st'),
      seq: 0,
      ts: Date.now(),
      type: 'navigate',
      url: tab.url,
      title: tab.title,
      value: tab.url,
      delayBefore: 0,
      hints: {},
      meta: { kind: 'unknown', options: [], required: false },
    },
  ];
  await setState(state);
  await updateBadge(1);

  // The content scripts may already be alive from a previous page load.
  await ensureInjected(tab.id);
  await broadcast(tab.id, { type: 'mimic:set-recording', recording: true });
  return { ok: true, traceId: state.traceId };
}

async function stopRecording(meta) {
  const state = await getState();
  if (!state.recording) return { ok: false, error: 'Not recording.' };

  const tabId = state.tabId;
  await broadcast(tabId, { type: 'mimic:set-recording', recording: false });

  /* Stopping tells every frame to flush whatever it was holding — the
     half-typed value in particular — and those steps still have to be
     delivered. Closing the recording immediately is how the last and most
     important step goes missing. */
  await new Promise((resolve) => setTimeout(resolve, 700));

  const settled = await getState();
  settled.recording = false;
  await setState(settled);
  state.steps = settled.steps;

  /* Grab the final page so the compiler can see what the results look like.
     Explicitly from the top frame: without frameId, whichever frame answers
     first wins, and on an ad-heavy page that is a hidden 0×0 iframe. Its URL
     and viewport then become the recording's — which is how a trace ended up
     claiming the user finished on a cookie-rotation page in a window with no
     width, and every replay of it scraped an empty document. */
  let snapshot = null;
  try {
    snapshot = await chrome.tabs.sendMessage(tabId, { type: 'mimic:snapshot' }, { frameId: 0 });
  } catch {
    /* tab closed or navigated away */
  }

  const tab = await chrome.tabs.get(tabId).catch(() => null);

  const trace = {
    id: state.traceId,
    version: 1,
    createdAt: state.startedAt,
    startUrl: state.startUrl,
    finalUrl: snapshot?.url || tab?.url,
    origin: state.origin,
    title: meta.title || tab?.title || `Task on ${state.origin}`,
    viewport: snapshot?.viewport || { width: 1440, height: 900 },
    userAgent: snapshot?.userAgent,
    locale: snapshot?.locale,
    timezone: snapshot?.timezone,
    steps: state.steps.map((s, i) => ({ ...s, seq: i })),
    requests: state.requests.slice(-MAX_REQUESTS),
    finalDom: snapshot?.html,
    domSnapshots: snapshot ? [{ url: snapshot.url, html: snapshot.html }] : [],
  };

  const settings = await getSettings();
  await updateBadge(0);

  try {
    const res = await fetch(`${settings.runnerUrl}/api/ingest`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.ingestToken}`,
      },
      body: JSON.stringify({ trace, name: meta.name, description: meta.description }),
      /* The runner now answers with the rule-based form and refines afterwards,
         so this is a fast request. A ceiling on it means a runner that is down
         or wedged reports that, instead of leaving the popup spinning. */
      signal: AbortSignal.timeout(45_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let said = '';
      try {
        said = JSON.parse(text).error || '';
      } catch {
        said = text.slice(0, 160);
      }

      /* A 401 is one thing and one thing only: the token here is not the token
         the runner was started with. Saying "Runner rejected the trace (401)"
         and pasting its JSON back makes the reader work that out for
         themselves, while they are still wondering whether they just lost the
         recording — so say what is wrong, where to change it, and that the
         recording is safe. It is: the trace is only cleared on success. */
      const error =
        res.status === 401
          ? 'The ingest token in this extension does not match the one the runner was started with. ' +
            'Open ⚙ Settings, paste the value of MIMIC_INGEST_TOKEN from the runner’s .env.local, and save — ' +
            'then press Build again. Your recording is still here.'
          : `The runner refused this recording (${res.status})${said ? `: ${said}` : '.'}`;

      return { ok: false, error, keptSteps: trace.steps.length };
    }

    const data = await res.json();
    await setState(blank());

    const url = `${settings.webUrl}/automations/${data.automationId}?new=1`;
    await chrome.tabs.create({ url });
    return { ok: true, automationId: data.automationId, url };
  } catch (err) {
    // Keep the trace in session storage so nothing is lost if the runner is down.
    return {
      ok: false,
      error: `Could not reach the Mimic runner at ${settings.runnerUrl}. Is it running? (${err.message})`,
      keptSteps: trace.steps.length,
    };
  }
}

/**
 * Does this runner exist, and will it accept this token?
 *
 * Asked when settings are saved, because the alternative is finding out at the
 * end of a recording. Recording a twenty-step task and then being told the
 * token is wrong is the same amount of information delivered at the worst
 * possible moment.
 *
 * The token is checked by posting a deliberately empty trace. The runner
 * answers 401 when the token is wrong and 400 when it is right and the trace
 * is unreadable — which is exactly the distinction being tested, and it writes
 * nothing either way.
 */
async function checkSettings(settings) {
  const url = (settings?.runnerUrl || '').replace(/\/$/, '');
  if (!url) return { ok: false, error: 'Set the runner URL first.' };

  let health;
  try {
    health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(8000) });
  } catch (err) {
    return {
      ok: false,
      error: `No runner answered at ${url}. Start it with \`npm run dev:runner\`, or check the address. (${err.message})`,
    };
  }
  if (!health.ok) return { ok: false, error: `${url} answered ${health.status}, which is not a Mimic runner.` };

  const probe = await fetch(`${url}/api/ingest`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.ingestToken ?? ''}`,
    },
    body: JSON.stringify({ trace: {} }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);

  if (!probe) return { ok: false, error: 'The runner stopped answering partway through the check.' };
  if (probe.status === 401) {
    return {
      ok: false,
      error: 'That token is not the one this runner was started with. Copy MIMIC_INGEST_TOKEN from its .env.local.',
    };
  }

  const info = await health.json().catch(() => ({}));
  return {
    ok: true,
    message: `Connected. ${info.ai && info.ai !== 'disabled' ? `AI: ${info.ai}` : 'No AI key set'} · store: ${info.store ?? 'files'}`,
  };
}

/** Content scripts declared in the manifest miss tabs that were already open. */
async function ensureInjected(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ['content/locator.js', 'content/recorder.js', 'content/overlay.js'],
    });
  } catch {
    /* already injected, or a restricted frame */
  }
}

async function broadcast(tabId, message) {
  if (tabId == null) return;
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    await Promise.all(
      (frames || []).map((f) =>
        chrome.tabs.sendMessage(tabId, message, { frameId: f.frameId }).catch(() => {}),
      ),
    );
  } catch {
    chrome.tabs.sendMessage(tabId, message).catch(() => {});
  }
}

// ── navigation ─────────────────────────────────────────────────────────────
chrome.webNavigation.onCommitted.addListener(async (details) => {
  const state = await getState();
  if (!state.recording || details.tabId !== state.tabId || details.frameId !== 0) return;
  if (/^(about|chrome|edge):/i.test(details.url)) return;

  const last = state.steps[state.steps.length - 1];
  if (last?.type === 'navigate' && last.value === details.url) return;

  // A click that triggered this navigation should say so — replay waits on it.
  if (last && last.type === 'click') {
    state.steps[state.steps.length - 1] = { ...last, causedNavigation: true };
  }

  // A redirect is something the site did, not something the user chose. Replay
  // must never navigate to one directly — the destination is usually a
  // short-lived interstitial (cookie rotation, auth bounce) that 404s or
  // redirects elsewhere when visited cold.
  const qualifiers = details.transitionQualifiers || [];
  const isRedirect =
    qualifiers.includes('server_redirect') ||
    qualifiers.includes('client_redirect') ||
    details.transitionType === 'auto_subframe';

  state.steps.push({
    id: uid('st'),
    seq: state.steps.length,
    ts: Date.now(),
    type: 'navigate',
    url: details.url,
    value: details.url,
    delayBefore: 0,
    hints: { redirect: isRedirect },
    meta: { kind: 'unknown', options: [], required: false },
    note: isRedirect ? `redirect (${details.transitionType})` : details.transitionType,
  });
  await setState(state);
  await updateBadge(state.steps.length);
});

// SPA route changes never fire onCommitted.
chrome.webNavigation.onHistoryStateUpdated.addListener(async (details) => {
  const state = await getState();
  if (!state.recording || details.tabId !== state.tabId || details.frameId !== 0) return;
  const last = state.steps[state.steps.length - 1];
  if (last?.value === details.url) return;
  state.steps.push({
    id: uid('st'),
    seq: state.steps.length,
    ts: Date.now(),
    type: 'waitFor',
    url: details.url,
    value: details.url,
    delayBefore: 0,
    hints: {},
    meta: { kind: 'unknown', options: [], required: false },
    note: 'client-side route change',
  });
  await setState(state);
});

// Keep recording across page loads in the same tab.
chrome.webNavigation.onCompleted.addListener(async (details) => {
  const state = await getState();
  if (!state.recording || details.tabId !== state.tabId) return;
  chrome.tabs
    .sendMessage(details.tabId, { type: 'mimic:set-recording', recording: true }, { frameId: details.frameId })
    .catch(() => {});
});

// ── network observation ────────────────────────────────────────────────────
// Response bodies aren't available to MV3, but knowing which endpoint produced
// the results is enough for the compiler to suggest a faster API-level replay.
chrome.webRequest.onCompleted.addListener(
  async (details) => {
    const state = await getState();
    if (!state.recording || details.tabId !== state.tabId) return;
    if (!['xmlhttprequest', 'fetch'].includes(details.type)) return;
    if (state.requests.length >= MAX_REQUESTS) return;

    // Never persist anything that looks like a credential.
    const url = details.url.length > 500 ? `${details.url.slice(0, 500)}…` : details.url;
    if (/(password|token|secret|authorization)=/i.test(url)) return;

    state.requests.push({
      method: details.method,
      url,
      resourceType: details.type,
      status: details.statusCode,
    });
    await setState(state);
  },
  { urls: ['<all_urls>'] },
);

// A closed tab ends the recording rather than leaving it orphaned.
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const state = await getState();
  if (state.recording && state.tabId === tabId) {
    state.recording = false;
    await setState(state);
    await updateBadge(0);
  }
});

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  await chrome.storage.local.set({ 'mimic:settings': settings });
  await updateBadge(0);
});

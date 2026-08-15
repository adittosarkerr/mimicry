/**
 * Mimic — event recorder.
 *
 * Runs in every frame. Captures the user's interactions as raw events with a
 * full locator payload attached, and ships them to the service worker, which
 * owns the trace and does the merging (typing runs, combobox picks, etc).
 *
 * Deliberately does NOT record values from password, CVV, or card fields.
 */
(() => {
  if (window.__mimicRecorder) return;

  const L = window.__mimicLocator;
  let recording = false;
  let seq = 0;
  let lastEventAt = Date.now();
  /**
   * True while the user is choosing the results region.
   *
   * Picking involves clicking a page element, and that click is not part of
   * the task — recording it makes the replay click a search result and end up
   * on a completely different page.
   */
  let picking = false;

  /** Fields whose values must never leave the page. */
  const SECRET = /(pass(word|wd)?|pwd|cvv|cvc|security[-_ ]?code|card[-_ ]?number|cardnum|ccnum|secret|token|otp|pin)/i;

  const isSecret = (el) =>
    el.type === 'password' ||
    SECRET.test(`${el.name || ''} ${el.id || ''} ${el.getAttribute('autocomplete') || ''} ${el.getAttribute('aria-label') || ''}`);

  /**
   * Our own overlay must never end up in the trace.
   *
   * The overlay lives in a shadow root, and `closest()` does not cross shadow
   * boundaries — so checking the target alone reports Mimic's own buttons as
   * page elements. The composed path is the only reliable test.
   */
  const isOurs = (el) => !!el.closest?.('[data-mimic-ui]');

  const pathIsOurs = (e) =>
    (e.composedPath?.() || []).some(
      (n) => n && n.nodeType === 1 && n.hasAttribute?.('data-mimic-ui'),
    );

  /** True when the click landed inside an autocomplete/dropdown popup. */
  const inDropdown = (el) =>
    !!el.closest?.(
      '[role="listbox"],[role="option"],[role="menu"],[role="menuitem"],' +
        '[class*="autocomplete" i],[class*="suggestion" i],[class*="typeahead" i],' +
        '[class*="dropdown" i],[class*="options" i],[class*="results" i]',
    );

  /**
   * Every option in the open dropdown the user just clicked inside.
   * Read at click time because the list is torn down immediately after.
   */
  function siblingOptions(el) {
    const list = el.closest(
      '[role="listbox"],[role="menu"],ul,[class*="autocomplete" i],[class*="suggestion" i],' +
        '[class*="dropdown" i],[class*="options" i],[class*="results" i]',
    );
    if (!list) return [];

    const nodes = list.querySelectorAll('[role="option"],[role="menuitem"],li,option,[class*="item" i]');
    const out = [];
    for (const node of nodes) {
      // Nested wrappers repeat the same text; keep the innermost meaningful one.
      if (node.querySelector('[role="option"],[role="menuitem"],li')) continue;
      const label = L.visibleText(node);
      if (!label || label.length > 90) continue;
      if (out.some((o) => o.label === label)) continue;
      out.push({
        label,
        value: node.getAttribute('data-value') || node.getAttribute('value') || label,
        disabled: node.getAttribute('aria-disabled') === 'true',
      });
      if (out.length >= 60) break;
    }
    return out;
  }

  /** True when the click landed inside a date picker. */
  const inCalendar = (el) =>
    !!el.closest?.(
      '[role="grid"],[class*="calendar" i],[class*="datepick" i],[class*="daypicker" i],[data-date],[aria-label*="calendar" i]',
    );

  /** Cookie/consent banners are recorded but flagged so the form hides them. */
  const inConsent = (el) =>
    !!el.closest?.(
      '[id*="cookie" i],[class*="cookie" i],[id*="consent" i],[class*="consent" i],' +
        '[id*="gdpr" i],[class*="gdpr" i],[aria-label*="cookie" i]',
    );

  /** The real target, piercing shadow roots. Null for anything Mimic drew. */
  const realTarget = (e) => {
    if (pathIsOurs(e)) return null;
    const path = e.composedPath?.() || [];
    const el = path.find((n) => n && n.nodeType === 1) || e.target;
    return el && el.nodeType === 1 ? el : null;
  };

  /* ── delivery ────────────────────────────────────────────────────────────
     Steps used to be posted and forgotten. An MV3 service worker is evicted
     after a few seconds of quiet and a content script is destroyed the instant
     the page navigates, so `sendMessage` fails at exactly the worst moments —
     the keystroke before Enter, the click that submits. Losing one step there
     loses the whole point of the recording: the YouTube trace that reached the
     runner had the click and the Enter but no typed query at all.

     Now every step is queued, delivered with an acknowledgement, and retried.
     The queue lives in sessionStorage so a navigation mid-delivery resumes on
     the next page instead of dropping what was in flight. */

  const PENDING_KEY = 'mimic:pending-steps';
  let pending = [];
  let draining = false;
  let retryDelay = 250;

  function loadPending() {
    try {
      pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || '[]');
    } catch {
      pending = [];
    }
  }

  function persistPending() {
    try {
      // Cap it: a runaway queue must never fill the origin's storage quota.
      sessionStorage.setItem(PENDING_KEY, JSON.stringify(pending.slice(-200)));
    } catch {
      /* quota or a sandboxed frame — the in-memory queue still works */
    }
  }

  async function drain() {
    if (draining) return;
    draining = true;
    try {
      while (pending.length) {
        const step = pending[0];
        let ok = false;
        try {
          const res = await chrome.runtime.sendMessage({ type: 'mimic:step', step });
          // `false` is a real answer — this frame isn't the recorded tab, so
          // the step is not ours to deliver and retrying would spin forever.
          if (res && res.ok === false && res.reason === 'not-recording') {
            pending.shift();
            persistPending();
            continue;
          }
          ok = Boolean(res && res.ok);
        } catch {
          ok = false; // worker asleep, or this context is being torn down
        }

        if (!ok) {
          setTimeout(drain, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 3000);
          return;
        }

        retryDelay = 250;
        pending.shift();
        persistPending();
      }
    } finally {
      draining = false;
    }
  }

  function emit(partial) {
    if (!recording || picking) return;
    const now = Date.now();
    const step = {
      // A stable id the worker dedupes on, so a retried step is not recorded
      // twice when the acknowledgement is what went missing.
      cid: `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`,
      seq: seq++,
      ts: now,
      url: location.href,
      title: document.title,
      delayBefore: Math.min(now - lastEventAt, 15_000),
      frameUrl: location.href,
      isTopFrame: window.top === window,
      ...partial,
    };
    lastEventAt = now;
    pending.push(step);
    persistPending();
    void drain();
  }

  /* An idle service worker is evicted, and the eviction lands between the user
     typing and the user pressing Enter more often than it sounds. A cheap ping
     while recording keeps it resident. */
  let keepAlive = null;
  function setKeepAlive(on) {
    clearInterval(keepAlive);
    keepAlive = null;
    if (!on || window.top !== window) return;
    keepAlive = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'mimic:ping' }).catch(() => {});
    }, 15_000);
  }

  loadPending();
  if (pending.length) void drain();

  function describe(el) {
    return { target: L.buildLocators(el), meta: L.buildMeta(el) };
  }

  /* ── counters ──────────────────────────────────────────────────────────────
   *
   * "2 adults, 1 room" is set by clicking a "+" three or four times. Recorded
   * literally that is three anonymous clicks on a button whose only label is
   * "+", which cannot become a form field and cannot be replayed against a site
   * whose default has since changed. The whole widget is one thing the person
   * did — "adults = 3" — so it is recorded as one step, once they stop clicking.
   */
  const PLUS_RE = /(^\s*[+＋]\s*$|increase|increment|\badd\b|\bplus\b|more)/i;
  const MINUS_RE = /(^\s*[-−–—]\s*$|decrease|decrement|subtract|\bminus\b|\bless\b|remove)/i;

  const buttonName = (el) =>
    L.norm(el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent) || '';

  /** The counter this +/− button belongs to, if it is one. */
  function counterOf(el) {
    const button = el.closest('button, [role="button"], input[type="button"]');
    if (!button) return null;

    const name = buttonName(button);
    const isPlus = PLUS_RE.test(name);
    const isMinus = MINUS_RE.test(name);
    if (!isPlus && !isMinus) return null;

    let node = button.parentElement;
    for (let up = 0; up < 5 && node; up += 1, node = node.parentElement) {
      const text = L.norm(node.innerText) || '';
      if (text.length > 220) break;

      const others = Array.from(node.querySelectorAll('button, [role="button"]')).filter(
        (b) => b !== button,
      );
      const partner = others.find((b) =>
        isPlus ? MINUS_RE.test(buttonName(b)) : PLUS_RE.test(buttonName(b)),
      );
      if (!partner) continue;

      let label = L.norm(node.innerText) || '';
      for (const part of [name, buttonName(partner)]) {
        if (part) label = label.split(part).join(' ');
      }
      label = (L.norm(label.replace(/\d+/g, ' ')) || '').slice(0, 60);
      if (!label) {
        label = (L.norm(name.replace(/^(add|increase|increment|plus|more)\b/i, '')) || '').slice(0, 60);
      }

      return { group: node, label: label || 'Count' };
    }
    return null;
  }

  /** The number currently showing inside a counter group. */
  function counterValue(group) {
    const numeric = group.querySelector('input[type="number"], input[inputmode="numeric"]');
    if (numeric && numeric.value !== '') return Number(numeric.value);

    for (const node of group.querySelectorAll('*')) {
      if (node.children.length) continue;
      const text = L.norm(node.textContent) || '';
      if (/^\d{1,3}$/.test(text)) return Number(text);
    }
    return null;
  }

  let counterPending = null;
  let counterTimer = null;

  function flushCounter() {
    if (!counterPending) return;
    const { group, label, target, meta } = counterPending;
    counterPending = null;
    clearTimeout(counterTimer);

    const value = counterValue(group);
    if (value === null) return;

    emit({
      type: 'stepper',
      target,
      meta: { ...meta, kind: 'number', label },
      value,
      hints: {},
      note: 'counter',
    });
  }

  // ── clicks ───────────────────────────────────────────────────────────────
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!recording || !e.isTrusted) return;
      const el = realTarget(e);
      if (!el || isOurs(el)) return;

      // Flush any half-typed text before the click acts on it.
      flushTyping();

      const counter = counterOf(el);
      if (counter) {
        /* Wait for them to stop. The value is read after the last click, so it
           does not matter whether they went 1→4 or 1→5→4. */
        const { target, meta } = describe(counter.group);
        counterPending = { group: counter.group, label: counter.label, target, meta };
        clearTimeout(counterTimer);
        counterTimer = setTimeout(flushCounter, 900);
        return;
      }

      flushCounter();

      const { target, meta } = describe(el);
      const hints = {
        inDropdown: inDropdown(el),
        inCalendar: inCalendar(el),
        inConsent: inConsent(el),
      };

      // The suggestion list is open right now and will be gone in a moment.
      // Capturing its options here is the only chance to give the generated
      // form a real dropdown instead of a bare text box.
      if (hints.inDropdown) {
        meta.options = siblingOptions(el);
      }

      emit({
        type: 'click',
        target,
        meta,
        // What the row says as laid out, so a two-line suggestion keeps its comma.
        value: L.visibleText(el)?.slice(0, 120) || undefined,
        hints,
        note: hints.inConsent ? 'consent banner' : undefined,
      });
    },
    true,
  );

  // ── typing ───────────────────────────────────────────────────────────────
  let typingEl = null;
  let typingTimer = null;
  // Captured on the first keystroke, not at flush time. Sites like Booking.com
  // tear down and rebuild their search input the moment the suggestion list
  // opens — describing the element later would find it detached and silently
  // drop the most important field in the whole recording.
  let typingSnapshot = null;
  let typingValue = '';

  function readValue(el) {
    return el.isContentEditable ? L.norm(el.textContent) : el.value;
  }

  function flushTyping() {
    if (!typingEl || !typingSnapshot) return;
    const el = typingEl;
    const snapshot = typingSnapshot;
    const value = typingValue;
    typingEl = null;
    typingSnapshot = null;
    typingValue = '';
    clearTimeout(typingTimer);

    const secret = snapshot.secret;
    // Prefer the live value when the element survived; fall back to the last
    // value we saw if the site replaced it mid-flight.
    const finalValue = secret ? '' : el.isConnected ? readValue(el) || value : value;
    if (!secret && !finalValue) return;

    emit({
      type: 'input',
      target: snapshot.target,
      meta: snapshot.meta,
      value: finalValue,
      hints: { secret },
      note: secret ? 'value omitted — sensitive field' : undefined,
    });
  }

  document.addEventListener(
    'input',
    (e) => {
      if (!recording || !e.isTrusted) return;
      const el = realTarget(e);
      if (!el || isOurs(el)) return;
      if (!('value' in el) && !el.isContentEditable) return;
      if (el.type === 'checkbox' || el.type === 'radio') return;

      if (typingEl && typingEl !== el) flushTyping();

      if (typingEl !== el) {
        // Describe the element while it is definitely still in the document.
        const { target, meta } = describe(el);
        typingSnapshot = { target, meta, secret: isSecret(el) };
        typingEl = el;
      }
      typingValue = readValue(el);

      clearTimeout(typingTimer);
      // Debounce so "Bangkok" is one step, not seven.
      typingTimer = setTimeout(flushTyping, 600);
    },
    true,
  );

  document.addEventListener('blur', () => flushTyping(), true);

  // ── selects, checkboxes, radios ──────────────────────────────────────────
  document.addEventListener(
    'change',
    (e) => {
      if (!recording || !e.isTrusted) return;
      const el = realTarget(e);
      if (!el || isOurs(el)) return;

      const { target, meta } = describe(el);

      if (el.tagName === 'SELECT') {
        const selected = Array.from(el.selectedOptions || []).map((o) => o.value);
        emit({
          type: 'select',
          target,
          meta: {
            ...meta,
            resolvedOptionText: L.norm(el.selectedOptions?.[0]?.textContent),
          },
          value: el.multiple ? selected : el.value,
        });
        return;
      }

      if (el.type === 'checkbox' || el.type === 'radio') {
        emit({ type: 'check', target, meta, value: el.checked });
        return;
      }

      if (el.type === 'file') {
        emit({
          type: 'upload',
          target,
          meta,
          value: Array.from(el.files || []).map((f) => f.name),
          note: 'file contents not captured — supply the file at run time',
        });
        return;
      }

      if (el.type === 'range') {
        emit({ type: 'input', target, meta, value: el.value });
        return;
      }

      // Native date/time inputs fire change, not a debounced input run.
      if (['date', 'time', 'datetime-local', 'month', 'week'].includes(el.type)) {
        if (typingEl === el) {
          typingEl = null;
          clearTimeout(typingTimer);
        }
        emit({ type: 'input', target, meta, value: el.value });
      }
    },
    true,
  );

  // ── keys ─────────────────────────────────────────────────────────────────
  const TRACKED_KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp', 'Backspace']);
  document.addEventListener(
    'keydown',
    (e) => {
      if (!recording || !e.isTrusted) return;
      if (!TRACKED_KEYS.has(e.key)) return;
      if (e.key === 'Backspace') return; // noise; the debounced value already reflects it
      const el = realTarget(e);
      if (!el || isOurs(el)) return;

      if (e.key === 'Enter') flushTyping();
      const { target, meta } = describe(el);
      emit({ type: 'press', target, meta, value: e.key });
    },
    true,
  );

  // ── scrolling ────────────────────────────────────────────────────────────
  let scrollTimer = null;
  let lastScrollY = 0;
  window.addEventListener(
    'scroll',
    () => {
      if (!recording) return;
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        const y = Math.round(window.scrollY);
        // Only meaningful scrolls — lazy-loaded results depend on them.
        if (Math.abs(y - lastScrollY) < 400) return;
        lastScrollY = y;
        emit({ type: 'scroll', value: y });
      }, 400);
    },
    { passive: true, capture: true },
  );

  // ── submits ──────────────────────────────────────────────────────────────
  document.addEventListener(
    'submit',
    (e) => {
      if (!recording || !e.isTrusted) return;
      const el = realTarget(e);
      if (!el || isOurs(el)) return;
      flushTyping();
      flushCounter();
      // The click on the submit button is already recorded; this only marks
      // that the page is about to change so replay waits for it.
      emit({ type: 'waitFor', value: location.href, note: 'form submitted' });
    },
    true,
  );

  // ── page snapshot for the AI compiler / output scraper ───────────────────
  function snapshot() {
    flushTyping();
    flushCounter();
    const html = document.documentElement?.outerHTML || '';
    return {
      url: location.href,
      title: document.title,
      // Trim to keep messaging cheap; the compiler only needs structure.
      html: html.length > 400_000 ? `${html.slice(0, 400_000)}\n<!-- truncated -->` : html,
      isTopFrame: window.top === window,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      userAgent: navigator.userAgent,
      scrollY: Math.round(window.scrollY),
    };
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'mimic:set-recording') {
      recording = !!msg.recording;
      lastEventAt = Date.now();
      if (!recording) {
        flushTyping();
        flushCounter();
      }
      setKeepAlive(recording);
      window.__mimicOverlay?.setRecording(recording);
      sendResponse({ ok: true, recording });
      return true;
    }
    if (msg?.type === 'mimic:snapshot') {
      sendResponse(snapshot());
      return true;
    }
    if (msg?.type === 'mimic:pick-output') {
      picking = true;
      window.__mimicOverlay?.startPicking(
        (el) => {
          const { target, meta } = describe(el);
          picking = false; // the pick itself is done; this step *is* wanted
          lastEventAt = Date.now();
          emit({ type: 'extract', target, meta, note: 'user marked the results region' });
        },
        () => {
          picking = false;
        },
      );
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });

  // The service worker may have started recording before this frame loaded.
  try {
    chrome.runtime.sendMessage({ type: 'mimic:hello' }, (res) => {
      if (chrome.runtime.lastError) return;
      if (res?.recording) {
        recording = true;
        setKeepAlive(true);
        window.__mimicOverlay?.setRecording(true);
        /* Only the page itself. This fires in every frame, and an ad or a
           tracking pixel announcing `about:blank` as a navigation is how a
           recording ends up telling replay to go there — which is exactly what
           broke the YouTube trace. */
        if (window.top === window && /^https?:/i.test(location.href)) {
          emit({ type: 'navigate', value: location.href, note: 'frame loaded' });
        }
      }
    });
  } catch {
    /* extension context not ready */
  }

  window.__mimicRecorder = { get recording() { return recording; } };
})();

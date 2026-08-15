/**
 * Mimic — locator engine.
 *
 * Produces many independent ways of pointing at one element, each scored by how
 * likely it is to survive a site redeploy. Replay walks the list top-down, so a
 * page that swaps its hashed CSS classes overnight still resolves through
 * data-testid, accessible name, or visible text.
 *
 * Exposed as `window.__mimicLocator`. Loaded before recorder.js.
 */
(() => {
  if (window.__mimicLocator) return;

  const TESTID_ATTRS = [
    'data-testid',
    'data-test-id',
    'data-test',
    'data-qa',
    'data-cy',
    'data-automation-id',
    'data-tracking-id',
  ];

  /** Class names that are generated per-build and must never be used alone. */
  const HASHED_CLASS = /^(css-[a-z0-9]{5,}|sc-[A-Za-z0-9]{5,}|jsx-\d+|_[A-Za-z0-9_]{5,}__[A-Za-z0-9]{5,}|[a-z]+_[a-z0-9]{5,}|[A-Za-z0-9]{8,}==?)$/;
  /** Utility-class frameworks — huge in number, meaningless individually. */
  const UTILITY_CLASS =
    /^(flex|grid|block|inline|hidden|relative|absolute|fixed|sticky|w-|h-|p[xytblr]?-|m[xytblr]?-|text-|bg-|border|rounded|shadow|gap-|items-|justify-|font-|leading-|tracking-|z-|overflow-|max-|min-|space-|col-|row-|opacity-|transition|duration-|ease-|hover:|focus:|md:|lg:|sm:|xl:)/;
  /** Framework-generated ids that change every render. */
  const UNSTABLE_ID =
    /^(:r[0-9a-z]+:|radix-|headlessui-|mui-|react-aria-|react-select-|downshift-|ember\d|ext-gen\d|yui_|aria-|uid[-_]?\d|[0-9a-f]{8}-[0-9a-f]{4})/i;

  const clamp = (s, n) => (s && s.length > n ? s.slice(0, n) : s || '');
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /**
   * The text a person sees, with the line breaks they see.
   *
   * `textContent` concatenates across block elements with nothing between
   * them, so an autocomplete row rendered as two lines — "Cox's Bazar" above
   * "Bangladesh" — is captured as the single word "Cox'sBazarBangladesh".
   * That string became the field's default, went into the site's own search
   * box on every later run, matched no destination at all, and returned a page
   * of property categories. `innerText` respects layout and puts a newline
   * where the eye sees one; the separator is then a comma, as written.
   */
  const visibleText = (el) => {
    if (!el) return '';
    const rendered = typeof el.innerText === 'string' ? el.innerText : null;
    // innerText is empty for elements that aren't laid out; fall back then.
    const raw = rendered && rendered.trim() ? rendered : el.textContent;
    return norm((raw || '').replace(/\n+/g, ', ')).replace(/\s*,\s*/g, ', ').replace(/(,\s*)+$/, '');
  };

  const isStableId = (id) =>
    !!id && id.length < 60 && !UNSTABLE_ID.test(id) && !/\d{6,}/.test(id);

  const stableClasses = (el) =>
    Array.from(el.classList || []).filter(
      (c) => c && !HASHED_CLASS.test(c) && !UTILITY_CLASS.test(c) && c.length < 40,
    );

  const cssEscape = (v) =>
    window.CSS && CSS.escape ? CSS.escape(v) : String(v).replace(/([^\w-])/g, '\\$1');

  /** Root node an element lives in — the document, or its shadow root. */
  const rootOf = (el) => {
    const r = el.getRootNode ? el.getRootNode() : document;
    return r instanceof ShadowRoot || r instanceof Document ? r : document;
  };

  const countMatches = (el, selector) => {
    try {
      return rootOf(el).querySelectorAll(selector).length;
    } catch {
      return 0;
    }
  };

  // ── accessible name ──────────────────────────────────────────────────────
  function accessibleName(el) {
    if (!el || el.nodeType !== 1) return '';
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;

    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => rootOf(el).getElementById?.(id) || document.getElementById(id))
        .filter(Boolean)
        .map((n) => norm(n.textContent))
        .join(' ');
      if (text) return norm(text);
    }

    if (el.id) {
      const lbl = document.querySelector(`label[for="${cssEscape(el.id)}"]`);
      if (lbl) return norm(lbl.textContent);
    }

    const wrapping = el.closest?.('label');
    if (wrapping) {
      // Strip the control's own text so "Economy" doesn't become "EconomyEconomy".
      const clone = wrapping.cloneNode(true);
      clone.querySelectorAll('input,select,textarea').forEach((n) => n.remove());
      const t = norm(clone.textContent);
      if (t) return t;
    }

    const title = norm(el.getAttribute('title'));
    if (title) return title;
    const alt = norm(el.getAttribute('alt'));
    if (alt) return alt;
    const ph = norm(el.getAttribute('placeholder'));
    if (ph) return ph;

    // Buttons and links: their own text is the name.
    const own = visibleText(el);
    if (own && own.length <= 80) return own;

    const valueAttr = norm(el.getAttribute('value'));
    if (valueAttr && el.tagName === 'INPUT') return valueAttr;

    return '';
  }

  /** Implicit ARIA role, good enough for locator purposes. */
  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.split(/\s+/)[0];
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (tag === 'button') return 'button';
    if (tag === 'select') return el.multiple ? 'listbox' : 'combobox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'img') return 'img';
    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    if (/^h[1-6]$/.test(tag)) return 'heading';
    if (tag === 'li') return 'listitem';
    if (tag === 'option') return 'option';
    return 'generic';
  }

  // ── control classification ───────────────────────────────────────────────
  const DATE_HINT = /(date|day|month|year|check[- _]?in|check[- _]?out|depart|return|arriv|from|to|when|calendar|dob|birth)/i;
  const TIME_HINT = /(time|hour|minute|clock)/i;

  /**
   * What widget is this, really? Sites rarely use native inputs for dates or
   * dropdowns, so we lean on role, ARIA, and the surrounding markup.
   */
  function controlKind(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const role = roleOf(el);
    const name = `${el.getAttribute('name') || ''} ${el.id || ''} ${accessibleName(el)}`;

    if (tag === 'select') return el.multiple ? 'multiselect' : 'select';
    if (tag === 'textarea') return 'textarea';

    if (tag === 'input') {
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'file') return 'file';
      if (type === 'number') return 'number';
      if (type === 'email') return 'email';
      if (type === 'password') return 'password';
      if (type === 'date') return 'date';
      if (type === 'time') return 'time';
      if (type === 'datetime-local') return 'datetime';
      // A text input wired to a listbox is a combobox, whatever the markup says.
      if (
        el.getAttribute('role') === 'combobox' ||
        el.hasAttribute('aria-autocomplete') ||
        el.hasAttribute('aria-controls') ||
        el.getAttribute('autocomplete') === 'off' && DATE_HINT.test(name) === false && !!el.closest('[class*="autocomplete" i],[class*="typeahead" i],[class*="search" i]')
      ) {
        return 'combobox';
      }
      if (DATE_HINT.test(name)) return 'date';
      if (TIME_HINT.test(name)) return 'time';
      return 'text';
    }

    if (role === 'checkbox' || el.hasAttribute('aria-checked')) {
      return el.getAttribute('role') === 'switch' ? 'toggle' : 'checkbox';
    }
    if (role === 'switch') return 'toggle';
    if (role === 'radio') return 'radio';
    if (role === 'slider') return 'slider';
    if (role === 'combobox') return 'combobox';
    if (role === 'option') return 'select';
    if (role === 'link') return 'link';
    if (role === 'button') {
      // A button that opens a calendar is a date field to the user.
      if (DATE_HINT.test(name) || el.closest('[class*="calendar" i],[class*="datepick" i],[data-date]')) {
        return 'date';
      }
      return 'button';
    }
    if (el.closest('[class*="calendar" i],[class*="datepick" i],[role="grid"]') && DATE_HINT.test(name)) {
      return 'date';
    }
    return 'unknown';
  }

  /** Options for selects, radio groups, and open listboxes. */
  function collectOptions(el) {
    const out = [];
    const push = (label, value, disabled, group) => {
      const l = norm(label);
      if (!l) return;
      if (out.some((o) => o.label === l)) return;
      out.push({ label: l, value: value ?? l, disabled: !!disabled, group });
      };

    if (el.tagName === 'SELECT') {
      Array.from(el.options).forEach((o) =>
        push(o.textContent, o.value, o.disabled, o.parentElement?.label),
      );
      return out.slice(0, 300);
    }

    // Radio group: every input sharing the name attribute.
    const nm = el.getAttribute('name');
    if (nm && (el.type === 'radio' || roleOf(el) === 'radio')) {
      document
        .querySelectorAll(`input[type="radio"][name="${cssEscape(nm)}"]`)
        .forEach((r) => push(accessibleName(r), r.value, r.disabled));
      if (out.length) return out.slice(0, 100);
    }

    // ARIA listbox referenced by aria-controls / aria-owns.
    const ctrl = el.getAttribute('aria-controls') || el.getAttribute('aria-owns');
    const listbox =
      (ctrl && document.getElementById(ctrl)) ||
      el.closest('[role="radiogroup"],[role="listbox"],[role="tablist"]');
    if (listbox) {
      listbox
        .querySelectorAll('[role="option"],[role="radio"],[role="tab"],li,option')
        .forEach((o) =>
          push(accessibleName(o) || visibleText(o), o.getAttribute('data-value') || o.getAttribute('value'), o.getAttribute('aria-disabled') === 'true'),
        );
    }
    return out.slice(0, 200);
  }

  /** Nearest section heading — used to group fields in the generated form. */
  function sectionOf(el) {
    let node = el;
    for (let i = 0; i < 8 && node; i += 1) {
      node = node.parentElement;
      if (!node) break;
      const heading = node.querySelector(':scope > h1,:scope > h2,:scope > h3,:scope > h4,:scope > legend,:scope > [role="heading"]');
      if (heading) {
        const t = norm(heading.textContent);
        if (t && t.length < 60) return t;
      }
      const aria = node.getAttribute?.('aria-label');
      if (aria && aria.length < 60) return norm(aria);
    }
    return undefined;
  }

  // ── selector builders ────────────────────────────────────────────────────

  /** Index among siblings of the same tag — 1-based, matches :nth-of-type. */
  function nthOfType(el) {
    let i = 1;
    let sib = el.previousElementSibling;
    while (sib) {
      if (sib.tagName === el.tagName) i += 1;
      sib = sib.previousElementSibling;
    }
    return i;
  }

  /** Shortest structural CSS path that is unique within its root. */
  function cssPath(el, maxDepth = 6) {
    const parts = [];
    let node = el;
    for (let depth = 0; node && node.nodeType === 1 && depth < maxDepth; depth += 1) {
      let seg = node.tagName.toLowerCase();
      if (isStableId(node.id)) {
        parts.unshift(`#${cssEscape(node.id)}`);
        break;
      }
      const cls = stableClasses(node).slice(0, 2);
      if (cls.length) seg += cls.map((c) => `.${cssEscape(c)}`).join('');
      const sameTagSiblings = node.parentElement
        ? Array.from(node.parentElement.children).filter((c) => c.tagName === node.tagName)
        : [];
      if (sameTagSiblings.length > 1) seg += `:nth-of-type(${nthOfType(node)})`;
      parts.unshift(seg);

      const candidate = parts.join(' > ');
      if (countMatches(el, candidate) === 1) return candidate;
      node = node.parentElement;
    }
    return parts.join(' > ');
  }

  /** Absolute XPath — the guaranteed-resolvable last resort. */
  function xPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const segs = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      segs.unshift(`${node.tagName.toLowerCase()}[${nthOfType(node)}]`);
      node = node.parentElement;
    }
    return `/html/${segs.join('/')}`;
  }

  /**
   * Build the full candidate list for an element, best first.
   * Each candidate is independently resolvable by the Playwright runner.
   */
  function buildLocators(el) {
    const candidates = [];
    const add = (strategy, value, score, extra = {}) => {
      if (!value) return;
      candidates.push({ strategy, value: String(value), score, unique: true, ...extra });
    };

    // 1. Explicit test hooks — the most stable thing a site can give us.
    for (const attr of TESTID_ATTRS) {
      const v = el.getAttribute(attr);
      if (v) {
        const sel = `[${attr}="${v}"]`;
        add('testid', sel, countMatches(el, sel) === 1 ? 97 : 80, {
          unique: countMatches(el, sel) === 1,
        });
        break;
      }
    }

    // 2. Form `name` — real forms keep these across redesigns.
    const nameAttr = el.getAttribute('name');
    if (nameAttr && /^(input|select|textarea|button)$/i.test(el.tagName)) {
      const sel = `${el.tagName.toLowerCase()}[name="${nameAttr}"]`;
      const n = countMatches(el, sel);
      add('name', sel, n === 1 ? 90 : 62, { unique: n === 1 });
    }

    // 3. Stable id.
    if (isStableId(el.id)) {
      add('id', `#${cssEscape(el.id)}`, 88);
    }

    const accName = accessibleName(el);
    const role = roleOf(el);

    // 4. Label — the way a human describes a form control.
    if (accName && /^(textbox|searchbox|combobox|checkbox|radio|spinbutton|slider|listbox)$/.test(role)) {
      add('label', accName, 84);
    }

    // 5. Role + accessible name.
    if (accName && role !== 'generic' && accName.length <= 80) {
      add('role', role, 80, { name: accName });
    }

    // 6. Placeholder.
    const ph = el.getAttribute('placeholder');
    if (ph) add('placeholder', norm(ph), 72);

    // 7. Visible text — great for buttons and links, useless for long blobs.
    const text = norm(el.textContent);
    if (text && text.length <= 60 && /^(button|link|listitem|option|tab|heading|menuitem)$/.test(role)) {
      add('text', text, 70);
    }

    // 8. alt / title.
    const alt = el.getAttribute('alt');
    if (alt) add('altText', norm(alt), 62);
    const title = el.getAttribute('title');
    if (title) add('title', norm(title), 58);

    // 9. href for links — stable on content sites.
    if (el.tagName === 'A' && el.getAttribute('href')) {
      const href = el.getAttribute('href');
      if (href.length < 200 && !href.startsWith('javascript:')) {
        const sel = `a[href="${href}"]`;
        add('css', sel, countMatches(el, sel) === 1 ? 66 : 45);
      }
    }

    // 10. Structural CSS.
    const css = cssPath(el);
    if (css) add('css', css, countMatches(el, css) === 1 ? 45 : 30);

    // 11. XPath — always works at record time, breaks easily, hence last.
    add('xpath', xPath(el), 18);

    candidates.sort((a, b) => b.score - a.score);

    return {
      candidates: candidates.slice(0, 10),
      frame: {
        framePath: [],
        frameUrl: window.location.href,
        shadowPath: shadowPathOf(el),
      },
      snapshot: {
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || undefined,
        role,
        accessibleName: accName || undefined,
        text: clamp(text, 200) || undefined,
        html: clamp(el.outerHTML, 1200),
        attributes: attrMap(el),
        box: boxOf(el),
      },
    };
  }

  function attrMap(el) {
    const out = {};
    for (const a of Array.from(el.attributes || [])) {
      if (a.name === 'style' || a.value.length > 200) continue;
      out[a.name] = a.value;
    }
    return out;
  }

  function boxOf(el) {
    try {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    } catch {
      return undefined;
    }
  }

  /** Chain of shadow hosts from the document down to this element. */
  function shadowPathOf(el) {
    const path = [];
    let root = el.getRootNode?.();
    while (root instanceof ShadowRoot) {
      const host = root.host;
      path.unshift(cssPath(host, 4));
      root = host.getRootNode?.();
    }
    return path;
  }

  /** Everything the form compiler needs about the control itself. */
  function buildMeta(el) {
    const kind = controlKind(el);
    return {
      kind,
      label: accessibleName(el) || undefined,
      placeholder: el.getAttribute('placeholder') || undefined,
      options: ['select', 'multiselect', 'radio', 'combobox', 'toggle'].includes(kind)
        ? collectOptions(el)
        : [],
      min: el.getAttribute('min') ?? undefined,
      max: el.getAttribute('max') ?? undefined,
      step: el.getAttribute('step') ?? undefined,
      pattern: el.getAttribute('pattern') ?? undefined,
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
      section: sectionOf(el),
    };
  }

  window.__mimicLocator = {
    buildLocators,
    buildMeta,
    controlKind,
    accessibleName,
    roleOf,
    collectOptions,
    cssPath,
    xPath,
    norm,
    visibleText,
  };
})();

/**
 * Mimic — on-page recording indicator and element picker.
 * Top frame only. Everything it renders is tagged `data-mimic-ui` so the
 * recorder ignores its own chrome.
 */
(() => {
  if (window.__mimicOverlay || window.top !== window) return;

  let host = null;
  let root = null;
  let badge = null;
  let startedAt = 0;
  let timer = null;
  let picking = false;
  let onPick = null;
  let cancelPick = null;
  let highlight = null;
  let markedBox = null;
  let marked = null;

  function ensureHost() {
    if (host) return;
    host = document.createElement('div');
    host.setAttribute('data-mimic-ui', 'root');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;inset:0;pointer-events:none;';
    root = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = CSS_TEXT;
    root.appendChild(style);

    badge = document.createElement('div');
    badge.className = 'badge';
    badge.innerHTML = `
      <span class="dot"></span>
      <span class="label">Recording</span>
      <span class="time">0:00</span>
      <span class="count">0 steps</span>
      <button class="pick" type="button" title="Mark the results area">Mark results</button>
    `;
    root.appendChild(badge);

    badge.querySelector('.pick').addEventListener('click', (e) => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'mimic:request-pick' });
    });

    highlight = document.createElement('div');
    highlight.className = 'highlight';
    root.appendChild(highlight);

    markedBox = document.createElement('div');
    markedBox.className = 'marked-box';
    markedBox.innerHTML = '<span class="marked-tag">Results</span>';
    root.appendChild(markedBox);

    (document.body || document.documentElement).appendChild(host);
  }

  function tick() {
    if (!badge) return;
    const s = Math.floor((Date.now() - startedAt) / 1000);
    badge.querySelector('.time').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  function setRecording(on) {
    if (on) {
      ensureHost();
      startedAt = startedAt || Date.now();
      badge.classList.add('on');
      clearInterval(timer);
      timer = setInterval(tick, 1000);
      tick();
    } else {
      clearInterval(timer);
      startedAt = 0;
      stopPicking();
      host?.remove();
      host = null;
      badge = null;
    }
  }

  function setCount(n) {
    if (badge) badge.querySelector('.count').textContent = `${n} step${n === 1 ? '' : 's'}`;
  }

  // ── element picker ───────────────────────────────────────────────────────
  function moveHighlight(el) {
    if (!highlight || !el) return;
    const r = el.getBoundingClientRect();
    highlight.style.cssText += `;display:block;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;`;
  }

  const onMove = (e) => {
    if (!picking) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (el && !el.closest('[data-mimic-ui]')) moveHighlight(el);
  };

  /**
   * Swallow every part of the click, not just `click`.
   *
   * Sites navigate on pointerdown and mousedown as often as on click, so
   * blocking only the last of the three still opens whatever was under the
   * cursor — which is how marking a results list ends up on a video page.
   */
  const swallow = (e) => {
    if (!picking) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  };

  const onClickPick = (e) => {
    if (!picking) return;
    swallow(e);
    const el = document.elementFromPoint(e.clientX, e.clientY);
    // Grab the callback before tearing down — stopPicking() clears it.
    const cb = onPick;
    stopPicking();
    if (el && cb) {
      markPicked(el);
      cb(el);
    }
  };

  /** Leaves a lasting outline so it is obvious what got marked. */
  function markPicked(el) {
    ensureHost();
    marked = el;
    badge?.classList.add('marked');
    const label = badge?.querySelector('.pick');
    if (label) label.textContent = 'Results marked ✓';
    drawMarked();
    window.addEventListener('scroll', drawMarked, { passive: true });
    window.addEventListener('resize', drawMarked);
  }

  function drawMarked() {
    if (!marked || !markedBox) return;
    if (!marked.isConnected) {
      markedBox.style.display = 'none';
      return;
    }
    const r = marked.getBoundingClientRect();
    markedBox.style.cssText += `;display:block;top:${r.top}px;left:${r.left}px;width:${r.width}px;height:${r.height}px;`;
  }

  const onKeyPick = (e) => {
    if (picking && e.key === 'Escape') stopPicking({ cancelled: true });
  };

  function startPicking(cb, onCancel) {
    ensureHost();
    picking = true;
    onPick = cb;
    cancelPick = onCancel ?? null;
    host.style.pointerEvents = 'none';
    badge?.classList.add('picking');
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('pointerdown', swallow, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('mouseup', swallow, true);
    document.addEventListener('click', onClickPick, true);
    document.addEventListener('keydown', onKeyPick, true);
  }

  function stopPicking({ cancelled = false } = {}) {
    if (cancelled) cancelPick?.();
    picking = false;
    onPick = null;
    cancelPick = null;
    badge?.classList.remove('picking');
    if (highlight) highlight.style.display = 'none';
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('pointerdown', swallow, true);
    document.removeEventListener('mousedown', swallow, true);
    document.removeEventListener('mouseup', swallow, true);
    document.removeEventListener('click', onClickPick, true);
    document.removeEventListener('keydown', onKeyPick, true);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'mimic:count') setCount(msg.count);
  });

  const CSS_TEXT = `
    .badge{position:fixed;bottom:20px;right:20px;display:none;align-items:center;gap:10px;
      font:500 13px/1 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
      color:#2B1B10;background:#FDF6EC;border:1px solid #E8D5BC;
      box-shadow:0 8px 30px rgba(43,27,16,.18);border-radius:999px;padding:9px 9px 9px 14px;
      pointer-events:auto;}
    .badge.on{display:flex;}
    .badge.picking{outline:2px solid #F97316;}
    .dot{width:9px;height:9px;border-radius:50%;background:#F97316;box-shadow:0 0 0 0 rgba(249,115,22,.6);
      animation:pulse 1.6s ease-out infinite;}
    @keyframes pulse{to{box-shadow:0 0 0 10px rgba(249,115,22,0)}}
    .label{font-weight:600;letter-spacing:.01em;}
    .time{font-variant-numeric:tabular-nums;color:#8A6D53;}
    .count{color:#8A6D53;}
    .pick{font:600 12px/1 inherit;color:#7C2D12;background:#FFE7CE;border:1px solid #F5C79A;
      border-radius:999px;padding:6px 10px;cursor:pointer;}
    .pick:hover{background:#FFD9B0;}
    .highlight{position:fixed;display:none;pointer-events:none;border:2px solid #F97316;
      background:rgba(249,115,22,.12);border-radius:4px;transition:all .06s linear;}
    .badge.marked .pick{background:#DCFCE7;border-color:#86EFAC;color:#166534;}
    .marked-box{position:fixed;display:none;pointer-events:none;border:2px dashed #16A34A;
      background:rgba(22,163,74,.07);border-radius:6px;}
    .marked-tag{position:absolute;top:-11px;left:8px;background:#16A34A;color:#fff;
      font:600 10px/1 ui-sans-serif,system-ui,sans-serif;padding:4px 7px;border-radius:999px;
      letter-spacing:.03em;}
    @media (prefers-reduced-motion:reduce){.dot{animation:none}.highlight{transition:none}}
  `;

  window.__mimicOverlay = { setRecording, setCount, startPicking, stopPicking };
})();

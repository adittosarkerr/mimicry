const $ = (id) => document.getElementById(id);
const views = ['idle', 'recording', 'naming', 'busy', 'settings'];
let timerHandle = null;
let startedAt = 0;

const send = (msg) =>
  new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (res) => {
      if (chrome.runtime.lastError) return resolve({ ok: false, error: chrome.runtime.lastError.message });
      resolve(res || { ok: false, error: 'No response from the extension worker.' });
    });
  });

function show(view) {
  views.forEach((v) => {
    $(`view-${v}`).hidden = v !== view;
  });
}

function fail(message) {
  const el = $('error');
  el.textContent = message;
  el.hidden = !message;
}

function tick() {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  $('timer').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

async function refresh() {
  const status = await send({ type: 'mimic:status' });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    $('site').textContent = tab?.url ? new URL(tab.url).hostname : '—';
  } catch {
    $('site').textContent = '—';
  }

  if (status.recording) {
    startedAt = status.startedAt;
    $('step-count').textContent = status.steps;
    clearInterval(timerHandle);
    timerHandle = setInterval(tick, 1000);
    tick();
    show('recording');
  } else {
    show('idle');
  }

  const s = status.settings || {};
  $('runnerUrl').value = s.runnerUrl || '';
  $('webUrl').value = s.webUrl || '';
  $('ingestToken').value = s.ingestToken || '';
}

// Keep the step counter live while the popup is open.
setInterval(async () => {
  if ($('view-recording').hidden) return;
  const status = await send({ type: 'mimic:status' });
  $('step-count').textContent = status.steps ?? 0;
}, 900);

$('start').addEventListener('click', async () => {
  fail('');
  const res = await send({ type: 'mimic:start' });
  if (!res.ok) return fail(res.error);
  await refresh();
});

/*
 * There is deliberately no "mark the results area" button any more.
 *
 * Picking a region by clicking it during recording fought the page: the click
 * navigated, the overlay leaked into the trace, and the selector captured that
 * way went stale anyway. Results are now chosen after a run, from the blocks the
 * extractor actually found — see the picker on the automation page.
 */

$('stop').addEventListener('click', async () => {
  fail('');
  // Left blank on purpose: a truncated page title ("Hotels in Cox's Bazar.
  // Book your ho") is a worse name than the one the compiler writes from what
  // the recording actually does. Typing here overrides it.
  $('name').value = '';
  $('description').value = '';
  show('naming');
});

$('back').addEventListener('click', () => show('recording'));

$('discard').addEventListener('click', async () => {
  await send({ type: 'mimic:discard' });
  clearInterval(timerHandle);
  await refresh();
});

$('build').addEventListener('click', async () => {
  fail('');
  show('busy');
  $('busy-text').textContent = 'Sending your recording to the runner…';

  const res = await send({
    type: 'mimic:stop',
    meta: { name: $('name').value.trim(), description: $('description').value.trim() },
  });

  if (!res.ok) {
    show('naming');
    return fail(res.error);
  }

  $('busy-text').textContent = 'Built. Opening Mimic…';
  clearInterval(timerHandle);
  setTimeout(() => window.close(), 700);
});

$('settings-toggle').addEventListener('click', () => {
  const open = !$('view-settings').hidden;
  if (open) refresh();
  else show('settings');
});

$('close-settings').addEventListener('click', refresh);

$('save-settings').addEventListener('click', async () => {
  await send({
    type: 'mimic:save-settings',
    settings: {
      runnerUrl: $('runnerUrl').value.trim().replace(/\/$/, '') || 'http://localhost:8787',
      webUrl: $('webUrl').value.trim().replace(/\/$/, '') || 'http://localhost:3000',
      ingestToken: $('ingestToken').value.trim(),
    },
  });
  await refresh();
});

refresh();

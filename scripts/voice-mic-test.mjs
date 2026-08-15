/**
 * Drives the real voice UI with a fake microphone.
 *
 * Chromium can play a WAV file in place of a live mic, so this exercises the
 * exact browser capture path — AudioContext, resampling, WAV encoding, upload —
 * rather than testing the server in isolation.
 *
 *   node scripts/voice-mic-test.mjs [path-to-16k-mono.wav]
 */
import { chromium } from 'playwright';
import path from 'node:path';

const wav = process.argv[2] || path.join(process.env.TEMP ?? '/tmp', 'mimic-speech.wav');

const browser = await chromium.launch({
  headless: true,
  args: [
    '--use-fake-ui-for-media-stream', // auto-grant the mic permission
    '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${wav}%noloop`,
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const context = await browser.newContext({
  permissions: ['microphone'],
  viewport: { width: 1200, height: 1000 },
});
const page = await context.newPage();

page.on('pageerror', (e) => console.log('  [page error]', e.message.slice(0, 160)));
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  [console]', m.text().slice(0, 160));
});

await page.goto('http://localhost:3000/voice', { waitUntil: 'networkidle' });

console.log('tapping the mic…');
await page.getByRole('button', { name: /start listening/i }).click();
await page.waitForTimeout(600);

// Let the fake mic play the clip through.
await page.waitForTimeout(4500);

const hint = await page.locator('p.h-5').innerText().catch(() => '');
console.log('while recording:', hint.trim());

console.log('stopping…');
await page.getByRole('button', { name: /stop and use what i said/i }).click();

// Either a transcript lands in the textarea, or an error explains why not.
await page
  .waitForFunction(
    () => {
      const ta = document.querySelector('textarea');
      const err = document.querySelector('.text-rust-500');
      return Boolean((ta && ta.value.trim().length > 2) || err);
    },
    { timeout: 90_000 },
  )
  .catch(() => {});

const transcript = await page.locator('textarea').inputValue();
const error = await page
  .locator('.text-rust-500')
  .first()
  .innerText()
  .catch(() => '');

console.log('transcript:', transcript ? `"${transcript}"` : '(empty)');
if (error) console.log('error:', error.trim());

await page.screenshot({ path: process.argv[3] ?? 'voice-mic.png' });
await browser.close();

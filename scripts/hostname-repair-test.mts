/**
 * Misheard site names, repaired — and correct ones left alone.
 *
 * Both halves matter equally. A transcriber turns "daraz" into "dharas" or
 * "darajj", and an unrepaired name reaches the planner as a site nobody has
 * heard of. But repairing too eagerly is worse: "fmovies.org" was once
 * answered with a saved automation for fmovies.com — a different domain, a
 * different operator, and a page of something else entirely.
 *
 *   npx tsx scripts/hostname-repair-test.mts
 */
import { repairHostnames, resolveSpelling } from '../apps/runner/src/voice';
const known = ['www.daraz.com.bd', 'gozayaan.com', 'www.booking.com', 'waltonbd.com', 'fmovies.com', 'www.youtube.com'];
const cases: [string, string][] = [
  ['go to dharas.com and find a passport holder', 'daraz.com.bd'],
  ['go to darajj.com and find a passport holder', 'daraz.com.bd'],
  ['find a mouse on darazz.com.bd', 'daraz.com.bd'],
  ['go to daraz.com.bd and find a mouse', 'daraz.com.bd'],
  ['search fmovies.org for avengers', 'fmovies.org'],
  ['search amazon.com for a cable', 'amazon.com'],
  ['open walmart.com', 'walmart.com'],
  ['go to gozion.com for flights', 'gozayaan.com'],
  ['open youtube.com', 'youtube.com'],
];
let bad = 0;
for (const [input, want] of cases) {
  const out = repairHostnames(resolveSpelling(input), known);
  const ok = out.includes(want);
  if (!ok) bad++;
  console.log(`${ok ? ' ok ' : 'FAIL'}  ${input}\n        → ${out}${ok ? '' : `   (wanted ${want})`}`);
}
console.log(bad ? `\n${bad} failed` : '\nall correct');
process.exit(bad ? 1 : 0);

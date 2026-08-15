#!/usr/bin/env node
/**
 * What is actually configured.
 *
 * Written because a variable that exists with an empty value looks configured
 * to every `grep` and to the naked eye, and behaves exactly like one that was
 * never set. Supabase sat like that in `.env.local` — three lines present, no
 * values — while the app quietly used its browser-only fallback.
 *
 *   node scripts/check-env.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const file = ['.env.local', '.env'].map((f) => path.join(root, f)).find(existsSync);
if (!file) {
  console.log('No .env.local found. Copy .env.example to .env.local and fill it in.');
  process.exit(1);
}

const env = {};
for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
  if (match) env[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
}

const set = (key) => Boolean(env[key]);

const CHECKS = [
  {
    name: 'Recording',
    keys: ['MIMIC_INGEST_TOKEN'],
    required: true,
    without: 'The runner will reject every recording the extension sends.',
  },
  {
    name: 'AI (forms, voice, written answers)',
    keys: ['DEEPSEEK_API_KEY'],
    required: false,
    without: 'Forms are built from rules only. Voice and written answers are off.',
  },
  {
    name: 'Accounts',
    keys: ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY'],
    required: false,
    without: 'Accounts are stored in the browser only. Nothing reaches your Supabase project.',
  },
  {
    name: 'Speech to text (hosted)',
    keys: ['STT_API_KEY'],
    required: false,
    without: 'Whisper runs locally on the runner instead. This is fine.',
  },
];

let problems = 0;
console.log(`\nReading ${path.relative(root, file)}\n`);

for (const check of CHECKS) {
  const missing = check.keys.filter((k) => !set(k));
  const ok = missing.length === 0;
  if (!ok && check.required) problems += 1;

  const mark = ok ? '[32m✓[0m' : check.required ? '[31m✗[0m' : '[33m–[0m';
  console.log(`${mark} ${check.name}`);
  if (!ok) {
    console.log(`    missing: ${missing.join(', ')}`);
    console.log(`    ${check.without}`);
  }
}

if (env.MIMIC_ENFORCE_QUOTA === '1') {
  console.log('\n[33m![0m Daily run limits are being ENFORCED (MIMIC_ENFORCE_QUOTA=1).');
}

console.log(
  problems
    ? '\nSomething required is missing — see above.\n'
    : '\nNothing required is missing.\n',
);
process.exit(problems ? 1 : 0);

/**
 * Recompiles a saved automation's form from its stored recording.
 *
 * The recording is the source of truth; the form is derived from it. When the
 * compiler improves, existing automations should get the better form without
 * anyone having to record the task again.
 *
 *   node scripts/recompile.mjs <automationId> [--dry]
 *   node scripts/recompile.mjs --all [--dry]
 */
const RUNNER = process.env.RUNNER_URL || 'http://localhost:8787';
const args = process.argv.slice(2);
const dry = args.includes('--dry');
const all = args.includes('--all');
const ids = args.filter((a) => !a.startsWith('--'));

const targets = all
  ? (await fetch(`${RUNNER}/api/automations`).then((r) => r.json())).map((a) => a.id)
  : ids;

if (!targets.length) {
  console.error('usage: node scripts/recompile.mjs <automationId> | --all [--dry]');
  process.exit(1);
}

for (const id of targets) {
  const res = await fetch(`${RUNNER}/api/automations/${id}/recompile${dry ? '?dry=1' : ''}`, {
    method: 'POST',
  });
  const data = await res.json();

  if (!res.ok) {
    console.log(`${id}  ERROR  ${data.error}`);
    continue;
  }

  console.log(`${id}  ${data.name}`);
  for (const f of data.fields) {
    console.log(
      `    ${f.key.padEnd(22)} ${String(f.label).padEnd(24)} ${f.kind.padEnd(9)} ` +
        `req=${String(f.required).padEnd(5)} default=${JSON.stringify(f.defaultValue)}`,
    );
  }
}

'use client';

import { useState } from 'react';
import type { Run } from '@mimic/schema';

/**
 * The REST call and the raw JSON behind a finished run.
 *
 * Anything Mimic can do from a spoken request it can also do from a script —
 * an automation built by voice is a real automation with a real endpoint, and
 * hiding that behind the automation detail page made voice feel like a toy.
 * Collapsed by default so it never competes with the results.
 */
export function RunApiPanel({
  run,
  automationId,
  input,
}: {
  run: Run;
  automationId: string;
  input: Record<string, unknown>;
}) {
  const [tab, setTab] = useState<'rest' | 'json'>('rest');
  const [copied, setCopied] = useState(false);

  const base = process.env.NEXT_PUBLIC_RUNNER_URL || 'http://localhost:8787';
  const rest = [
    `curl -X POST ${base}/api/automations/${automationId}/run?wait=1 \\`,
    `  -H 'content-type: application/json' \\`,
    `  -d '${JSON.stringify({ values: input })}'`,
  ].join('\n');

  const json = JSON.stringify(
    {
      id: run.id,
      status: run.status,
      durationMs: run.durationMs,
      input: run.input,
      output: run.output,
      error: run.error,
    },
    null,
    2,
  );

  const code = tab === 'rest' ? rest : json;

  const copy = async () => {
    await navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <details className="group rounded-[18px] border border-sand-200 bg-white/50">
      <summary className="cursor-pointer list-none px-4 py-3 text-[13px] font-medium text-ink-700">
        Run it from code
        <span className="ml-2 text-[12px] font-normal text-ink-400">REST endpoint and JSON output</span>
      </summary>

      <div className="border-t border-sand-200 p-4">
        <div className="mb-3 flex items-center gap-1">
          {(['rest', 'json'] as const).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={
                tab === t
                  ? 'rounded-lg bg-ink-900 px-3 py-1.5 text-[12px] font-medium text-white'
                  : 'rounded-lg px-3 py-1.5 text-[12px] font-medium text-ink-500 transition-colors hover:text-ink-900'
              }
            >
              {t === 'rest' ? 'REST API' : 'JSON'}
            </button>
          ))}
          <button
            type="button"
            onClick={copy}
            className="ml-auto rounded-lg px-3 py-1.5 text-[12px] text-ink-500 transition-colors hover:text-ink-900"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>

        <pre className="max-h-[26rem] overflow-auto rounded-[14px] bg-ink-900 p-4 font-mono text-[12px] leading-relaxed text-sand-200">
          <code>{code}</code>
        </pre>
      </div>
    </details>
  );
}

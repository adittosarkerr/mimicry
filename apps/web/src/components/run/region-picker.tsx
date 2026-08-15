'use client';

import { useState } from 'react';
import { motion } from 'motion/react';
import type { Run } from '@mimic/schema';
import { api, type AutomationSummary } from '@/lib/api';
import { Button, SectionLabel } from '@/components/ui';
import { cn } from '@/lib/utils';

/**
 * Corrects a wrong results pick.
 *
 * This replaces marking a region by clicking it during recording. That approach
 * fought the page — the click navigated, the overlay leaked into the trace, and
 * a selector captured once went stale anyway. Choosing from the blocks the run
 * actually found is unambiguous: what you see listed is what the extractor is
 * choosing between, on the page it really ended up on.
 *
 * The choice is saved to the automation, so every later run uses it.
 */
export function RegionPicker({
  run,
  automation,
  onSaved,
}: {
  run: Run;
  automation: AutomationSummary;
  onSaved: (itemLocator: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const candidates = run.output?.candidates ?? [];
  if (!candidates.length) return null;

  const current = automation.schema.output.itemLocator;

  const choose = async (selector: string) => {
    setSaving(selector);
    setError(null);
    try {
      await api.updateAutomation(automation.id, {
        schema: {
          ...automation.schema,
          output: {
            ...automation.schema.output,
            itemLocator: selector,
            // A deliberate human choice — the extractor must not overrule it
            // with its own guess on the next run.
            itemLocatorPinned: true,
          },
        },
      });
      onSaved(selector);
      setOpen(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="mt-6 rounded-[18px] border border-sand-200 bg-white/50 p-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={open}
      >
        <span>
          <span className="text-[13px] font-medium text-ink-800">
            {run.output?.items.length ? 'Not the right results?' : 'Pick the results block'}
          </span>
          <span className="ml-2 text-[12.5px] text-ink-400">
            {candidates.length} repeating block{candidates.length === 1 ? '' : 's'} found on the page
          </span>
        </span>
        <motion.span animate={{ rotate: open ? 180 : 0 }} className="text-ink-400" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </motion.span>
      </button>

      {open && (
        <motion.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          className="mt-4 space-y-2"
        >
          <SectionLabel>Blocks on the final page</SectionLabel>

          {candidates.map((candidate) => {
            const active = current ? candidate.selector === current : candidate.chosen;
            return (
              <button
                key={candidate.selector}
                type="button"
                onClick={() => choose(candidate.selector)}
                disabled={saving !== null}
                className={cn(
                  'flex w-full flex-col gap-1 rounded-xl border px-3.5 py-3 text-left transition-colors',
                  active
                    ? 'border-ember-300 bg-ember-50'
                    : 'border-sand-200 bg-white hover:border-sand-400',
                  saving && 'opacity-60',
                )}
              >
                <div className="flex items-center gap-2">
                  <code className="truncate font-mono text-[12px] text-ink-900">
                    {candidate.selector}
                  </code>
                  <span className="ml-auto shrink-0 text-[11.5px] text-ink-400">
                    {candidate.count} item{candidate.count === 1 ? '' : 's'}
                  </span>
                  {active && (
                    <span className="shrink-0 rounded-full bg-ember-100 px-2 py-0.5 text-[10px] font-medium text-ember-700">
                      in use
                    </span>
                  )}
                </div>
                {candidate.samples[0] && (
                  <p className="line-clamp-2 text-[12.5px] leading-snug text-ink-500">
                    {candidate.samples[0]}
                  </p>
                )}
              </button>
            );
          })}

          {current && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => choose('')}
              disabled={saving !== null}
              className="w-full"
            >
              Clear the saved choice and detect automatically
            </Button>
          )}

          <p className="pt-1 text-[12px] leading-relaxed text-ink-400">
            Picking one saves it to this automation and applies to every future run. Run again to
            see the results it produces.
          </p>

          {error && <p className="text-[12.5px] text-rust-500">{error}</p>}
        </motion.div>
      )}
    </div>
  );
}

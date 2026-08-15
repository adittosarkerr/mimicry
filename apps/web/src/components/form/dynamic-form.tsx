'use client';

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { FormField, FormSchema } from '@mimic/schema';
import { cn } from '@/lib/utils';

/**
 * Renders the compiled schema as a real form.
 *
 * The point of Mimic is that a calendar stays a calendar and a dropdown stays a
 * dropdown, so every control here maps to the widget the recorder saw — not a
 * generic text box with a label.
 */

export type Values = Record<string, unknown>;

interface Props {
  schema: FormSchema;
  values: Values;
  onChange: (values: Values) => void;
  disabled?: boolean;
}

export function DynamicForm({ schema, values, onChange, disabled }: Props) {
  const [showAdvanced, setShowAdvanced] = useState(false);

  const { groups, advanced } = useMemo(() => {
    const visible = schema.fields.filter((f) => f.exposure !== 'constant');
    const main = visible.filter((f) => f.exposure === 'variable');
    const adv = visible.filter((f) => f.exposure === 'advanced');

    const grouped = new Map<string, FormField[]>();
    for (const f of main.sort((a, b) => a.order - b.order)) {
      const list = grouped.get(f.group) ?? [];
      list.push(f);
      grouped.set(f.group, list);
    }
    return { groups: Array.from(grouped.entries()), advanced: adv.sort((a, b) => a.order - b.order) };
  }, [schema.fields]);

  const set = (key: string, value: unknown) => onChange({ ...values, [key]: value });

  if (!groups.length && !advanced.length) {
    return (
      <p className="rounded-xl border border-dashed border-sand-300 bg-white/40 p-5 text-sm text-ink-500">
        This automation has no editable inputs — it runs exactly as recorded.
      </p>
    );
  }

  return (
    <div className="space-y-7">
      {groups.map(([group, fields]) => (
        <fieldset key={group} disabled={disabled} className="space-y-4">
          {groups.length > 1 && (
            <legend className="mb-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">
              {group}
            </legend>
          )}
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <FieldControl
                key={field.key}
                field={field}
                value={values[field.key]}
                onChange={(v) => set(field.key, v)}
                allValues={values}
              />
            ))}
          </div>
        </fieldset>
      ))}

      {advanced.length > 0 && (
        <div className="rounded-[18px] border border-sand-200 bg-white/50">
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-left"
            aria-expanded={showAdvanced}
          >
            <span className="text-sm font-medium text-ink-800">
              Advanced
              <span className="ml-2 text-[12px] font-normal text-ink-400">
                {advanced.length} preference{advanced.length === 1 ? '' : 's'}
              </span>
            </span>
            <motion.span
              animate={{ rotate: showAdvanced ? 180 : 0 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className="text-ink-400"
              aria-hidden
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
              </svg>
            </motion.span>
          </button>

          <AnimatePresence initial={false}>
            {showAdvanced && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
                className="overflow-hidden"
              >
                <fieldset disabled={disabled} className="grid gap-4 px-4 pb-4 sm:grid-cols-2">
                  {advanced.map((field) => (
                    <FieldControl
                      key={field.key}
                      field={field}
                      value={values[field.key]}
                      onChange={(v) => set(field.key, v)}
                      allValues={values}
                    />
                  ))}
                </fieldset>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}
    </div>
  );
}

/* ── one control ──────────────────────────────────────────────────────── */

const inputBase =
  'w-full rounded-xl border border-sand-300 bg-white px-3 py-2.5 text-[14px] text-ink-900 ' +
  'placeholder:text-ink-400 transition-colors focus:border-ember-400 focus:outline-none ' +
  'focus:ring-4 focus:ring-ember-500/12 disabled:opacity-60';

function FieldControl({
  field,
  value,
  onChange,
  allValues,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
  allValues: Values;
}) {
  // Conditional fields stay out of the way until they apply.
  if (field.showWhen && allValues[field.showWhen.field] !== field.showWhen.equals) return null;

  const current = value ?? field.defaultValue ?? '';
  const wide = ['textarea', 'multiselect', 'radio', 'slider'].includes(field.kind);

  return (
    <div className={cn('flex flex-col gap-1.5', wide && 'sm:col-span-2')}>
      <label htmlFor={field.key} className="flex items-baseline gap-2 text-[13px] font-medium text-ink-800">
        {field.label}
        {field.required && <span className="text-ember-500">*</span>}
        <span className="ml-auto font-mono text-[10px] font-normal text-ink-400">{field.kind}</span>
      </label>

      <Control field={field} value={current} onChange={onChange} />

      {field.hint && <p className="text-[12px] leading-relaxed text-ink-400">{field.hint}</p>}
    </div>
  );
}

function Control({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const id = field.key;

  switch (field.kind) {
    case 'textarea':
      return (
        <textarea
          id={id}
          rows={4}
          className={cn(inputBase, 'resize-y')}
          placeholder={field.placeholder}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'number':
      return (
        <input
          id={id}
          type="number"
          className={inputBase}
          placeholder={field.placeholder}
          min={field.validation.min as number | undefined}
          max={field.validation.max as number | undefined}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
        />
      );

    case 'date':
      return (
        <input
          id={id}
          type="date"
          className={inputBase}
          min={field.validation.notBefore}
          max={field.validation.notAfter}
          value={toDateInput(value)}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'time':
      return (
        <input id={id} type="time" className={inputBase} value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
      );

    case 'datetime':
      return (
        <input
          id={id}
          type="datetime-local"
          className={inputBase}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'select':
      return (
        <div className="relative">
          <select
            id={id}
            className={cn(inputBase, 'appearance-none pr-9')}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
          >
            {!field.required && <option value="">Not set</option>}
            {field.options.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
            {/* A recorded value the site no longer lists still has to be selectable. */}
            {Boolean(value) && !field.options.some((o) => o.value === value) && (
              <option value={String(value)}>{String(value)}</option>
            )}
          </select>
          <Chevron />
        </div>
      );

    case 'combobox':
      return (
        <>
          <input
            id={id}
            list={`${id}-options`}
            className={inputBase}
            placeholder={field.placeholder ?? 'Type to search on the site'}
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
          />
          {field.options.length > 0 && (
            <datalist id={`${id}-options`}>
              {field.options.map((o) => (
                <option key={o.value} value={o.label} />
              ))}
            </datalist>
          )}
          <p className="text-[11.5px] text-ink-400">
            Mimic types this into the site and picks the closest suggestion.
          </p>
        </>
      );

    case 'multiselect': {
      const selected = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className="flex flex-wrap gap-2">
          {field.options.map((o) => {
            const on = selected.includes(o.value);
            return (
              <button
                key={o.value}
                type="button"
                onClick={() =>
                  onChange(on ? selected.filter((v) => v !== o.value) : [...selected, o.value])
                }
                className={cn(
                  'rounded-full border px-3 py-1.5 text-[13px] transition-colors',
                  on
                    ? 'border-ember-300 bg-ember-100 text-ember-700'
                    : 'border-sand-300 bg-white text-ink-700 hover:border-sand-400',
                )}
              >
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }

    case 'radio':
      return (
        <div className="inline-flex flex-wrap gap-1 rounded-xl border border-sand-300 bg-white p-1">
          {field.options.map((o) => {
            const on = String(value) === o.value;
            return (
              <button
                key={o.value}
                type="button"
                onClick={() => onChange(o.value)}
                className={cn(
                  'relative rounded-lg px-3 py-1.5 text-[13px] transition-colors',
                  on ? 'text-ink-900' : 'text-ink-500 hover:text-ink-800',
                )}
              >
                {on && (
                  <motion.span
                    layoutId={`radio-${field.key}`}
                    className="absolute inset-0 rounded-lg bg-ember-100"
                    transition={{ type: 'spring', stiffness: 400, damping: 34 }}
                  />
                )}
                <span className="relative">{o.label}</span>
              </button>
            );
          })}
        </div>
      );

    case 'checkbox':
    case 'toggle': {
      const on = value === true || value === 'true';
      return (
        <button
          id={id}
          type="button"
          role="switch"
          aria-checked={on}
          onClick={() => onChange(!on)}
          className={cn(
            'inline-flex h-7 w-12 items-center rounded-full border p-0.5 transition-colors',
            on ? 'border-ember-400 bg-ember-500' : 'border-sand-300 bg-sand-200',
          )}
        >
          <motion.span
            layout
            transition={{ type: 'spring', stiffness: 500, damping: 34 }}
            className={cn('block size-5 rounded-full bg-white shadow-sm', on && 'ml-auto')}
          />
        </button>
      );
    }

    case 'slider': {
      const min = Number(field.validation.min ?? 0);
      const max = Number(field.validation.max ?? 100);
      return (
        <div className="flex items-center gap-3">
          <input
            id={id}
            type="range"
            min={min}
            max={max}
            value={Number(value ?? min)}
            onChange={(e) => onChange(Number(e.target.value))}
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-sand-200 accent-ember-500"
          />
          <span className="tabular w-14 shrink-0 text-right text-[13px] text-ink-700">
            {String(value ?? min)}
          </span>
        </div>
      );
    }

    case 'file':
      return (
        <>
          <input
            id={id}
            className={inputBase}
            placeholder="C:\\path\\to\\file.pdf"
            value={String(value ?? '')}
            onChange={(e) => onChange(e.target.value)}
          />
          <p className="text-[11.5px] text-ink-400">
            The runner reads this path from the machine it runs on.
          </p>
        </>
      );

    default:
      return (
        <input
          id={id}
          type={field.kind === 'email' ? 'email' : field.kind === 'password' ? 'password' : 'text'}
          className={inputBase}
          placeholder={field.placeholder}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

function Chevron() {
  return (
    <svg
      aria-hidden
      width="14"
      height="14"
      viewBox="0 0 14 14"
      fill="none"
      className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-ink-400"
    >
      <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

/** Coerce whatever was recorded into what <input type="date"> accepts. */
function toDateInput(value: unknown): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return '';
  return new Date(parsed).toISOString().slice(0, 10);
}

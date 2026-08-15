'use client';

import Link from 'next/link';
import { forwardRef } from 'react';
import { cn } from '@/lib/utils';

/* ── Button ─────────────────────────────────────────────────────────────── */

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
type ButtonSize = 'sm' | 'md' | 'lg';

const VARIANTS: Record<ButtonVariant, string> = {
  primary:
    'bg-ember-500 text-white shadow-[0_1px_0_0_rgba(255,255,255,0.25)_inset,0_8px_20px_-8px_rgba(234,88,12,0.6)] hover:bg-ember-600 active:bg-ember-700',
  secondary:
    'bg-white/70 text-ink-800 border border-sand-300 hover:bg-white hover:border-sand-400',
  ghost: 'text-ink-700 hover:bg-sand-100',
  danger: 'bg-rust-500 text-white hover:bg-red-700',
};

const SIZES: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[13px] gap-1.5 rounded-lg',
  md: 'h-10 px-4 text-sm gap-2 rounded-xl',
  lg: 'h-12 px-6 text-[15px] gap-2.5 rounded-xl',
};

const BASE =
  'inline-flex items-center justify-center font-medium whitespace-nowrap select-none ' +
  'transition-[background-color,border-color,transform,box-shadow] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] ' +
  'active:scale-[0.985] disabled:opacity-50 disabled:pointer-events-none';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = 'primary', size = 'md', loading, children, disabled, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(BASE, VARIANTS[variant], SIZES[size], className)}
      {...props}
    >
      {loading && <Spinner className="size-3.5" />}
      {children}
    </button>
  );
});

export function ButtonLink({
  href,
  className,
  variant = 'primary',
  size = 'md',
  children,
  ...props
}: {
  href: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  children: React.ReactNode;
} & Omit<React.ComponentProps<typeof Link>, 'href' | 'className'>) {
  return (
    <Link href={href} className={cn(BASE, VARIANTS[variant], SIZES[size], className)} {...props}>
      {children}
    </Link>
  );
}

/* ── Spinner ────────────────────────────────────────────────────────────── */

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cn(
        'inline-block size-4 shrink-0 animate-spin rounded-full border-2 border-current/25 border-t-current',
        className,
      )}
    />
  );
}

/* ── Badge ──────────────────────────────────────────────────────────────── */

type BadgeTone = 'neutral' | 'ember' | 'moss' | 'rust' | 'outline';

const TONES: Record<BadgeTone, string> = {
  neutral: 'bg-sand-100 text-ink-700 border-sand-200',
  ember: 'bg-ember-100 text-ember-700 border-ember-200',
  moss: 'bg-moss-100 text-lime-800 border-lime-200',
  rust: 'bg-rust-100 text-rust-500 border-red-200',
  outline: 'bg-transparent text-ink-500 border-sand-300',
};

export function Badge({
  tone = 'neutral',
  className,
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium leading-5',
        TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ── Card ───────────────────────────────────────────────────────────────── */

export function Card({
  className,
  children,
  interactive,
}: {
  className?: string;
  children: React.ReactNode;
  interactive?: boolean;
}) {
  return (
    <div className={cn('surface p-5', interactive && 'lift cursor-pointer', className)}>{children}</div>
  );
}

/* ── Section heading ────────────────────────────────────────────────────── */

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">
      {children}
    </span>
  );
}

/* ── Empty state ────────────────────────────────────────────────────────── */

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[18px] border border-dashed border-sand-300 bg-white/40 px-6 py-16 text-center">
      {icon && <div className="mb-4 text-ink-400">{icon}</div>}
      <h3 className="font-display text-2xl text-ink-900">{title}</h3>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-ink-500">{body}</p>
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}

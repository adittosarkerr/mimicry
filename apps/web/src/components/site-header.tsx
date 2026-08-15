'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { motion, useScroll, useMotionValueEvent } from 'motion/react';
import { useAuth } from '@/lib/auth-context';
import { Button, ButtonLink } from '@/components/ui';
import { cn } from '@/lib/utils';

const NAV = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/voice', label: 'Voice' },
  { href: '/marketplace', label: 'Marketplace' },
  { href: '/#how', label: 'How it works' },
];

export function SiteHeader() {
  const pathname = usePathname();
  const { user, signOut, loading } = useAuth();
  const { scrollY } = useScroll();
  const [condensed, setCondensed] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // The header tightens once you leave the hero — a small cue that you've
  // moved, without a jump.
  useMotionValueEvent(scrollY, 'change', (y) => setCondensed(y > 24));

  useEffect(() => setMenuOpen(false), [pathname]);

  return (
    <motion.header
      initial={false}
      animate={{
        backgroundColor: condensed ? 'rgba(253,250,245,0.82)' : 'rgba(253,250,245,0)',
        borderBottomColor: condensed ? 'rgba(242,229,211,1)' : 'rgba(242,229,211,0)',
      }}
      transition={{ duration: 0.3, ease: [0.22, 1, 0.36, 1] }}
      className="sticky top-0 z-50 border-b backdrop-blur-md"
    >
      <div className="mx-auto flex h-16 max-w-6xl items-center gap-6 px-5">
        <Link href="/" className="group flex items-center gap-2.5" aria-label="Mimic home">
          <Logo />
          <span className="font-display text-[22px] leading-none text-ink-900">Mimic</span>
        </Link>

        <nav className="ml-2 hidden items-center gap-1 md:flex">
          {NAV.map((item) => {
            const active = pathname === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  'relative rounded-lg px-3 py-1.5 text-sm transition-colors',
                  active ? 'text-ink-900' : 'text-ink-500 hover:text-ink-900',
                )}
              >
                {item.label}
                {active && (
                  <motion.span
                    layoutId="nav-active"
                    className="absolute inset-x-2 -bottom-px h-px bg-ember-500"
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  />
                )}
              </Link>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          {loading ? (
            <div className="h-8 w-24 animate-pulse rounded-lg bg-sand-100" />
          ) : user ? (
            <>
              <Link
                href="/dashboard"
                className="hidden text-sm text-ink-500 transition-colors hover:text-ink-900 sm:block"
              >
                {user.displayName || user.email.split('@')[0]}
              </Link>
              <Button variant="secondary" size="sm" onClick={() => signOut()}>
                Sign out
              </Button>
            </>
          ) : (
            <>
              <ButtonLink href="/sign-in" variant="ghost" size="sm">
                Sign in
              </ButtonLink>
              <ButtonLink href="/sign-up" size="sm">
                Get started
              </ButtonLink>
            </>
          )}

          <button
            type="button"
            aria-label="Menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            className="ml-1 rounded-lg p-2 text-ink-500 hover:bg-sand-100 md:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden>
              <path d="M2 5h14M2 9h14M2 13h14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </div>

      {menuOpen && (
        <motion.nav
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          className="overflow-hidden border-t border-sand-200 bg-sand-50/95 md:hidden"
        >
          <div className="flex flex-col px-5 py-3">
            {NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="rounded-lg px-2 py-2.5 text-sm text-ink-700 hover:bg-sand-100"
              >
                {item.label}
              </Link>
            ))}
          </div>
        </motion.nav>
      )}
    </motion.header>
  );
}

/** Three ember dots, rising — the same mark the extension uses. */
function Logo() {
  return (
    <span className="flex items-end gap-[3px]" aria-hidden>
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block size-[7px] rounded-full bg-ember-500"
          style={{ opacity: 1 - i * 0.24 }}
          animate={{ y: [0, -5, 0] }}
          transition={{
            duration: 1.6,
            repeat: Infinity,
            delay: i * 0.16,
            ease: 'easeInOut',
          }}
        />
      ))}
    </span>
  );
}

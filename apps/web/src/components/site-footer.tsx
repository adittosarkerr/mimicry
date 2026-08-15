import Link from 'next/link';

const COLUMNS = [
  {
    title: 'Product',
    links: [
      { href: '/dashboard', label: 'Dashboard' },
      { href: '/marketplace', label: 'Marketplace' },
      { href: '/#how', label: 'How it works' },
      { href: '/extension', label: 'Browser extension' },
    ],
  },
  {
    title: 'Build',
    links: [
      { href: '/#api', label: 'REST API' },
      { href: '/#outputs', label: 'Structured output' },
      { href: '/marketplace?tab=sell', label: 'Sell an automation' },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-28 border-t border-sand-200 bg-sand-100/40">
      <div className="mx-auto grid max-w-6xl gap-10 px-5 py-14 sm:grid-cols-2 lg:grid-cols-4">
        <div className="lg:col-span-2">
          <div className="flex items-center gap-2.5">
            <span className="flex items-end gap-[3px]" aria-hidden>
              <span className="block size-[7px] rounded-full bg-ember-500" />
              <span className="block size-[7px] rounded-full bg-ember-400" />
              <span className="block size-[7px] rounded-full bg-ember-300" />
            </span>
            <span className="font-display text-[22px] leading-none text-ink-900">Mimic</span>
          </div>
          <p className="mt-3 max-w-xs text-sm leading-relaxed text-ink-500">
            Record a task once. Mimic turns it into a form, then runs it headlessly whenever you
            need it.
          </p>
        </div>

        {COLUMNS.map((col) => (
          <div key={col.title}>
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">
              {col.title}
            </h3>
            <ul className="mt-4 space-y-2.5">
              {col.links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="text-sm text-ink-700 transition-colors hover:text-ember-600"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <div className="border-t border-sand-200/70">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-5 py-5 text-xs text-ink-400 sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} Mimic. Built for people who do the same thing twice.</p>
          <p>
            Payments in this build are a <span className="font-medium text-ink-500">sandbox simulation</span> —
            no real money moves.
          </p>
        </div>
      </div>
    </footer>
  );
}

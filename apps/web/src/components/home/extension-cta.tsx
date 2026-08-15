'use client';

import Link from 'next/link';
import { motion } from 'motion/react';

/**
 * Where the extension is actually got.
 *
 * Served from the app's own `public/` rather than linked off to a repository
 * page: a download that needs somebody to find the right file among twenty is
 * a download most people abandon. The `download` attribute makes the click
 * save the file rather than navigate, and the setup steps sit beside it
 * because an unpacked extension cannot be installed without them.
 */
export function ExtensionCta() {
  return (
    <section id="extension" className="border-t border-sand-200 bg-sand-100/40 py-24">
      <div className="mx-auto grid max-w-6xl items-center gap-12 px-5 lg:grid-cols-2">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.55 }}
          className="min-w-0"
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ember-600">
            The recorder
          </span>
          <h2 className="mt-3 font-display text-[clamp(2rem,4vw,3rem)] leading-[1.06] text-ink-900">
            Install it once, record anything.
          </h2>
          <p className="mt-5 max-w-md text-[15px] leading-relaxed text-ink-500">
            A Chrome extension that watches one run-through of a task and sends it to Mimic. It
            captures clicks, typing, dropdowns, calendars and counters — and never records
            passwords, card numbers or anything in a field marked secret.
          </p>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            <a
              href="/mimic-extension.zip"
              download="mimic-extension.zip"
              className="inline-flex h-12 items-center justify-center gap-2.5 rounded-xl bg-ember-500 px-6 text-[15px] font-medium text-white shadow-[0_1px_0_0_rgba(255,255,255,0.25)_inset,0_8px_20px_-8px_rgba(234,88,12,0.6)] transition-colors hover:bg-ember-600"
            >
              <DownloadIcon />
              Download the extension
            </a>
            <Link
              href="/extension"
              className="text-[14px] font-medium text-ink-700 underline underline-offset-4 hover:text-ink-900"
            >
              Setup instructions
            </Link>
          </div>

          <p className="mt-3 text-[12.5px] text-ink-400">
            Chrome, Edge or Brave · ~35 KB · unpacked, so nothing is uploaded to a store
          </p>
        </motion.div>

        <motion.ol
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: '-80px' }}
          transition={{ duration: 0.55, delay: 0.1 }}
          className="min-w-0 space-y-4 rounded-[18px] border border-sand-200 bg-white/70 p-6"
        >
          {[
            ['Unzip it', 'Anywhere you like — the folder has to stay put afterwards.'],
            ['Open chrome://extensions', 'Then switch on Developer mode, top right.'],
            ['Load unpacked', 'Choose the folder you just unzipped.'],
            ['Point it at your runner', 'Open the extension, paste your runner URL and ingest token.'],
          ].map(([title, body], i) => (
            <li key={title} className="flex gap-4">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-ember-100 font-mono text-[12px] font-semibold text-ember-700">
                {i + 1}
              </span>
              <div className="min-w-0">
                <p className="font-medium text-ink-900">{title}</p>
                <p className="mt-0.5 text-[13.5px] leading-relaxed text-ink-500">{body}</p>
              </div>
            </li>
          ))}
        </motion.ol>
      </div>
    </section>
  );
}

function DownloadIcon() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

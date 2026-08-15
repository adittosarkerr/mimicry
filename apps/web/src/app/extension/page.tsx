import Link from 'next/link';

export const metadata = {
  title: 'Install the recorder',
  description: 'Download the Mimic browser extension and connect it to your runner.',
};

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: 'Download and unzip',
    body: (
      <>
        Save <code className="font-mono text-[13px]">mimic-extension.zip</code> and unzip it
        somewhere permanent. Chrome loads an unpacked extension from the folder itself, so moving or
        deleting it later uninstalls the extension.
      </>
    ),
  },
  {
    title: 'Turn on Developer mode',
    body: (
      <>
        Open <code className="font-mono text-[13px]">chrome://extensions</code> and switch on
        <em> Developer mode</em> in the top-right corner. Edge and Brave have the same page at
        <code className="ml-1 font-mono text-[13px]">edge://extensions</code> and
        <code className="ml-1 font-mono text-[13px]">brave://extensions</code>.
      </>
    ),
  },
  {
    title: 'Load unpacked',
    body: <>Click <em>Load unpacked</em> and choose the folder you unzipped. Mimic Recorder appears in your toolbar.</>,
  },
  {
    title: 'Connect it to your runner',
    body: (
      <>
        Open the extension and set the runner URL (
        <code className="font-mono text-[13px]">http://localhost:8787</code> when running locally)
        and the ingest token — the value of{' '}
        <code className="font-mono text-[13px]">MIMIC_INGEST_TOKEN</code> in your{' '}
        <code className="font-mono text-[13px]">.env.local</code>. The runner refuses recordings
        without it.
      </>
    ),
  },
  {
    title: 'Record something',
    body: (
      <>
        Press record, do the task once, press stop. The recording is compiled into a form and shows
        up on your dashboard — claim it there to keep it on your account.
      </>
    ),
  },
];

export default function ExtensionPage() {
  return (
    <div className="mx-auto max-w-3xl px-5 py-16">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-ember-600">
        The recorder
      </span>
      <h1 className="mt-3 font-display text-[clamp(2rem,5vw,3rem)] leading-tight text-ink-900">
        Install the extension.
      </h1>
      <p className="mt-4 text-[15px] leading-relaxed text-ink-500">
        It isn’t on the Chrome Web Store — it talks to a runner you host yourself, so it ships as a
        folder you load directly. Five minutes, once.
      </p>

      <a
        href="/mimic-extension.zip"
        download="mimic-extension.zip"
        className="mt-8 inline-flex h-12 items-center justify-center gap-2.5 rounded-xl bg-ember-500 px-6 text-[15px] font-medium text-white transition-colors hover:bg-ember-600"
      >
        Download mimic-extension.zip
      </a>

      <ol className="mt-12 space-y-8">
        {STEPS.map((step, i) => (
          <li key={step.title} className="flex gap-5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-ember-100 font-mono text-[13px] font-semibold text-ember-700">
              {i + 1}
            </span>
            <div className="min-w-0">
              <h2 className="font-display text-xl text-ink-900">{step.title}</h2>
              <p className="mt-1.5 text-[14.5px] leading-relaxed text-ink-600">{step.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <div className="mt-14 rounded-[18px] border border-sand-200 bg-white/60 p-6">
        <h2 className="font-display text-xl text-ink-900">What it records</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-ink-600">
          Clicks, typing, dropdown choices, calendar dates and counters — with several ways to find
          each element, so replays survive the site changing its markup. It never records password
          fields, card numbers, CVVs or one-time codes: those are skipped before the value leaves
          the page.
        </p>
        <p className="mt-4 text-[14px] leading-relaxed text-ink-600">
          Nothing is sent anywhere except the runner you configured.{' '}
          <Link href="/#api" className="text-ember-600 underline underline-offset-2">
            Every automation is also a REST endpoint
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

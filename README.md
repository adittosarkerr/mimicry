# Mimicry

**Record a browser task once. Get a form, a REST endpoint, and structured results — forever.**

Mimicry watches you do something in a browser, works out which parts were your inputs, and turns
the whole thing into a form you can rerun headlessly with different values. Or skip the recording
entirely: say what you need, and it opens the site and works out how to do it.

```
You do it once  →  Mimicry reads what you did  →  a form with every field it found
                                                 →  POST /api/automations/:id/run
                                                 →  clean JSON, every result, every page
```

---

## What's in the box

| Piece | What it is | Stack |
|---|---|---|
| `extension/` | MV3 Chrome extension that records the task | Vanilla JS, no build |
| `apps/runner/` | Replays recordings headlessly, scrapes results, serves the API | Node · Express · Playwright · Zod |
| `apps/web/` | Marketing site, dashboard, voice studio, marketplace | Next.js 16 · React 19 · Tailwind v4 |
| `packages/schema/` | The contract every part shares | Zod |

---

## Quick start

```bash
git clone https://github.com/adittosarkerr/mimicry.git
cd mimicry
npm install
npx playwright install chromium
```

Copy the example env and fill in what you have:

```bash
cp .env.example .env.local
```

| Variable | Needed for | Notes |
|---|---|---|
| `MIMIC_INGEST_TOKEN` | Always | Any string. The extension sends it; the runner rejects recordings without it. |
| `DEEPSEEK_API_KEY` | Voice, better forms, written answers | Without it the compiler still works from rules alone. |
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | Real accounts | Without them, accounts fall back to a browser-only store and the UI says so. |
| `SUPABASE_SERVICE_ROLE_KEY` | Shared storage | Lets a deployed site work with no runner. Locally, records stay in JSON files without it. |
| `MIMIC_ENFORCE_QUOTA` | Free-plan limits | On by default — 5 runs a day. Set `0` to count without refusing. |

Check what actually got configured — an empty value looks identical to a
missing one everywhere except here:

```bash
node scripts/check-env.mjs
```

Run both halves:

```bash
npm run dev
```

- Web app → <http://localhost:3000>
- Runner → <http://localhost:8787>

The web app must be on port **3000** — the runner's CORS allowlist is `http://localhost:3000`.
Change `RUNNER_CORS` if you need a different one.

---

## Installing the recorder

The extension isn't on the Chrome Web Store: it talks to a runner you host, so it ships as a folder
you load yourself.

1. **Download** `mimic-extension.zip` — from <http://localhost:3000/extension> once the app is
   running, or from [Releases](https://github.com/adittosarkerr/mimicry/releases).
2. **Unzip** it somewhere permanent. Chrome loads it from that folder, so moving it uninstalls it.
3. Open `chrome://extensions` and turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the unzipped folder.
5. Open the extension and set:
   - **Runner URL** — `http://localhost:8787`
   - **Ingest token** — the same value as `MIMIC_INGEST_TOKEN`
6. Press record, do the task once, press stop.

Works in Chrome, Edge and Brave.

> **What it never records:** password fields, card numbers, CVVs, one-time codes. Those are
> skipped before the value leaves the page.

---

## The three ways to make an automation

**Record it.** Press record, do the task, stop. The compiler reads the trace, infers the fields, and
then goes back to the results page to find inputs your recording *couldn't* contain — nobody opens
the guest panel to confirm "2 adults" is already right, so that field would otherwise never exist.

**Say it.** `/voice` — speak a request. If a saved automation does *exactly* the same job it is
reused; otherwise one is built for the request, by opening the site and operating it one action at
a time.

**Write it.** `POST /api/voice/plan` with a transcript.

---

## Using an automation from code

Every automation is a REST endpoint the moment it exists:

```bash
curl -X POST http://localhost:8787/api/automations/au_9fK2/run?wait=1 \
  -H "Content-Type: application/json" \
  -d '{
    "destination": "Cox'\''s Bazar",
    "check_in": "2026-09-18",
    "check_out": "2026-09-22",
    "adults": 2,
    "children": 1,
    "rooms": 2
  }'
```

Returns structured JSON — every result, across every page, with prices, ratings, images and
per-result metadata typed by what the results actually are (stays, flights, products, videos,
articles, discussions, repos).

Drop `?wait=1` to get a `runId` immediately and follow the live event stream over the websocket at
`/ws`.

---

## Scripts

```bash
npm run dev            # web + runner together
npm run dev:web        # Next dev server
npm run dev:runner     # runner with watch
node scripts/extract-suite.mjs      # extraction accuracy across 14 sites
npx tsx scripts/daraz-test.mts      # Daraz end to end: form, pagination, empty state
npx tsx scripts/apply-profiles.mts  # re-form saved automations from site profiles (--write to apply)
```

---

## How it holds up

Real browsers are hostile. A few things that are deliberate rather than accidental:

- **Locators are plural.** Every element is recorded several ways — test id, accessible name,
  visible text, structure — so a site shipping new hashed class names doesn't break the replay.
- **The URL shortcut is checked.** When a recording ends on a query URL, that URL is reused
  directly. But if a field you can edit isn't expressible in it, the shortcut is refused and the
  page is driven instead — a fast wrong answer is the worst outcome available.
- **Empty is honest.** A page whose own heading says "0 properties found" reports nothing found,
  even when there are sixty uniform blocks on it. Those are the site's categories, not results.
- **Counters are one control.** "3 adults" is a step, not four clicks on a `+` that can't be
  replayed or turned into a field.

See [`PROJECT.md`](PROJECT.md) for the architecture and [`PRD.md`](PRD.md) for the product thinking.

---

## Deploying

[![Deploy the runner to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/adittosarkerr/mimicry)

Full checklist: [`DEPLOYING.md`](DEPLOYING.md).

Vercel and Supabase are enough to run all of it, including automations —
those go through a serverless Chromium, driven by the same engine. The runner
is what removes the limits.

| | Vercel + Supabase alone | With the runner too |
|---|---|---|
| Accounts, dashboard, run history | ✅ | ✅ |
| Marketplace, billing, receipts, plan limits | ✅ | ✅ |
| Recording, voice planning and authoring | ✅ | ✅ |
| Running an automation | ✅ up to ~1 min | ✅ no limit |
| Live console while it runs | shown at the end | streamed |
| Speech to text | needs `STT_API_KEY` | works offline |

The site asks the runner first for everything and answers for itself when there
is no runner to ask.

### Web app → Vercel

Run [`supabase/schema.sql`](supabase/schema.sql) once in the Supabase SQL
editor. It is one table.

Import the repo, then set **Settings → Build and Deployment → Root Directory**
to either `apps/web` or `.` — **not** `apps/runner`, which is a server and
cannot build. That field is dashboard-only; `vercel.json` has no key for it, so
a wrong value cannot be fixed by any commit.

Then set the environment variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY` | from Supabase → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | same page, `service_role` — **server-side only** |
| `NEXT_PUBLIC_RUNNER_URL` | `https://your-runner.onrender.com` |
| `NEXT_PUBLIC_RUNNER_WS` | `wss://your-runner.onrender.com` |

### Runner → anywhere that runs containers

`apps/runner/Dockerfile` builds on Playwright's own image, so Chromium and its
system libraries are already correct and matched to the version in the code.

**Render** — `render.yaml` is ready; point Render at the repo and it reads it.
**Fly** — `fly.toml` is ready: `fly launch --no-deploy` then `fly deploy`.
**Railway / anything else** — point it at `apps/runner/Dockerfile` with the repo
root as the build context.

Step-by-step, with the failure modes: [`DEPLOYING.md`](DEPLOYING.md).

Runner environment:

| Variable | Value |
|---|---|
| `MIMIC_INGEST_TOKEN` | any secret string — the extension sends this |
| `DEEPSEEK_API_KEY` | for voice, better forms, written answers |
| `RUNNER_CORS` | `https://your-app.vercel.app,https://*.vercel.app` |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | the same project as the site — otherwise the two halves keep separate records |
| `RUNNER_STORAGE_DIR` | `/data/.mimic` — with a volume mounted at `/data` |

`RUNNER_CORS` accepts a `*` wildcard for one label, which is how Vercel's
per-deployment preview domains are covered without opening it to everything.

**Give it real memory.** Chromium needs it — 2GB is comfortable, 512MB dies
partway through a run. And mount a volume: without one, every restart loses the
recordings, runs and receipts.

---

## Payments

The billing in this build is a **sandbox**. bKash, Nagad, Rocket, card and bank transfer all work
end to end — including one-time codes and declines — but no money moves and no real credential is
ever accepted or stored. Every record carries `sandbox: true`, and the UI says so on the screen.

Use an account number ending `0000` to see the declined path.

---

## Licence

MIT.

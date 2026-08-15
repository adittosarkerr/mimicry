# Deploying Mimicry

> **The short version.** Vercel hosts the site, Supabase holds the data, and
> the site works on those two alone — accounts, your saved automations, the
> marketplace, billing and receipts. Recording, running and voice need a real
> browser, so those need the runner, which goes on a container host.
>
> [![Deploy the runner to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/adittosarkerr/mimicry)

## What works where

| | Vercel + Supabase alone | With the runner too |
|---|---|---|
| Sign up, sign in, accounts | ✅ | ✅ |
| Dashboard, saved automations, run history | ✅ | ✅ |
| Marketplace: browse, publish, subscribe | ✅ | ✅ |
| Payment sandbox, receipts, plan limits | ✅ | ✅ |
| **Recording from the extension** | ❌ | ✅ |
| **Running an automation** | ❌ | ✅ |
| **Voice** | ❌ | ✅ |

The site asks the runner first for everything, and falls back to answering for
itself when there is no runner to ask. The three rows it cannot answer say so
in a sentence naming what to deploy, rather than timing out.

## Checklist

- [ ] 1. Create a Supabase project
- [ ] 2. Run [`supabase/schema.sql`](supabase/schema.sql) in its SQL editor
- [ ] 3. On Vercel, set the three Supabase variables (two public, one secret)
- [ ] 4. Set Root Directory to `apps/web` — **not** `apps/runner`
- [ ] 5. Deploy. Everything except recording, running and voice now works.
- [ ] 6. *For those three:* deploy the runner (button above, or `fly deploy`)
- [ ] 7. Give the runner the same three Supabase variables, so both halves see the same data
- [ ] 8. On Vercel, set `NEXT_PUBLIC_RUNNER_URL` and `NEXT_PUBLIC_RUNNER_WS`
- [ ] 9. On the runner, set `RUNNER_CORS` to your Vercel domain
- [ ] 10. **Redeploy Vercel** — `NEXT_PUBLIC_*` is baked in at build time

---

## 1. Supabase

### Run the schema

Supabase → **SQL Editor** → **New query** → paste
[`supabase/schema.sql`](supabase/schema.sql) → **Run**.

It creates one table. Not eight: the records stored are the same objects the
runner's JSON files hold and the schema that defines them is already Zod, in
`packages/schema`. Mirroring every field into columns would mean two
definitions of each record kept in step by hand, and the first time they drift
is the first time a receipt reaches a screen with a field missing.

Row-level security is on with no permissive policy, which means the anon key
that ships in the browser cannot touch the table at all. Every read and write
goes through a server using the service role.

### The three keys

Supabase → **Project Settings** → **API**.

| Variable | Which key | Who sees it |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL | The browser |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` `public` | The browser |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` `secret` | **Servers only** |

The first two sign people in. The third is what a server reads and writes their
data with, and it is a genuinely different thing — with the first two and not
the third, a deployment signs you in successfully and then has nowhere to put
anything, which looks like a completely different fault.

**Never prefix the service key with `NEXT_PUBLIC_`.** That prefix is what makes
a value public, and this one bypasses row-level security.

### One setting worth checking

**Authentication → Providers → Email.** If "Confirm email" is on, a new account
cannot sign in until the link is clicked, which reads as a broken sign-up. Turn
it off while testing.

Until the keys are set, accounts fall back to a browser-only store and the
sign-up page says so in as many words — that notice disappearing is how you
know it worked.

---

## 2. The web app on Vercel

### The one setting that matters

**Project → Settings → Build and Deployment → Root Directory**

This cannot be set from a file. `rootDirectory` is not a key `vercel.json`
accepts — it exists only in the dashboard, which is why a wrong value produces
errors no commit can fix:

```
Root Directory = apps/runner
  → Error: src/index.ts(1027,42): error TS2345      (it built the runner)
  → Error: output directory "apps/web/.next" was not found at
           /vercel/path0/apps/runner/apps/web/.next  (it looked inside the runner)
```

Set it to **either** of these — both work:

**Option A — `apps/web`** *(simplest)*
Leave everything else alone. Vercel detects Next.js, installs at the workspace
root, and builds.

**Option B — `.` (repository root)**
Uses the root `vercel.json`, which is already committed.

If the field currently says `apps/runner`, clear it and pick one of the above.

### Environment variables

| Variable | Value | Needed for |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL | Accounts |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase `anon` key | Accounts |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase `service_role` key | Everything the site stores |
| `NEXT_PUBLIC_RUNNER_URL` | `https://your-runner.onrender.com` | Recording, running, voice |
| `NEXT_PUBLIC_RUNNER_WS` | `wss://your-runner.onrender.com` | Live run events |
| `MIMIC_ENFORCE_QUOTA` | `0` to count runs without refusing | Optional |

The `NEXT_PUBLIC_*` ones are read at **build** time, so a change needs a
redeploy to take effect. Setting them and reloading does nothing; the values
are compiled into the JavaScript that was already built.

---

## 3. The runner on a container host

Only needed for recording, running and voice — but those are the point, so you
probably want it.

`apps/runner/Dockerfile` builds on Playwright's own image, so Chromium and its
system libraries are already correct and matched to the version in the code.

**Render** — point it at the repo; `render.yaml` is read automatically.
**Fly** — `fly launch --no-deploy`, then `fly deploy`. `fly.toml` is committed.
**Railway / other** — Dockerfile path `apps/runner/Dockerfile`, build context the
repository root.

### Environment variables

| Variable | Value |
|---|---|
| `MIMIC_INGEST_TOKEN` | Any secret string. The extension sends it; the runner rejects recordings without it. |
| `DEEPSEEK_API_KEY` | Voice, better field names, written answers. |
| `RUNNER_CORS` | `https://your-app.vercel.app,https://*.vercel.app` |
| `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` | **Give it the same project as the site.** |
| `RUNNER_STORAGE_DIR` | `/data/.mimic` — only for screenshots once Supabase is set |
| `MIMIC_ENFORCE_QUOTA` | `1` to apply the free plan's 5 runs a day. |

**Give the runner the same Supabase project as the site.** Without it the two
halves keep separate records: you record something, and the dashboard — served
by Vercel — has never heard of it. `GET /health` reports `"store":"supabase"`
or `"store":"files"`, which is the quickest way to check.

`RUNNER_CORS` accepts `*` as a wildcard for **one** label, which covers Vercel's
per-deployment preview domains without opening it to everything:

```
https://mimicry-git-main-you.vercel.app   allowed
https://vercel.app.evil.com               refused
https://a.b.vercel.app                    refused   — the wildcard cannot cross a dot
```

### Two things that will bite you otherwise

**Memory.** Chromium wants it. 2GB is comfortable; 512MB dies partway through a
run, usually as a page that half-loaded.

**Screenshots still need a volume.** Records go to Supabase, but run screenshots
stay on disk — they are large, and only ever looked at once. Without a volume
mounted at `/data` they vanish on redeploy. Both `render.yaml` and `fly.toml`
declare one.

---

## 4. Check it

```bash
curl https://your-runner.onrender.com/health
```

Expect `{"ok":true,...}` with `ai` naming a model, `stt` naming a Whisper build,
and **`"store":"supabase"`** if you wired the database in.

Locally:

```bash
node scripts/check-env.mjs
```

An empty value looks identical to a missing one everywhere except there.

A first request after an idle period boots Chromium and the local Whisper
model, so expect around 30 seconds. `fly.toml` keeps one machine warm to avoid
that; Render's starter plan does not sleep.

---

## 5. The extension

It talks to your runner directly, so after deploying, open the extension and
set:

- **Runner URL** — `https://your-runner.onrender.com`
- **Ingest token** — the same value as `MIMIC_INGEST_TOKEN`

The download lives at `/extension` on the deployed site, and on the repo's
[Releases](https://github.com/adittosarkerr/mimicry/releases) page.

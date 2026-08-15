# Deploying Mimicry

Two halves, two homes.

| | Where | Why |
|---|---|---|
| `apps/web` | Vercel | A Next.js app — nothing unusual |
| `apps/runner` | Render / Fly / Railway | Long-lived process driving a real Chromium. **Vercel cannot host it.** |

---

## 1. The web app on Vercel

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
root, and builds. The repo's root `vercel.json` is ignored, which is fine.

**Option B — `.` (repository root)**
Uses the root `vercel.json`, which is already committed:

```json
{
  "buildCommand": "npm run build -w @mimic/web",
  "outputDirectory": "apps/web/.next",
  "framework": "nextjs"
}
```

If the field currently says `apps/runner`, clear it and pick one of the above.

### Environment variables

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_RUNNER_URL` | `https://your-runner.onrender.com` |
| `NEXT_PUBLIC_RUNNER_WS` | `wss://your-runner.onrender.com` |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | same page |

These are read at **build** time, so a change needs a redeploy to take effect.

---

## 2. The runner on a container host

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
| `RUNNER_STORAGE_DIR` | `/data/.mimic` |
| `MIMIC_ENFORCE_QUOTA` | `1` to apply the free plan's 5 runs a day. |

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

**A volume.** Recordings, runs, screenshots and receipts live on disk under
`RUNNER_STORAGE_DIR`. Without a volume mounted at `/data`, every restart and
redeploy starts empty. Both `render.yaml` and `fly.toml` declare one.

---

## 3. Check it

```bash
curl https://your-runner.onrender.com/health
```

Expect `{"ok":true,...}` with `ai` naming a model and `stt` naming a Whisper
build. Then open the deployed site — the dashboard's usage tile only fills in
once the browser can actually reach the runner.

A first request after an idle period boots Chromium and the local Whisper
model, so expect around 30 seconds. `fly.toml` keeps one machine warm to avoid
that; Render's starter plan does not sleep.

---

## 4. The extension

It talks to your runner directly, so after deploying, open the extension and
set:

- **Runner URL** — `https://your-runner.onrender.com`
- **Ingest token** — the same value as `MIMIC_INGEST_TOKEN`

The download lives at `/extension` on the deployed site, and on the repo's
[Releases](https://github.com/adittosarkerr/mimicry/releases) page.

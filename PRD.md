# Mimicry — Product Requirements

**Status:** working build · sandbox payments · self-hosted
**Last updated:** 15 August 2026

---

## 1. The problem

People do the same browser task over and over: check a supplier's price list, pull this week's
listings, re-run a search with different dates, copy results into a sheet. It is ten minutes, it is
every week, and it is identical every time.

The existing answers all ask for something the person doesn't have:

| Option | What it demands |
|---|---|
| Official API | The site must have one, and it usually doesn't |
| Zapier / Make | The site must be an integration partner |
| Scraper scripts | You must be able to write and maintain code |
| RPA suites | Enterprise licence, enterprise setup |
| Agentic browsers | A full model run per execution — slow, expensive, non-deterministic |

The gap: **no code, no integration, no per-run model cost — for any site.**

---

## 2. What Mimicry is

You do the task once with a recorder running. Mimicry works out which parts were *your inputs*, and
hands back a form. Fill the form differently, run it headlessly, get structured results.

The insight: **a person doing the task once contains all the information needed to do it a thousand
times.** Everything else is inference.

### Principles

1. **The recording is the specification.** Not a prompt, not a config file.
2. **Deterministic first.** A recorded automation replays without a model in the loop. Models
   improve field names, write answers, and handle novel requests — they aren't a dependency of a
   run.
3. **Honest failure.** "The site found nothing" and "we couldn't read the page" are different
   sentences, and the user gets the right one.
4. **A fast wrong answer is the worst outcome.** Where a shortcut can't express what was asked, it
   is refused.

---

## 3. Users

| Who | Uses it for | Cares most about |
|---|---|---|
| **Operator** — procurement, travel, ops | Same search, new values, weekly | Zero setup; results they can paste into a sheet |
| **Analyst** | Watching prices and listings over time | Complete results across every page; clean JSON |
| **Builder** | Wiring a site into their own product | The REST endpoint; predictable output shape |
| **Seller** | Publishing automations others pay for | Marketplace, subscriptions, payouts |

---

## 4. Scope

### Shipped

**Recording → form**
- MV3 extension capturing clicks, typing, dropdowns, calendars, counters
- Multi-strategy locators so replays survive markup changes
- Secret fields never captured
- Rule-based compiler, then an AI pass for names and grouping
- **Harvest pass:** returns to the results page for inputs the recording *couldn't* contain
- **Counters as one control:** "3 adults" is a step, not four anonymous clicks

**Replay**
- Headless Chromium with anti-automation hardening
- URL fast path when the recording ends on a query URL, refused when it can't carry an edited field
- Site profiles for sites whose URLs weld several values into one string
- Overlay/consent clearing, challenge waiting, combobox re-verification

**Results**
- Structural detection of the repeated block that holds results
- Every page, not just the first
- Typed by what results actually are: stays, flights, products, videos, articles, discussions, repos
- Prices and ratings read from the card's own lines, so they survive markup churn
- **Written answers:** when the request implies a judgement, the results are read and answered,
  citing the items used

**Voice**
- Speak a request → matched or authored
- Reuse only on an exact match; otherwise built from scratch by operating the site
- Phonetic repair of misheard hostnames and place names

**Accounts and money**
- Sign-up / sign-in (Supabase, with a local stub for development)
- Dashboard: automations, runs, usage, billing
- Marketplace: publish, subscribe, unpublish
- **Sandbox payments:** bKash, Nagad, Rocket, card, bank — OTP, declines, receipts. No real money.
- Usage counted per day; free plan capped at 5 runs a day, enforced by default

### Not in scope for this build

- Scheduled/cron runs
- Team seats and shared workspaces
- Real payment processing
- Automations that require login (recorded credentials are deliberately not captured)
- CAPTCHA solving

---

## 5. Plans

| | Free | Starter | Pro | Team |
|---|---|---|---|---|
| Price | $0 | $9/mo | $29/mo | $99/mo |
| Runs/day | 5 | 25 | 100 | 500 |
| Automations | 5 | 25 | 200 | 1,000 |
| Seats | 1 | 1 | 1 | 5 |
| Overage | — | $0.05/run | $0.03/run | $0.02/run |

Limits are shaped by cost: each run drives a real browser for 30+ seconds. The free plan's five
runs a day are **enforced**; set `MIMIC_ENFORCE_QUOTA=0` to keep counting without refusing, which
is what you want during a testing session. Usage is counted either way, so the dashboard was
showing real numbers before the cap started biting.

---

## 6. Success measures

| Measure | Target | Where it stands |
|---|---|---|
| Extraction accuracy across a 14-site suite | ≥ 10/14 good | 9–10/14 (eBay and Reddit bot-wall us) |
| Results per run vs. what the site shows | All pages | 200/200 on a 10-page catalogue |
| Voice request → correct automation | Exact values | Verified: destination, both dates, 3 counts on agoda |
| Recording → runnable form | No manual editing | Holds where the URL is one value per parameter |
| Time to first automation | < 5 min from install | Extension install is the bulk of it |

---

## 7. Known limits

Stated plainly, because each one is a real boundary rather than a bug awaiting a fix:

- **Booking.com's scripts don't run for us.** Server-rendered content arrives; JS-injected prices
  sometimes don't. Mitigated by driving via URL parameters rather than the UI.
- **Kayak hashes its class names** and cross-sells hotels inside flight results. The item boundary
  is approximate.
- **Sites that hard-wall automation** (eBay, Reddit, DuckDuckGo) are reported as refusing, not as
  broken recordings.
- **Compound-URL sites need a profile.** Where route and dates are welded into one path segment, no
  generic `{placeholder}` can reach inside; GoZayaan, Kayak and Booking have hand-written profiles.
- **Multi-step builders** (a PC configurator) are beyond a single search-and-scrape automation.

---

## 8. What comes next

1. **Scheduled runs** — the most-asked-for thing a working automation implies.
2. **Change alerts** — "tell me when this price moves" is the natural second act.
3. **Real payments** — swap the sandbox module for a provider; the interfaces already fit.
4. **Login-gated automations** — needs a credential vault, deliberately deferred.
5. **Profiles as data** — let users write site profiles without touching the codebase.

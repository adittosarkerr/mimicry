# Mimicry — Architecture

A map of how the parts fit, and why several of them are shaped the way they are. The *why* matters
more than the *what* here: almost every unusual decision below exists because the obvious version
failed against a real site.

---

## The shape of it

```
┌────────────────┐   trace    ┌──────────────────────┐   JSON    ┌─────────────┐
│  Extension     │ ─────────▶ │  Runner              │ ────────▶ │  Web app    │
│  (MV3, no      │            │  Express+Playwright  │ ◀──────── │  Next.js    │
│   build step)  │            │                      │  values   │             │
└────────────────┘            └──────────────────────┘           └─────────────┘
                                        │
                                        ▼
                              ┌──────────────────────┐
                              │  packages/schema     │  Zod — the shared contract
                              └──────────────────────┘
```

Everything crossing a boundary is a Zod type in `packages/schema`. Change a shape there and both
sides fail to compile, which is the point.

---

## Extension — `extension/`

Vanilla JS, no build step, so what ships is what you read.

| File | Job |
|---|---|
| `content/locator.js` | Builds many locators per element, each scored for durability |
| `content/recorder.js` | Captures events; owns the delivery queue |
| `background.js` | Owns the trace; merges typing runs and combobox picks; ships it |
| `popup/` | Runner URL, ingest token, start/stop |

**Delivery is queued, acknowledged and retried.** Steps used to be posted and forgotten. An MV3
service worker is evicted after seconds of quiet and a content script dies the instant the page
navigates — so `sendMessage` fails at exactly the worst moments: the keystroke before Enter, the
click that submits. The queue lives in `sessionStorage`, so a navigation mid-delivery resumes on
the next page.

**Text is read as laid out, not concatenated.** `textContent` joins block elements with nothing
between them, so a two-line autocomplete row — "Cox's Bazar" above "Bangladesh" — was captured as
`Cox'sBazarBangladesh`. That string became the field default, went into the site's own search box on
every later run, matched nothing, and returned a page of property categories. `visibleText()` uses
`innerText` and puts a comma where the eye sees a line break.

**Counters are one step.** Four clicks on a `+` are four anonymous clicks; "Adults = 3" is a fact.
Recorded as one `stepper` step, which the compiler turns into a number field.

---

## Runner — `apps/runner/`

### Compiling a recording into a form

```
trace → normalize → heuristics → AI pass → harvest → FormSchema
```

- **normalize** (`replay/normalize.ts`) — merges typing runs, folds combobox picks into their
  search step, drops redirect navigations the *site* performed rather than the user.
- **heuristics** (`compile/heuristics.ts`) — rule-based and always runs. A DeepSeek outage degrades
  quality; it doesn't break the product.
- **AI pass** (`compile/index.ts`) — better names, grouping, result selectors. Merged *onto* the
  heuristic result; the model never overrides recorded values or option lists.
- **harvest** (`compile/harvest.ts`) — the interesting one.

**Why harvest exists.** A recording contains what the person did. Nobody opens the guest panel to
confirm "2 adults, 1 room" is already what they want — so the form comes out missing exactly the
fields the next person needs to change. Harvest goes back to the results page and asks it two
questions: what controls does your own search form have, and *do you accept this parameter?* It
sets `group_adults=3` and checks whether the page comes back saying three adults. Counting
occurrences rather than presence, because "2 rooms" also appears in "only 2 rooms left".

### Replaying

**The URL fast path.** When a recording ends on a query URL, that URL is the automation — going
straight there beats reproducing the typing. But it is checked hard:

- A placeholder with nothing to fill it is dropped, not fatal.
- Filters welded into the URL as literal text are stripped unless a visible field is switched on
  for them. *(A recording made with "breakfast included" ticked returned **0 properties** for
  Cox's Bazar; the same URL without the inherited filters returned **26**.)*
- If a field the user can edit isn't expressible in the URL, the shortcut is **refused** and the
  page is driven instead.

**Site profiles** (`sites/profiles.ts`). Some URLs weld several values into one string:

```
kayak     /flights/DAC-KUL/2026-08-25/2026-09-02/2adults
gozayaan  ?trips=KUL,DAC,2026-08-19,DAC,KUL,2026-09-20
```

No `{placeholder}` reaches inside those, so inference produced a form whose fields drove steps the
fast path skipped — every run searched the recorded trip whatever was typed. Profiles build the URL
in code instead, with city→IATA resolution. GoZayaan, Kayak and Booking.com have one.

**Widget drivers** — shared by replay and the explorer:

| Driver | Handles |
|---|---|
| `replay/calendar.ts` | Dates: attribute match → accessible name → page the month → type it. Refuses to click "the cell that says 18" in the wrong month. |
| `replay/combobox.ts` | Type, wait for suggestions, pick the best, then *verify it stuck* |
| `replay/stepper.ts` | Counters, found by shape (+ and − sharing a small ancestor with a number). Re-reads after every click, because half of them re-render. |

### Reading the results — `replay/extract.ts`

Finds the repeated block that holds results by scoring candidate signatures on link density, images,
uniformity, data-richness and distinctness. Then, per item, pulls title, url, image, price, rating
and typed metadata.

Three things learned the hard way:

- **Read the card's lines, not its class names.** Booking ships `property-card` markup to some
  sessions and hashed classes to others — the same search returned prices one run and blanks the
  next. A price sits on its own short line on every site there has ever been.
- **A currency can be its own line.** GoZayaan renders `BDT` and `4,349` separately.
- **`[class*="fare"]` matches a "View Fares" button.** An element must actually contain a price
  before it is believed.

**Empty means empty.** A page whose own `<h1>` says "0 properties found" reports nothing found —
even with sixty uniform blocks on it, because those are the site's standing categories.

### Answering — `apps/runner/src/answer.ts`

Some requests aren't satisfied by a list. "Make me a good PC under 80,000" needs somebody to read
the results and say something. The model sees **only the scraped items**, cites them by index, and
is told to say so when the results don't contain the answer — because a confident recommendation
invented from nothing is worse than none.

### Authoring from nothing — `explore.ts`

When no saved automation fits, the site is opened and operated one action at a time: read the
controls actually present, decide a single next action, do it, look again. The model never invents
an element. What comes out is a recording, replayable by the same engine.

Guards that turned it from a loop into a tool:
- Repeated actions are refused, then the control is withdrawn entirely
- `set_date` and `set_count` are first-class actions, not clicks to reason about
- Day cells can't be clicked directly, and date boxes can't be reopened once set
- It stops when the search has actually run — not when a suggestion click happened to land on a
  results URL

---

## Web app — `apps/web/`

Next.js 16, React 19, Tailwind v4, motion.dev.

| Route | What it is |
|---|---|
| `/` | Marketing, with the extension download |
| `/extension` | Install instructions |
| `/sign-in`, `/sign-up` | One form, two modes |
| `/dashboard` | Automations, runs, usage, billing |
| `/voice` | Speak a request, check the plan, run it |
| `/marketplace` | Browse, subscribe, pay |
| `/automations/[id]` | The generated form, live run console, results, REST panel |

**Output rendering is typed by result kind** — videos get thumbnails and durations, stays get prices
and ratings, articles get prose. Images that fail to load are removed rather than left as a broken
icon.

**Auth has two backends.** Supabase when configured; a browser-local store otherwise, which says
plainly that it isn't secure. Env is loaded from the repo root in `next.config.ts`, because Next
only looks beside itself and a monorepo keeps its keys one level up.

---

## Billing — sandbox

`billing.ts` + `quota.ts`. Five gateways (bKash, Nagad, Rocket, card, bank), one-time codes shown on
screen rather than sent, and a deliberate decline path: any account ending `0000` fails, so the
failure branch is one somebody has actually run. Every record carries `sandbox: true`.

Usage is counted on every run; the free-plan cap only *refuses* when `MIMIC_ENFORCE_QUOTA` is set.
Counting always means the dashboard is honest before the limit is ever switched on.

---

## Data

File-backed JSON, one record per file, atomic writes via rename (`store.ts`). Deliberately boring —
swapping for Postgres means reimplementing that module's exports and nothing else.

```
.mimic/
  automations/  runs/  screenshots/
  profiles/  listings/  subscriptions/  methods/  invoices/  usage/
```

---

## Testing

```bash
node scripts/extract-suite.mjs        # extraction across 14 real sites
npx tsx scripts/apply-profiles.mts    # re-form saved automations (--write to apply)
```

Verification here means running against the real site. Every fix in this codebase was confirmed by
a live run, because these bugs do not reproduce in a fixture.

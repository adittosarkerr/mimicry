import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { nanoid } from 'nanoid';
import {
  Trace,
  type Automation,
  type Listing,
  type PaymentMethod,
  type Run,
  type UserProfile,
} from '@mimic/schema';
import { config, originAllowed } from './config.js';
import { compileBaseline, compileTrace } from './compile/index.js';
import { harvestFields } from './compile/harvest.js';
import { runAutomation } from './replay/engine.js';
import { markFinished, publish, subscribe } from './bus.js';
import { withSlot, activeRuns, queueDepth } from './queue.js';
import {
  planFromTranscript,
  repairHostnames,
  resolveSpelling,
  sameHost,
  sitesNamedIn,
  transcribeAudio,
} from './voice.js';
import { authorAutomation, type KnownTemplate } from './authoring.js';
import { isLocalSttWarm, warmLocalStt } from './stt-local.js';
import { normalizeTrace } from './replay/normalize.js';
import { extractOutput, listRegionCandidates } from './replay/extract.js';
import { launchSession, settle, waitOutChallenge } from './replay/browser.js';
import {
  deleteAutomation,
  get as getRecord,
  getAutomation,
  getRun,
  list as listRecords,
  listAutomations,
  listRuns,
  put as putRecord,
  readScreenshot,
  remove as removeRecord,
  saveAutomation,
  saveRun,
  storeBackend,
} from './store.js';
import {
  GATEWAYS,
  SANDBOX_NOTICE,
  addPaymentMethod,
  cancelSubscription,
  gatewayFor,
  issueOtp,
  listInvoices,
  listPaymentMethods,
  listSubscriptions,
  removePaymentMethod,
  setDefaultMethod,
  subscribe as subscribeToListing,
  verifyOtp,
} from './billing.js';
import { PLANS, checkQuota, quotaFor, recordRun } from './quota.js';
import { answerFromResults } from './answer.js';

const app = express();
app.use(express.json({ limit: '32mb' })); // traces carry full-page HTML
app.use(
  cors({
    origin: (origin, cb) => {
      // Extensions send no Origin; the web app sends a configured one.
      if (!origin || originAllowed(origin) || /^chrome-extension:\/\//.test(origin)) {
        return cb(null, true);
      }
      return cb(null, false);
    },
    credentials: true,
  }),
);

const asyncRoute =
  (fn: (req: Request, res: Response) => Promise<unknown>) =>
  (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

/** Only the extension may push traces, and only with the shared token. */
function requireIngestToken(req: Request, res: Response, next: NextFunction) {
  const header = req.get('authorization') ?? '';
  const token = header.replace(/^Bearer\s+/i, '').trim();
  if (token !== config.ingestToken) {
    res.status(401).json({ error: 'Invalid ingest token. Check the extension settings.' });
    return;
  }
  next();
}

// ── health ─────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    version: '0.1.0',
    ai: config.deepseek.enabled ? config.deepseek.model : 'disabled',
    stt: config.stt.enabled
      ? config.stt.model
      : config.stt.localEnabled
        ? `${config.stt.localModel} (local)`
        : false,
    sttWarm: isLocalSttWarm(),
    /* Which store this runner is writing to. Worth reporting: "files" on a
       host with no volume means every restart forgets everything, and that is
       invisible until the day somebody notices their automations are gone. */
    store: storeBackend,
    headless: config.browser.headless,
    activeRuns: activeRuns(),
    queued: queueDepth(),
  });
});

// ── ingest: extension → runner ─────────────────────────────────────────────
app.post(
  '/api/ingest',
  requireIngestToken,
  asyncRoute(async (req, res) => {
    const parsed = Trace.safeParse(req.body?.trace);
    if (!parsed.success) {
      res.status(400).json({
        error: 'That recording could not be read.',
        issues: parsed.error.issues.slice(0, 8),
      });
      return;
    }

    // Repair the trace before anything reads it, so the compiled form and the
    // replay both work from the same corrected steps.
    const trace = { ...parsed.data, steps: normalizeTrace(parsed.data.steps) };
    if (trace.steps.length < 2) {
      res.status(400).json({ error: 'The recording is empty — nothing was captured.' });
      return;
    }

    /* Answer with the rule-based form straight away.
     *
     * The AI pass takes up to a minute on a big page. An MV3 service worker
     * holding a fetch open that long gets evicted, and the popup sits on
     * "Sending your recording to the runner…" forever with the recording lost.
     * So: save what we have, hand back the id, and refine in the background —
     * the automation page picks up the better schema when it lands. */
    const { schema, emoji, warning } = compileBaseline(trace);
    const now = Date.now();
    const givenName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';

    const automation: Automation = {
      id: `au_${nanoid(12)}`,
      ownerId: typeof req.body?.ownerId === 'string' ? req.body.ownerId : undefined,
      name: (givenName || schema.name || trace.title || `Task on ${trace.origin}`).slice(0, 120),
      description: (req.body?.description || schema.description).slice(0, 600),
      site: trace.origin,
      category: schema.category,
      emoji,
      createdAt: now,
      updatedAt: now,
      schema: { ...schema, name: givenName || schema.name },
      trace,
      stats: { runs: 0, successes: 0, failures: 0 },
      visibility: 'private',
      refining: config.deepseek.enabled,
    };

    await saveAutomation(automation);
    res.json({
      automationId: automation.id,
      fields: automation.schema.fields.length,
      refining: automation.refining,
      warning,
    });

    if (automation.refining) void refineInBackground(automation.id, givenName);
  }),
);

/**
 * Second pass over a saved automation: better field names, grouping, and result
 * selectors from the model.
 *
 * Deliberately fire-and-forget. It reloads the automation before saving so an
 * edit made while the model was thinking is not thrown away, and a failure
 * leaves the working rule-based form exactly as it was.
 */
async function refineInBackground(automationId: string, givenName: string): Promise<void> {
  try {
    const current = await getAutomation(automationId);
    if (!current) return;

    const { schema, emoji, warning } = await compileTrace(current.trace);
    const latest = (await getAutomation(automationId)) ?? current;

    await saveAutomation({
      ...latest,
      name: (givenName || schema.name || latest.name).slice(0, 120),
      description: (latest.description || schema.description).slice(0, 600),
      category: schema.category,
      emoji: emoji || latest.emoji,
      schema: { ...schema, name: givenName || schema.name },
      refining: false,
      refineWarning: warning,
      updatedAt: Date.now(),
    });

    // Then go and find the inputs the recording could not have contained.
    void harvestInBackground(automationId);
  } catch (err) {
    const latest = await getAutomation(automationId).catch(() => null);
    if (!latest) return;
    await saveAutomation({
      ...latest,
      refining: false,
      refineWarning: `AI refinement failed, so this form is the rule-based one. ${String(err).slice(0, 200)}`,
    }).catch(() => {});
  }
}

/**
 * Third pass: the inputs nobody interacted with.
 *
 * A recording contains what the person did. It cannot contain the two adults
 * and one room they were happy to leave alone, so the form comes out missing
 * exactly the fields the next person needs to change. This asks the results
 * page itself what else it accepts and adds those.
 *
 * Separate from the AI pass on purpose: it costs a browser and half a minute,
 * and the automation is fully usable the entire time it runs.
 */
export async function harvestInBackground(automationId: string): Promise<void> {
  try {
    const current = await getAutomation(automationId);
    if (!current?.schema.urlTemplate) return;

    const { fields, urlTemplate, notes } = await harvestFields(current.schema, current.trace);
    if (!fields.length) return;

    const latest = (await getAutomation(automationId)) ?? current;
    const taken = new Set(latest.schema.fields.map((f) => f.key));
    const added = fields.filter((f) => !taken.has(f.key));
    if (!added.length) return;

    // Somebody edited the automation while this was running — their template
    // wins, and rewriting it from a stale copy would undo their change.
    const templateUnchanged = latest.schema.urlTemplate === current.schema.urlTemplate;

    await saveAutomation({
      ...latest,
      schema: {
        ...latest.schema,
        fields: [...latest.schema.fields, ...added],
        groups: Array.from(new Set([...latest.schema.groups, ...added.map((f) => f.group)])),
        urlTemplate: templateUnchanged && urlTemplate ? urlTemplate : latest.schema.urlTemplate,
      },
      updatedAt: Date.now(),
    });

    console.log(`[harvest] ${automationId}: ${notes.join('; ')}`);
  } catch (err) {
    console.warn(`[harvest] ${automationId} failed:`, String(err).slice(0, 160));
  }
}

// ── automations ────────────────────────────────────────────────────────────
app.get(
  '/api/automations',
  asyncRoute(async (req, res) => {
    const ownerId = typeof req.query.ownerId === 'string' ? req.query.ownerId : undefined;
    const all = await listAutomations(ownerId);
    // Traces are heavy — the list view never needs them.
    res.json(all.map(({ trace, ...rest }) => ({ ...rest, stepCount: trace.steps.length })));
  }),
);

app.get(
  '/api/automations/:id',
  asyncRoute(async (req, res) => {
    const automation = await getAutomation(req.params.id);
    if (!automation) {
      res.status(404).json({ error: 'No automation with that id.' });
      return;
    }
    const { trace, ...rest } = automation;
    res.json({
      ...rest,
      stepCount: trace.steps.length,
      startUrl: trace.startUrl,
      finalUrl: trace.finalUrl,
    });
  }),
);

app.patch(
  '/api/automations/:id',
  asyncRoute(async (req, res) => {
    const automation = await getAutomation(req.params.id);
    if (!automation) {
      res.status(404).json({ error: 'No automation with that id.' });
      return;
    }

    const next: Automation = {
      ...automation,
      name: typeof req.body?.name === 'string' ? req.body.name.slice(0, 120) : automation.name,
      description:
        typeof req.body?.description === 'string' ? req.body.description.slice(0, 600) : automation.description,
      visibility: ['private', 'unlisted', 'public'].includes(req.body?.visibility)
        ? req.body.visibility
        : automation.visibility,
      ownerId: typeof req.body?.ownerId === 'string' ? req.body.ownerId : automation.ownerId,
      // Field-level edits (labels, exposure, defaults) come back as a whole schema.
      schema: req.body?.schema ?? automation.schema,
      updatedAt: Date.now(),
    };

    await saveAutomation(next);
    const { trace, ...rest } = next;
    res.json(rest);
  }),
);

/**
 * Rebuilds an automation's form from the recording it already has.
 *
 * The trace is the durable artefact; the form is derived from it. So when the
 * compiler learns something — that a bare "21" is not a date, that a stepper
 * with no readable value must not be marked required — every automation
 * already saved can pick that up without anyone recording the task again.
 */
app.post(
  '/api/automations/:id/recompile',
  asyncRoute(async (req, res) => {
    const automation = await getAutomation(req.params.id);
    if (!automation) {
      res.status(404).json({ error: 'No automation with that id.' });
      return;
    }

    /* Only recordings can be recompiled.
     *
     * An authored automation has no recording behind it — its "trace" is a
     * single templated navigation, and its field values live in the schema
     * rather than in any captured step. Running the recording compiler over
     * that strips every default and leaves a form that does nothing. */
    if (/\(authored\)/.test(automation.schema.compiledBy)) {
      res.status(400).json({
        error:
          'This automation was written from a description, not recorded, so there is no recording to rebuild the form from.',
      });
      return;
    }

    const trace = { ...automation.trace, steps: normalizeTrace(automation.trace.steps) };
    const { schema, emoji } = await compileTrace(trace);

    if (!req.query.dry) {
      await saveAutomation({
        ...automation,
        trace,
        schema: { ...schema, name: automation.schema.name },
        category: schema.category,
        emoji: emoji || automation.emoji,
        updatedAt: Date.now(),
      });
    }

    res.json({
      id: automation.id,
      name: automation.name,
      dry: Boolean(req.query.dry),
      fields: schema.fields.map((f) => ({
        key: f.key,
        label: f.label,
        kind: f.kind,
        required: f.required,
        defaultValue: f.defaultValue,
        group: f.group,
      })),
    });
  }),
);

app.delete(
  '/api/automations/:id',
  asyncRoute(async (req, res) => {
    const ok = await deleteAutomation(req.params.id);
    res.status(ok ? 200 : 404).json({ ok });
  }),
);

/**
 * Opens a URL and reports what the extractor sees, without running an
 * automation. Exists so extraction can be tested across many sites at once
 * instead of being tuned against whichever site last failed.
 */
app.post(
  '/api/debug/extract',
  asyncRoute(async (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url : '';
    if (!/^https?:\/\//i.test(url)) {
      res.status(400).json({ error: 'A http(s) url is required.' });
      return;
    }

    const session = await launchSession({});
    try {
      /* A slow page is not a failed page. Waiting for DOM-ready is right, but
         timing out on it should not abort the probe — the extractor waits for
         real content on its own, so let it look at whatever arrived. */
      await session.page
        .goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        .catch((err: Error) => {
          if (!/Timeout/i.test(err.message)) throw err;
        });
      await settle(session.page, 6000);
      await waitOutChallenge(session.page);

      const output = await extractOutput(session.page, {
        spec: {
          layout: ['cards', 'detail', 'list', 'confirmation'].includes(req.body?.layout)
            ? req.body.layout
            : 'cards',
          itemLocator: typeof req.body?.itemLocator === 'string' ? req.body.itemLocator : undefined,
          itemLocatorPinned: Boolean(req.body?.pinned),
          fields: [],
          emptyStateHints: ['no results', 'nothing found', '0 results'],
          unavailableHints: ['sold out', 'unavailable', 'out of stock'],
        },
        maxPages: Number(req.body?.pages) || 1,
      });

      const candidates = await listRegionCandidates(session.page);
      const shot = await session.page
        .screenshot({ type: 'png', timeout: 8000 })
        .then((b) => b.toString('base64'))
        .catch(() => undefined);

      res.json({
        url,
        finalUrl: output.finalUrl,
        itemCount: output.items.length,
        resultKind: output.resultKind,
        document: output.document
          ? {
              title: output.document.title,
              wordCount: output.document.wordCount,
              sections: output.document.sections.length,
              firstHeadings: output.document.sections.slice(0, 5).map((s) => s.heading),
              lead: output.document.summary?.slice(0, 160),
            }
          : undefined,
        items: output.items.slice(0, 6).map((i) => ({
          title: i.title.slice(0, 90),
          hasImage: Boolean(i.image),
          hasUrl: Boolean(i.url),
          price: i.price?.formatted,
          meta: i.meta,
          attributes: i.attributes.map((a) => a.value).slice(0, 3),
        })),
        candidates,
        emptyReason: output.emptyReason,
        screenshot: shot,
      });
    } finally {
      await session.close();
    }
  }),
);

/**
 * Streams a result thumbnail through the runner.
 *
 * Many sites serve images with `Cross-Origin-Resource-Policy: same-site`, which
 * makes the browser refuse to render them on Mimic's pages — the request dies
 * with ERR_BLOCKED_BY_RESPONSE and the card shows an empty box. Server-side
 * fetches are not subject to that, so the image arrives here and goes out again
 * as same-origin.
 */
app.get(
  '/api/image',
  asyncRoute(async (req, res) => {
    const raw = typeof req.query.u === 'string' ? req.query.u : '';

    let target: URL;
    try {
      target = new URL(raw);
    } catch {
      res.status(400).json({ error: 'A url is required.' });
      return;
    }

    if (!/^https?:$/.test(target.protocol)) {
      res.status(400).json({ error: 'Only http(s) images can be fetched.' });
      return;
    }

    /* This endpoint takes a URL from the page and fetches it. Without a guard
       that is a request-forgery hole pointed at whatever the runner can reach —
       cloud metadata endpoints, services on the same machine. Public hosts
       only. */
    const host = target.hostname.toLowerCase();
    const isPrivate =
      host === 'localhost' ||
      host.endsWith('.localhost') ||
      host === '::1' ||
      /^127\./.test(host) ||
      /^10\./.test(host) ||
      /^192\.168\./.test(host) ||
      /^169\.254\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      /^(0\.|\[?::)/.test(host);
    if (isPrivate) {
      res.status(403).json({ error: 'That address is not fetchable.' });
      return;
    }

    const abort = AbortSignal.timeout(12_000);
    const upstream = await fetch(target, {
      signal: abort,
      headers: {
        // Some hosts refuse requests with no referer, or with a foreign one.
        referer: target.origin,
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      },
    }).catch(() => null);

    const type = upstream?.headers.get('content-type') ?? '';
    if (!upstream?.ok || !type.startsWith('image/')) {
      res.status(502).json({ error: 'That image could not be fetched.' });
      return;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > 8 * 1024 * 1024) {
      res.status(413).json({ error: 'That image is too large to proxy.' });
      return;
    }

    res.setHeader('content-type', type);
    res.setHeader('cache-control', 'public, max-age=86400');
    res.setHeader('cross-origin-resource-policy', 'cross-origin');
    res.send(body);
  }),
);

// ── voice ──────────────────────────────────────────────────────────────────

/**
 * Audio → text. Used when the browser's own speech recognition is unavailable,
 * which is the normal case in Brave and in Chromium builds without Google's
 * speech backend.
 */
app.post(
  '/api/voice/transcribe',
  express.raw({ type: ['audio/*', 'application/octet-stream'], limit: '25mb' }),
  asyncRoute(async (req, res) => {
    const audio = req.body as Buffer;
    if (!Buffer.isBuffer(audio) || audio.length < 512) {
      res.status(400).json({ error: 'No audio received.' });
      return;
    }

    const mimeType = req.get('content-type') || 'audio/webm';
    const extension = mimeType.includes('ogg') ? 'ogg' : mimeType.includes('mp4') ? 'mp4' : 'webm';

    try {
      const heard = await transcribeAudio(audio, `speech.${extension}`, mimeType);

      /* Fix site names before anyone sees them. A transcriber turns "gozayaan
         dot com" into "gozion.com", and by the time that reaches the planner
         it is just a site nobody has heard of. The user's own automations name
         the sites they talk about, so they are the correction key. */
      const sites = (await listAutomations().catch(() => [])).map((a) => a.site);
      /* Spelling asides first: somebody spelling a name out is correcting an
         earlier mishearing, and the spelled version is itself mangled often
         enough that it must not be allowed to win by looking more like a
         hostname than the correct name beside it. */
      const transcript = repairHostnames(resolveSpelling(heard), sites);

      res.json({ transcript, heard: transcript === heard ? undefined : heard });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(config.stt.enabled ? 502 : 503).json({ error: message });
    }
  }),
);

/**
 * Turns a spoken request into a plan. The browser does the speech-to-text and
 * posts the transcript here; this picks the automation and fills its fields.
 */
app.post(
  '/api/voice/plan',
  asyncRoute(async (req, res) => {
    const spoken = typeof req.body?.transcript === 'string' ? req.body.transcript.trim() : '';
    /* Repaired again here: the browser's own recogniser mangles site names too,
       and that path never touches the transcription route. */
    const transcript = spoken
      ? repairHostnames(
          resolveSpelling(spoken),
          (await listAutomations().catch(() => [])).map((a) => a.site),
        )
      : '';
    if (!transcript) {
      res.status(400).json({ error: 'No transcript supplied.' });
      return;
    }
    if (!config.deepseek.enabled) {
      res.status(503).json({ error: 'Voice needs DEEPSEEK_API_KEY to be set on the runner.' });
      return;
    }

    const ownerId = typeof req.body?.ownerId === 'string' ? req.body.ownerId : undefined;
    const all = await listAutomations(ownerId);

    /* "Make me an automation that…" is a request to build, not to find.
     *
     * Answering it with something already saved is the one response that
     * cannot be right — the person has told you they want a new one. Skipping
     * the matcher entirely is more honest than hoping it scores the near-miss
     * low enough. */
    const wantsNew =
      /\b(make|build|create|write|set\s*up|author)\b[^.?!]{0,30}\b(automation|workflow|task|bot|script)\b/i.test(
        transcript,
      ) || /\bfrom scratch\b|\bbrand new\b|\bnew automation\b/i.test(transcript);

    const known = knownTemplates(all);

    if (wantsNew) {
      const authored = await authorAutomation(transcript, ownerId, known);
      if (authored.automation) {
        await saveAutomation(authored.automation);
        res.json(builtResponse(authored.automation, authored.confidence));
        void harvestInBackground(authored.automation.id);
        return;
      }
      res.json({
        automationId: null,
        confidence: authored.confidence,
        values: {},
        say: "I couldn't build that one.",
        missing: [],
        created: false,
        automation: null,
        suggestion: authored.refusal,
      });
      return;
    }

    /* Only offer things known to work.
     *
     * A recording is proof by construction — a person did the task and Mimic
     * watched. An authored automation is a proposal until it has actually
     * produced results once, and matching a spoken request to an untested
     * proposal is how a request for flights ends up replaying a guessed URL
     * that returns a page of navigation tiles. Authoring a fresh one is
     * cheap; running a bad match is not. */
    /* A site named out loud is not a suggestion.
     *
     * "fmovies.org" was answered with a saved automation for fmovies.com at 95%
     * confidence — a different domain, a different operator, and in that case a
     * page of something else entirely. The model reads the two as the same word
     * however firmly the prompt says otherwise, so the rule is enforced here
     * instead: name a host and only that host is eligible. */
    const namedSites = sitesNamedIn(transcript);

    const automations = all.filter((a) => {
      if (namedSites.length && !namedSites.some((host) => sameHost(host, a.site))) return false;

      const authored = /\(authored\)/.test(a.schema.compiledBy);
      if (authored && !a.verifiedAt) return false;

      /* Something that has been run and has never once worked is not a
         candidate. Offering it costs the person a minute of watching a browser
         fail at a task another automation could have done. */
      if (a.stats.runs >= 2 && a.stats.successes === 0) return false;
      return true;
    });

    const plan = await planFromTranscript(transcript, automations);

    const chosen = plan.automationId ? automations.find((a) => a.id === plan.automationId) : undefined;
    if (chosen) {
      res.json({
        ...plan,
        created: false,
        automation: { id: chosen.id, name: chosen.name, site: chosen.site, emoji: chosen.emoji, schema: chosen.schema },
      });
      return;
    }

    /* Nothing recorded fits. Rather than dead-ending, author one: the replay
       engine resolves elements by meaning, so a described automation is a
       runnable automation. */
    const authored = await authorAutomation(transcript, ownerId, known);
    if (!authored.automation) {
      res.json({
        ...plan,
        created: false,
        automation: null,
        suggestion: authored.refusal ?? plan.suggestion,
      });
      return;
    }

    await saveAutomation(authored.automation);
    res.json(builtResponse(authored.automation, authored.confidence));
    void harvestInBackground(authored.automation.id);
  }),
);

/**
 * URL shapes learned from recordings, one per site.
 *
 * Every recording that ended on a query URL teaches Mimic how that site takes
 * its inputs — the exact parameter names, and what a real value looks like in
 * each. Handing those to the author turns "I don't know that site's URL" into
 * "here is one that worked", which is the difference between refusing a
 * complex request and fulfilling it.
 */
function knownTemplates(automations: Automation[]): KnownTemplate[] {
  const bySite = new Map<string, KnownTemplate>();

  for (const automation of automations) {
    const template = automation.schema.urlTemplate;
    if (!template) continue;
    // A recording beats an authored guess as a source of truth.
    const authored = /\(authored\)/.test(automation.schema.compiledBy);
    if (authored && bySite.has(automation.site)) continue;

    bySite.set(automation.site, {
      site: automation.site,
      template,
      fields: automation.schema.fields
        .filter((f) => template.includes(`{${f.key}}`))
        .map((f) => ({
          key: f.key,
          label: f.label,
          kind: f.kind,
          example: f.defaultValue,
        })),
    });
  }

  return Array.from(bySite.values()).slice(0, 12);
}

/** The shape the voice studio expects for a freshly authored automation. */
function builtResponse(built: Automation, confidence: number) {
  return {
    automationId: built.id,
    confidence,
    // Authored automations carry their own defaults, taken from the request.
    values: Object.fromEntries(
      built.schema.fields
        .filter((f) => f.defaultValue !== null && f.defaultValue !== undefined)
        .map((f) => [f.key, f.defaultValue]),
    ),
    say: `I built this: ${built.name}.`,
    missing: built.schema.fields.filter((f) => f.required && f.defaultValue == null).map((f) => f.key),
    created: true,
    automation: {
      id: built.id,
      name: built.name,
      site: built.site,
      emoji: built.emoji,
      schema: built.schema,
    },
  };
}

// ── runs ───────────────────────────────────────────────────────────────────

/**
 * The generated REST endpoint. This is exactly what the UI shows on the
 * automation page, so a user can curl their automation from anywhere.
 *
 *   POST /api/automations/:id/run   { "destination": "Bangkok", ... }
 *   ?wait=1  → block until the run finishes and return the output inline
 */
app.post(
  '/api/automations/:id/run',
  asyncRoute(async (req, res) => {
    const automation = await getAutomation(req.params.id);
    if (!automation) {
      res.status(404).json({ error: 'No automation with that id.' });
      return;
    }

    const values = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const wait = req.query.wait === '1' || req.query.wait === 'true';
    const headless = req.query.headful === '1' ? false : undefined;
    // Reserved keys never reach the form — they configure the run itself.
    // Two by default: enough to pick up a real second page, few enough that a
    // site with an awkward pager can't turn a 30s run into two minutes.
    /* Walk the whole result set by default.
     *
     * Two pages was a hedge against slow runs, and it meant a catalogue with
     * seven pages reported forty products as though that were all of them. The
     * loop already stops the moment a page adds nothing new, so the ceiling
     * only costs time on sites that genuinely have that much to give. */
    const maxPages = Number(req.query.pages ?? values.__pages ?? 10);
    delete values.__pages;

    /* What the person actually asked for, when there was a sentence — the
       spoken request. Used to write an answer from the results afterwards, so
       "make me a good PC under 80,000" gets a recommendation rather than two
       hundred products to read through. */
    const spokenRequest = typeof values.__request === 'string' ? values.__request : '';
    delete values.__request;

    // Required fields are enforced here so a bad call fails fast and clearly.
    const missing = automation.schema.fields
      .filter((f) => f.required && f.exposure !== 'constant')
      .filter((f) => {
        const v = values[f.key] ?? f.defaultValue;
        return v === undefined || v === null || v === '';
      })
      .map((f) => f.key);

    if (missing.length) {
      res.status(422).json({ error: 'Missing required fields', missing });
      return;
    }

    /* The free plan's daily allowance.
     *
     * Counted always, refused only when MIMIC_ENFORCE_QUOTA is set — so this
     * cannot get in the way of testing, and the dashboard still shows honest
     * numbers before the cap is ever switched on. */
    const runnerUserId =
      (typeof req.body?.__userId === 'string' ? req.body.__userId : undefined) ??
      userIdOf(req) ??
      automation.ownerId;

    const verdict = await checkQuota(runnerUserId);
    if (!verdict.allowed) {
      res.status(429).json({ error: verdict.message, quota: verdict.state });
      return;
    }
    await recordRun(runnerUserId);

    const runId = `run_${nanoid(12)}`;
    const seed: Run = {
      id: runId,
      automationId: automation.id,
      userId: runnerUserId,
      status: 'queued',
      startedAt: Date.now(),
      input: values,
      events: [],
    };
    await saveRun(seed);

    const work = withSlot(async () => {
      const run = await runAutomation({
        automation,
        values,
        runId,
        userId: seed.userId,
        headless,
        maxPages: Number.isFinite(maxPages) ? maxPages : 10,
        emit: (event) => publish(event),
      });

      /* Read the results and say something, when the request called for a
         judgement. Never allowed to fail the run: the items are the product,
         the commentary is a bonus on top of them. */
      if (run.status === 'succeeded' && run.output?.items?.length && spokenRequest) {
        const answer = await answerFromResults({ request: spokenRequest, output: run.output }).catch(
          () => undefined,
        );
        if (answer) run.output = { ...run.output, answer };
      }

      await saveRun(run);

      const stats = { ...automation.stats };
      stats.runs += 1;
      if (run.status === 'succeeded') stats.successes += 1;
      else if (run.status === 'failed') stats.failures += 1;
      stats.lastRunAt = run.finishedAt ?? Date.now();
      stats.avgDurationMs = stats.avgDurationMs
        ? Math.round((stats.avgDurationMs * (stats.runs - 1) + (run.durationMs ?? 0)) / stats.runs)
        : run.durationMs;

      /* An authored automation that was verified at build time and then failed
         in the real world is no longer proven. Dropping the badge takes it out
         of the pool the voice matcher draws from, so the next similar request
         gets a fresh attempt instead of the same broken plan. */
      const stillVerified =
        automation.verifiedAt && run.status !== 'failed' && run.status !== 'partial'
          ? automation.verifiedAt
          : undefined;

      await saveAutomation({
        ...automation,
        stats,
        verifiedAt: stillVerified,
        updatedAt: Date.now(),
      });

      markFinished(runId);
      return run;
    });

    if (wait) {
      const run = await work;
      res.json(publicRun(run));
      return;
    }

    // Fire and forget — the client follows along over the websocket.
    work.catch(async (err) => {
      const failed: Run = {
        ...seed,
        status: 'failed',
        finishedAt: Date.now(),
        error: { code: 'internal', message: err instanceof Error ? err.message : String(err) },
      };
      await saveRun(failed);
      markFinished(runId);
    });

    res.status(202).json({
      runId,
      status: 'queued',
      stream: `${config.corsOrigins[0] ? '' : ''}/ws?runId=${runId}`,
      poll: `/api/runs/${runId}`,
    });
  }),
);

app.get(
  '/api/runs/:id',
  asyncRoute(async (req, res) => {
    const run = await getRun(req.params.id);
    if (!run) {
      res.status(404).json({ error: 'No run with that id.' });
      return;
    }
    res.json(publicRun(run));
  }),
);

app.get(
  '/api/runs',
  asyncRoute(async (req, res) => {
    const automationId = typeof req.query.automationId === 'string' ? req.query.automationId : undefined;
    const runs = await listRuns(automationId, Number(req.query.limit) || 30);
    res.json(runs.map((r) => ({ ...publicRun(r), events: undefined })));
  }),
);

// ── screenshots ────────────────────────────────────────────────────────────
app.get(
  '/api/screenshots/:key',
  asyncRoute(async (req, res) => {
    const buf = await readScreenshot(req.params.key);
    if (!buf) {
      res.status(404).end();
      return;
    }
    res.setHeader('content-type', 'image/png');
    res.setHeader('cache-control', 'public, max-age=86400');
    res.end(buf);
  }),
);

/* ── accounts, marketplace, payments ──────────────────────────────────────
 *
 * The account itself lives with the auth provider (Supabase, or the local stub
 * during development). What is kept here is everything the runner needs to
 * answer for: which plan somebody is on, what they have published or
 * subscribed to, and the sandbox receipts. The id is taken from the request
 * because this build has no session layer yet — which is fine for a sandbox and
 * would not be for real money, so nothing here can move any.
 */

const userIdOf = (req: Request): string | undefined => {
  const raw = req.header('x-mimic-user') ?? (req.body as { userId?: string } | undefined)?.userId;
  const id = typeof raw === 'string' ? raw.trim() : '';
  return /^[\w-]{3,64}$/.test(id) ? id : undefined;
};

const requireUser = (req: Request, res: Response): string | undefined => {
  const id = userIdOf(req);
  if (!id) {
    res.status(401).json({ error: 'Sign in first — this needs an account.' });
    return undefined;
  }
  return id;
};

app.get(
  '/api/me',
  asyncRoute(async (req, res) => {
    const userId = userIdOf(req);
    const profile = userId ? await getRecord<UserProfile>('profiles', userId) : null;
    res.json({
      profile,
      quota: await quotaFor(userId),
      plans: PLANS,
    });
  }),
);

app.put(
  '/api/me',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const body = req.body as { email?: string; displayName?: string; plan?: string };
    const existing = await getRecord<UserProfile>('profiles', userId);
    const profile: UserProfile = {
      id: userId,
      email: String(body.email ?? existing?.email ?? '').slice(0, 200),
      displayName: body.displayName?.slice(0, 80) ?? existing?.displayName,
      avatarUrl: existing?.avatarUrl,
      createdAt: existing?.createdAt ?? Date.now(),
      plan: (['free', 'pro', 'team'] as const).includes(body.plan as 'free')
        ? (body.plan as UserProfile['plan'])
        : (existing?.plan ?? 'free'),
    };
    res.json(await putRecord('profiles', profile));
  }),
);

// ── marketplace ────────────────────────────────────────────────────────────
app.get(
  '/api/listings',
  asyncRoute(async (_req, res) => {
    const listings = await listRecords<Listing>('listings');
    res.json(listings.sort((a, b) => Number(b.featured) - Number(a.featured) || b.createdAt - a.createdAt));
  }),
);

app.post(
  '/api/listings',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const body = req.body as Partial<Listing> & { automationId?: string };
    const automation = body.automationId ? await getAutomation(body.automationId) : null;
    if (!automation) {
      res.status(400).json({ error: 'Publish an automation you own.' });
      return;
    }
    if (automation.ownerId && automation.ownerId !== userId) {
      res.status(403).json({ error: 'That automation belongs to someone else.' });
      return;
    }

    const listing: Listing = {
      id: `lst_${nanoid(12)}`,
      automationId: automation.id,
      sellerId: userId,
      sellerName: String(body.sellerName ?? 'A Mimic user').slice(0, 80),
      title: String(body.title ?? automation.name).slice(0, 120),
      tagline: String(body.tagline ?? automation.description).slice(0, 160),
      description: String(body.description ?? automation.description).slice(0, 2000),
      category: automation.category,
      tags: (body.tags ?? []).slice(0, 8).map((t) => String(t).slice(0, 24)),
      coverEmoji: String(body.coverEmoji ?? automation.emoji).slice(0, 8),
      priceMinor: Math.max(0, Math.round(Number(body.priceMinor ?? 0))),
      currency: String(body.currency ?? 'BDT').slice(0, 8),
      interval: (['month', 'year', 'one_time'] as const).includes(body.interval as 'month')
        ? (body.interval as Listing['interval'])
        : 'month',
      trialDays: Math.max(0, Math.min(60, Math.round(Number(body.trialDays ?? 0)))),
      rating: 0,
      ratingCount: 0,
      subscribers: 0,
      runsThisMonth: 0,
      featured: false,
      createdAt: Date.now(),
    };

    await putRecord('listings', listing);
    await saveAutomation({ ...automation, listingId: listing.id, visibility: 'public' });
    res.json(listing);
  }),
);

app.delete(
  '/api/listings/:id',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const listing = await getRecord<Listing>('listings', req.params.id);
    if (!listing || listing.sellerId !== userId) {
      res.status(404).json({ error: 'No such listing.' });
      return;
    }
    res.json({ ok: await removeRecord('listings', listing.id) });
  }),
);

// ── payment methods ────────────────────────────────────────────────────────
app.get('/api/payment/gateways', (_req, res) => {
  res.json({ gateways: GATEWAYS, notice: SANDBOX_NOTICE });
});

app.get(
  '/api/payment/methods',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    res.json(await listPaymentMethods(userId));
  }),
);

/** Step one of adding a method: the gateway "sends" a code. */
app.post(
  '/api/payment/methods/start',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const kind = String((req.body as { kind?: string }).kind ?? '');
    const gateway = gatewayFor(kind);
    if (!gateway) {
      res.status(400).json({ error: `Unknown payment method: ${kind}` });
      return;
    }
    // Bank transfer has nothing to confirm, so it skips straight to adding.
    res.json(gateway.otp ? issueOtp(userId, `add:${kind}`) : { challengeId: null, code: null });
  }),
);

app.post(
  '/api/payment/methods',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const body = req.body as {
      kind?: PaymentMethod['kind'];
      account?: string;
      brand?: string;
      expiry?: string;
      challengeId?: string;
      code?: string;
      makeDefault?: boolean;
    };

    const gateway = gatewayFor(String(body.kind));
    if (!gateway) {
      res.status(400).json({ error: 'Choose a payment method.' });
      return;
    }

    if (gateway.otp) {
      const verdict = verifyOtp(String(body.challengeId ?? ''), String(body.code ?? ''));
      if (!verdict.ok) {
        res.status(400).json({ error: verdict.error });
        return;
      }
    }

    try {
      res.json(
        await addPaymentMethod({
          userId,
          kind: body.kind!,
          account: String(body.account ?? ''),
          brand: body.brand,
          expiry: body.expiry,
          makeDefault: body.makeDefault,
        }),
      );
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  }),
);

app.post(
  '/api/payment/methods/:id/default',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const method = await setDefaultMethod(userId, req.params.id);
    if (!method) {
      res.status(404).json({ error: 'No such payment method.' });
      return;
    }
    res.json(method);
  }),
);

app.delete(
  '/api/payment/methods/:id',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    res.json({ ok: await removePaymentMethod(userId, req.params.id) });
  }),
);

app.get(
  '/api/payment/invoices',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    res.json(await listInvoices(userId));
  }),
);

// ── subscriptions ──────────────────────────────────────────────────────────
app.get(
  '/api/subscriptions',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const subs = await listSubscriptions(userId);
    const listings = await listRecords<Listing>('listings');
    res.json(
      subs.map((s) => ({ ...s, listing: listings.find((l) => l.id === s.listingId) ?? null })),
    );
  }),
);

app.post(
  '/api/subscriptions',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;

    const body = req.body as { listingId?: string; paymentMethodId?: string };
    const listing = await getRecord<Listing>('listings', String(body.listingId ?? ''));
    if (!listing) {
      res.status(404).json({ error: 'No such listing.' });
      return;
    }
    if (listing.sellerId === userId) {
      res.status(400).json({ error: 'This is your own automation — you already have it.' });
      return;
    }

    try {
      res.json(await subscribeToListing(userId, listing, String(body.paymentMethodId ?? '')));
    } catch (err) {
      const invoice = (err as { invoice?: unknown }).invoice;
      res.status(400).json({ error: err instanceof Error ? err.message : String(err), invoice });
    }
  }),
);

app.post(
  '/api/subscriptions/:id/cancel',
  asyncRoute(async (req, res) => {
    const userId = requireUser(req, res);
    if (!userId) return;
    const sub = await cancelSubscription(userId, req.params.id);
    if (!sub) {
      res.status(404).json({ error: 'No such subscription.' });
      return;
    }
    res.json(sub);
  }),
);

// ── errors ─────────────────────────────────────────────────────────────────
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error('[runner]', message);
  res.status(500).json({ error: message.slice(0, 400) });
});

function publicRun(run: Run) {
  return {
    id: run.id,
    automationId: run.automationId,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    durationMs: run.durationMs,
    input: run.input,
    output: run.output,
    error: run.error,
    events: run.events,
  };
}

// ── websocket ──────────────────────────────────────────────────────────────
const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  const runId = new URL(req.url ?? '', 'http://localhost').searchParams.get('runId');
  if (!runId) {
    socket.send(JSON.stringify({ type: 'error', message: 'runId is required' }));
    socket.close();
    return;
  }

  const send = (payload: unknown) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(payload));
  };

  const sub = subscribe(
    runId,
    (event) => send({ type: 'event', event }),
    async () => {
      const run = await getRun(runId);
      send({ type: 'end', run: run ? publicRun(run) : null });
      socket.close();
    },
  );

  socket.on('close', () => sub.unsubscribe());
  socket.on('error', () => sub.unsubscribe());
  send({ type: 'ready', runId });
});

server.listen(config.port, config.host, () => {
  console.log(`\n  Mimic runner  →  http://localhost:${config.port} (bound ${config.host})`);
  console.log(`  AI compiler   →  ${config.deepseek.enabled ? config.deepseek.model : 'disabled (set DEEPSEEK_API_KEY)'}`);
  console.log(`  Browser       →  ${config.browser.headless ? 'headless' : 'headful'} chromium, max ${config.browser.maxConcurrency} concurrent`);
  console.log(`  Storage       →  ${config.storageDir}\n`);

  // Load the speech model now rather than making the first person to press the
  // mic wait for a download.
  warmLocalStt();
});

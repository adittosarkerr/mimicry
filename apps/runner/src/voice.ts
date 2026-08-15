import type { Automation, FormField } from '@mimic/schema';
import { chatJson } from './deepseek';
import { config } from './config';

/**
 * Voice → plan.
 *
 * Speech is turned into text in the browser; this turns that text into an
 * actionable plan: which automation to run and what to put in each field.
 *
 * It deliberately does not invent automations. If nothing the user has recorded
 * can do what they asked, it says so and suggests what to record — a confident
 * wrong answer here would launch a real browser at a real site.
 */

/**
 * Repairs site names the transcriber mangled.
 *
 * Speech-to-text is trained on words, and a domain is not a word. "gozayaan
 * dot com" comes back as "gozion.com" — close enough that a person reads
 * straight past it, wrong enough that every lookup fails. The user's own
 * automations are the answer key: those hostnames are exactly the ones they
 * say out loud, so anything domain-shaped gets matched against them and
 * corrected when it is nearly right.
 *
 * Deliberately conservative. A word has to be genuinely close to a site the
 * user actually has before it is rewritten — silently changing what someone
 * said is a worse failure than passing through a name we don't recognise.
 */
/** How a letter comes back when somebody says it out loud. */
const LETTER_WORDS: Record<string, string> = {
  ay: 'a', aye: 'a', bee: 'b', be: 'b', cee: 'c', see: 'c', sea: 'c', dee: 'd',
  ee: 'e', eff: 'f', ef: 'f', gee: 'g', aitch: 'h', haitch: 'h', eye: 'i', jay: 'j',
  kay: 'k', el: 'l', ell: 'l', em: 'm', en: 'n', oh: 'o', owe: 'o', pee: 'p', pea: 'p',
  cue: 'q', queue: 'q', ar: 'r', are: 'r', ess: 's', es: 's', tee: 't', tea: 't',
  you: 'u', yew: 'u', vee: 'v', ex: 'x', why: 'y', wye: 'y', zee: 'z', zed: 'z',
};

/**
 * Rebuilds a name that was spelled out loud.
 *
 * "F, M, O, V, I, E, S" comes back from transcription as anything from
 * "f m o v i e s" to "eff em oh vee eye ee ess" — and "double s" means a
 * repeated letter, not the word "double". Joined up, it is the name again.
 */
function joinSpelled(fragment: string): string {
  const tokens = fragment
    .toLowerCase()
    .replace(/[.,\-–—]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  let out = '';
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];

    // "double s" → "ss", the way people actually spell aloud.
    if ((token === 'double' || token === 'dubble') && i + 1 < tokens.length) {
      const next = tokens[i + 1];
      const letter = next.length === 1 ? next : LETTER_WORDS[next];
      if (letter) {
        out += letter + letter;
        i += 1;
        continue;
      }
    }

    if (token.length === 1 && /[a-z0-9]/.test(token)) {
      out += token;
      continue;
    }
    if (LETTER_WORDS[token]) {
      out += LETTER_WORDS[token];
      continue;
    }
    // Anything that isn't a letter means this wasn't a spelling after all.
    return '';
  }

  return out.length >= 3 ? out : '';
}

/**
 * Removes a spelling aside, and uses it only when it helps.
 *
 * Spelling a site name out is what people do when the first attempt was
 * misheard — and it backfires: "the spelling of fmovies is F-M-O-V-I-E-S"
 * came back as "the spelling of fmovies is fmovidedoubleis.org", and the
 * mangled version was the one that got used, because it looked more like a
 * hostname than the correct name sitting right next to it.
 *
 * So the aside is stripped either way. Its letters are only adopted when they
 * actually rebuild into a word and the original was never usable.
 */
export function resolveSpelling(transcript: string): string {
  const TLD = 'com|net|org|io|ai|app|co|dev|xyz|info|tv|me|bd|in|uk';

  const cleaned = transcript.replace(
    // Everything after "is" belongs to the aside, up to "and …" or the end.
    new RegExp(String.raw`\b(?:the\s+)?spell(?:ing|ed|s)?\s+(?:of\s+)?([a-z0-9][\w.-]*)\s+(?:is|as)\s+(.+?)(?:\s+and\s+(.*))?$`, 'gim'),
    (_whole, subject: string, spelledRaw: string, rest: string | undefined) => {
      const tail = rest ? ` and ${rest}` : '';

      /* The suffix is dictated as "dot com" or written ".com", and either way
         it is not part of the letters being spelled — leaving it in makes the
         whole fragment unparseable as a spelling. */
      const suffixMatch = spelledRaw.match(new RegExp(String.raw`(?:\.|\s+dot\s+)(${TLD})\s*[.!?]?\s*$`, 'i'));
      const suffix = suffixMatch ? `.${suffixMatch[1].toLowerCase()}` : '';
      const letters = (suffixMatch ? spelledRaw.slice(0, suffixMatch.index) : spelledRaw).replace(/[.!?]\s*$/, '');

      const rebuilt = joinSpelled(letters);
      const name = subject.replace(new RegExp(String.raw`\.(${TLD})$`, 'i'), '').toLowerCase();

      /* They said the name plainly before spelling it. That version is the one
         a person would trust, so keep it and drop the aside entirely — which
         also removes the mangled hostname that would otherwise win. */
      if (!rebuilt || rebuilt === name) {
        /* The aside still earns its place when it supplied the ending: people
           spell "w a l t o n b d dot com" precisely because the first attempt
           had no suffix on it. */
        const needsSuffix = suffix && !new RegExp(String.raw`\.(${TLD})$`, 'i').test(subject);
        return needsSuffix ? `${name}${suffix}${tail}` : tail.trimStart();
      }

      // The letters rebuilt into something else — state it once, cleanly.
      return `${rebuilt}${suffix}${tail}`;
    },
  );

  return cleaned
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.!?,])/g, '$1')
    // "fmovies.org." then nothing — collapse the doubled stop the aside left.
    .replace(/([.!?])[.!?]+/g, '$1')
    .trim();
}

/**
 * Hostnames the person actually named.
 *
 * Used to stop a saved automation being reused for a site nobody asked for.
 * "fmovies.org" and "fmovies.com" are two different companies — one of them
 * may be a squatter serving something else entirely — and a matcher that reads
 * them as the same word will happily send somebody to the wrong one and report
 * 95% confidence about it.
 */
export function sitesNamedIn(transcript: string): string[] {
  const found = new Set<string>();

  // Written normally: "fmovies.org", "www.booking.com".
  for (const [, host] of transcript.matchAll(
    /\b((?:[a-z0-9][a-z0-9-]*\.)+(?:com|net|org|io|ai|app|co|dev|xyz|info|tv|me|bd|in|uk|co\.uk|com\.bd))\b/gi,
  )) {
    found.add(host.toLowerCase().replace(/^www\./, ''));
  }

  // Dictated: "fmovies dot org".
  for (const [, stem, tld] of transcript.matchAll(
    /\b([a-z0-9][a-z0-9-]{1,})\s+dot\s+(com|net|org|io|ai|app|co|dev|xyz|info|tv|me|bd|in|uk)\b/gi,
  )) {
    found.add(`${stem.toLowerCase()}.${tld.toLowerCase()}`);
  }

  return [...found];
}

/** Same site, ignoring a `www.` prefix. */
export const sameHost = (a: string, b: string): boolean =>
  a.toLowerCase().replace(/^www\./, '') === b.toLowerCase().replace(/^www\./, '');

export function repairHostnames(transcript: string, knownSites: string[]): string {
  const hosts = Array.from(
    new Set(
      knownSites
        .map((s) => s.toLowerCase().replace(/^www\./, ''))
        .filter((s) => s.includes('.')),
    ),
  );
  if (!hosts.length) return transcript;

  /* The bare name is what gets spoken and mangled — "gozayaan", not
     "gozayaan.com" — so match on that and keep the suffix the host really has. */
  const named = hosts.map((host) => ({ host, stem: host.split('.')[0] }));

  /* Also considers the preceding word, because a two-part name is dictated with
     a gap in it: "walton bd dot com" arrives as three tokens. */
  return transcript.replace(
    /\b(?:([a-z][a-z0-9-]{1,})\s+)?([a-z][a-z0-9-]{1,})(\s*(?:dot|\.)\s*(?:com|net|org|io|co\.uk|co|xyz|ai|app))\b/gi,
    (whole, prev: string | undefined, spoken: string, suffix: string) => {
      const said = spoken.toLowerCase();
      const joined = prev ? `${prev.toLowerCase()}${said}` : said;
      // Already written correctly as one word — leave it alone.
      if (named.some((n) => n.stem === said)) return whole;
      // Dictated as two words ("walton bd dot com") — join it up.
      const spelled = named.find((n) => n.stem === joined);
      if (spelled) return spelled.host;

      let best: { host: string; score: number; usedPrev: boolean } | null = null;
      for (const { host, stem } of named) {
        if (stem.length < 4) continue; // too short to match safely
        for (const [candidate, usedPrev] of [
          [said, false],
          ...(prev ? ([[joined, true]] as [string, boolean][]) : []),
        ] as [string, boolean][]) {
          const score = similarity(candidate, stem);
          if (!best || score > best.score) best = { host, score, usedPrev };
        }
      }

      // Close enough to be a mishearing, far enough that an unrelated site is
      // left alone. Anything below this passes through untouched.
      if (!best || best.score < 0.72) return whole;

      /* Repair the name, keep the ending they said.
         The suffix was being thrown away and replaced with whatever the known
         site happened to use, which turns a request for one company's site
         into a request for a different company's. Only the misheard part is
         ours to correct. */
      const spokenTld = suffix.replace(/\s*(?:dot|\.)\s*/i, '').toLowerCase();
      const repaired = `${best.host.split('.')[0]}.${spokenTld || best.host.split('.').slice(1).join('.')}`;
      return best.usedPrev ? repaired : `${prev ? `${prev} ` : ''}${repaired}`;
    },
  );
}

/**
 * How alike are two names, allowing for how speech gets written down.
 *
 * Plain edit distance is the wrong measure here: "gozion" and "gozayaan" differ
 * by four characters out of eight and are obviously the same word said aloud.
 * Vowels are what transcription mangles, so the consonants are compared too,
 * and the more generous of the two readings wins.
 */
function similarity(a: string, b: string): number {
  const skeleton = (s: string) => s.replace(/[aeiouy]/g, '');
  return Math.max(editSimilarity(a, b), editSimilarity(skeleton(a), skeleton(b)));
}

/** 0–1 similarity from edit distance. */
function editSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  const longer = a.length >= b.length ? a : b;
  const shorter = a.length >= b.length ? b : a;
  if (!longer.length) return 1;

  // Levenshtein, one row at a time.
  let previous = Array.from({ length: shorter.length + 1 }, (_, i) => i);
  for (let i = 1; i <= longer.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= shorter.length; j += 1) {
      const cost = longer[i - 1] === shorter[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return 1 - previous[shorter.length] / longer.length;
}

/**
 * Transcribes uploaded audio.
 *
 * Kept deliberately provider-agnostic: it posts multipart audio to an
 * OpenAI-compatible `/audio/transcriptions` route, so the same code works
 * against a hosted API or a whisper server running on the user's own machine.
 */
export async function transcribeAudio(
  audio: Buffer,
  filename: string,
  mimeType: string,
): Promise<string> {
  // No hosted provider? Transcribe locally. This is the normal path — it needs
  // no key and no account, which is the only way voice works out of the box.
  if (!config.stt.enabled) {
    if (!config.stt.localEnabled) {
      throw new Error(
        'Speech-to-text is turned off (STT_LOCAL=0) and no STT_API_KEY is set. Type the request instead.',
      );
    }
    /* Imported here rather than at the top of the file.
     *
     * Local Whisper runs on onnxruntime-node, which is 211MB of native
     * binaries. A static import puts all of it in the dependency graph of
     * anything that can reach this function — including the deployed site's
     * voice routes, which pushed them past a serverless function's 250MB
     * ceiling and failed the deployment outright. Nothing there can use it
     * anyway: the model is downloaded per cold start into a filesystem that
     * cannot keep it. */
    const { transcribeLocally } = await import('./stt-local');
    return transcribeLocally(audio);
  }

  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeType }), filename);
  form.append('model', config.stt.model);
  form.append('response_format', 'json');

  const res = await fetch(`${config.stt.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${config.stt.apiKey}` },
    body: form,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = (await res.json()) as { text?: string };
  const text = data.text?.trim();
  if (!text) throw new Error('The recording came back empty — try again, a little closer to the mic.');
  return text;
}

export interface VoicePlan {
  /** null when nothing the user owns can serve the request. */
  automationId: string | null;
  confidence: number;
  values: Record<string, unknown>;
  /** One sentence, spoken back to the user. */
  say: string;
  /** Present when automationId is null. */
  suggestion?: string;
  /** Fields the request didn't mention that the automation requires. */
  missing: string[];
}

const SYSTEM = `You route spoken requests to browser automations the user has already recorded.

You get a transcript and a catalogue of automations. Each automation lists its fields: key, label, type, current default, and any allowed options.

Rules:
1. Pick the ONE automation that does what the transcript asks. Match on intent and site, not just keywords.
2. An automation only counts as a match if its fields can express EVERY specific thing the request asks for. "Five-star hotels in Dhaka" needs a field for the star rating; an automation with a "Beach nearby" toggle and no star filter is the WRONG automation even though it also searches hotels. Returning it would silently run a different search than the one asked for. When in doubt, return null — a new automation gets written from scratch, which is always better than a near miss.
3. The SHAPE of the answer is a requirement too. Each automation reports an "output" of "cards" (a list of results), "detail" (the contents of one page, read as prose) or "confirmation". If the request asks to read, print, summarise or scrape an article, a page or a document, it needs "detail" — matching it to a "cards" automation returns a list of links to someone who asked to be shown the thing itself. Treat a mismatch as uncovered.
4. List every requirement in the request under "covered" (the automation has a field for it) or "uncovered" (it does not). Any entry in "uncovered" means the match fails: set "automation_id" to null.
5. If none of them do it, return "automation_id": null and say plainly what would need to be built. Never force a bad match.
6. Fill "values" only with fields the transcript actually specifies. Leave everything else out — the automation's own defaults will fill the gaps.
7. Use each field's declared type: dates as YYYY-MM-DD (resolve "tomorrow", "next Friday" against the supplied current date), numbers as numbers, booleans as true/false. For fields with options, use one of the given option values verbatim.
7a. A combobox value is what the PERSON said, spelled normally — "Bangkok", not "BangkokThailand" and not "Bangkok, Thailand" unless they said it that way. The site runs its own suggestion list against it, and a value welded together from two words matches nothing.
8. "confidence" is 0-1 for how sure you are about the automation choice.
9. "say" is one short sentence confirming what you are about to do, in the user's own terms. No preamble.
10. "missing" lists keys of required fields the transcript never mentioned and that have no usable default.

Respond with a single JSON object:
{"automation_id": string|null, "confidence": number, "covered": [], "uncovered": [], "values": {}, "say": string, "suggestion": string, "missing": []}`;

/** Only what the model needs — full schemas would blow the context for no gain. */
function describeAutomation(a: Automation) {
  return {
    id: a.id,
    name: a.name,
    description: a.description,
    site: a.site,
    category: a.category,
    /* Track record. Two automations can describe the same task while one of
       them has never once worked — offering that is worse than offering
       nothing, because the person waits for a run that was always going to
       fail. */
    track_record:
      a.stats.runs === 0
        ? 'never run'
        : `${a.stats.successes}/${a.stats.runs} runs succeeded`,
    // What this one comes back with — a list, a page's contents, a receipt.
    output: a.schema.output.layout === 'detail' ? 'detail' : a.schema.output.layout,
    resultKind: a.schema.output.resultKind,
    fields: a.schema.fields
      .filter((f) => f.exposure !== 'constant')
      .map((f: FormField) => ({
        key: f.key,
        label: f.label,
        type: f.kind,
        required: f.required,
        default: f.defaultValue,
        options: f.options.slice(0, 25).map((o) => o.value),
      })),
  };
}

export async function planFromTranscript(
  transcript: string,
  automations: Automation[],
): Promise<VoicePlan> {
  const clean = transcript.trim();

  /* An empty library is not a dead end — it is simply nothing to reuse. The
     caller goes on to author the automation, so telling the person to go and
     record something first would be both discouraging and untrue. */
  if (!automations.length) {
    return {
      automationId: null,
      confidence: 0,
      values: {},
      say: 'Nothing saved to reuse — building this one.',
      missing: [],
    };
  }

  const raw = await chatJson<{
    automation_id?: string | null;
    confidence?: number;
    covered?: string[];
    uncovered?: string[];
    values?: Record<string, unknown>;
    say?: string;
    suggestion?: string;
    missing?: string[];
  }>(
    [
      { role: 'system', content: SYSTEM },
      {
        role: 'user',
        content: JSON.stringify({
          current_date: new Date().toISOString().slice(0, 10),
          transcript: clean,
          automations: automations.map(describeAutomation),
        }),
      },
    ],
    { temperature: 0.1, maxTokens: 1500, timeoutMs: 60_000 },
  );

  // A hallucinated id would send a browser somewhere the user never recorded.
  let id =
    raw.automation_id && automations.some((a) => a.id === raw.automation_id)
      ? raw.automation_id
      : null;

  const confidence = clamp01(raw.confidence ?? (id ? 0.6 : 0));
  const uncovered = (raw.uncovered ?? []).filter((u) => typeof u === 'string' && u.trim());

  /* A near miss is worse than no match. Running the hotel search that happens
     to exist, minus the star filter the person actually asked for, produces a
     confident answer to a question nobody asked — and looks like the product
     ignoring them. Rejecting here drops through to authoring a fresh
     automation, which can express exactly what was requested. */
  let rejection: string | undefined;
  if (id && uncovered.length) {
    rejection = `The closest saved automation can't do: ${uncovered.slice(0, 3).join(', ')}.`;
    id = null;
  } else if (id && confidence < 0.8) {
    /* Reuse is an optimisation, not the product.
     *
     * At 0.55 this was a coin toss dressed up as a decision, and the coin
     * decided in favour of whatever happened to be saved — so a spoken request
     * kept landing on an old recording that half-fitted. Building a new one
     * costs a minute and answers the actual question; replaying a near-miss
     * costs the same minute and answers a different one. Only a match that is
     * plainly the same task is worth taking the shortcut for. */
    rejection = 'Nothing saved is clearly the same task, so this was built for the request.';
    id = null;
  }

  const chosen = automations.find((a) => a.id === id);
  const values = sanitizeValues(raw.values ?? {}, chosen, clean);

  /* Recorded defaults belong to the recording, not to this request. A trace
     made with "Beach nearby" and "Traveling with pets" ticked would carry both
     into every spoken request forever. Anything optional the user did not ask
     for goes back to off. */
  if (chosen) clearUnaskedFilters(values, chosen);

  return {
    automationId: id,
    confidence: id ? confidence : 0,
    values,
    say:
      raw.say?.trim() ||
      (chosen ? `Running ${chosen.name}.` : 'Building an automation for this.'),
    suggestion: id ? undefined : (rejection ?? raw.suggestion?.trim()),
    missing: Array.isArray(raw.missing) ? raw.missing.filter((m) => typeof m === 'string') : [],
  };
}

/**
 * Turns off every optional switch the request never mentioned.
 *
 * Only checkboxes and toggles, and only ones the user can see: a constant is
 * part of how the automation works (a consent box, a "remember me" the site
 * needs), while a visible filter left on from recording day quietly narrows
 * every future run.
 */
function clearUnaskedFilters(values: Record<string, unknown>, automation: Automation): void {
  for (const field of automation.schema.fields) {
    if (field.exposure === 'constant') continue;
    if (field.kind !== 'checkbox' && field.kind !== 'toggle') continue;
    if (field.key in values) continue; // the request asked for it
    if (field.defaultValue !== true) continue;
    values[field.key] = false;
  }
}

/** Drop keys the automation doesn't have; coerce to the declared type. */
/**
 * Undoes a place name welded to something nobody said.
 *
 * Asked for hotels in "Cox's Bazar", the model answers `Cox's BazarBangladesh`
 * — it helpfully supplies the country and joins it without a space. The
 * destination is a combobox, so that string goes into the site's own
 * suggestion list, matches nothing, and the search runs against whatever the
 * site falls back to. There is a rule in the prompt against this and it is
 * ignored often enough to need a check that does not depend on the model
 * cooperating.
 *
 * Only trims where the seam is unmistakable: no space between a lowercase
 * letter and a capital, the part before it is something the person actually
 * said, and the whole string is not. "eBay" and "iPhone" survive, because
 * those appear in the transcript exactly as written.
 */
function trimInventedTail(value: string, transcript: string): string {
  const words = transcript.toLowerCase().replace(/\s+/g, ' ').trim().split(' ');
  const flat = ` ${words.join(' ')} `;

  /* Heard, allowing for the microphone.
   *
   * A literal check is not enough: "Cox's Bazar" was transcribed as "Cox's
   * buzzer", so the correct head appeared nowhere in the transcript and the
   * welded "Cox's BazarBangladesh" sailed through into booking's search box,
   * which matched nothing and returned a page of property categories. The
   * consonant skeletons are identical — cxsbzr — which is exactly what the
   * hostname repair exploits, so it does the same job here. */
  const spoken = (candidate: string) => {
    const needle = candidate.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!needle) return false;
    if (flat.includes(needle)) return true;

    // Compare against every run of words the same length as the candidate.
    const span = needle.split(' ').length;
    for (let i = 0; i + span <= words.length; i += 1) {
      if (similarity(needle, words.slice(i, i + span).join(' ')) >= 0.7) return true;
    }
    return false;
  };

  let current = value;
  for (let i = 0; i < 3; i += 1) {
    if (spoken(current)) return current;

    const seam = current.match(/^(.{2,}?[a-z0-9'’])([A-Z].*)$/);
    if (!seam) return current;

    const head = seam[1].trim();
    if (!head || !spoken(head)) return current;
    current = head;
  }
  return current;
}

function sanitizeValues(
  values: Record<string, unknown>,
  automation: Automation | undefined,
  transcript: string,
): Record<string, unknown> {
  if (!automation) return {};
  const byKey = new Map(automation.schema.fields.map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(values)) {
    const field = byKey.get(key);
    if (!field || field.exposure === 'constant') continue;
    if (value === null || value === undefined || value === '') continue;

    switch (field.kind) {
      case 'number': {
        const n = Number(value);
        if (Number.isFinite(n)) out[key] = n;
        break;
      }
      case 'checkbox':
      case 'toggle':
        out[key] = value === true || /^(1|true|yes|on)$/i.test(String(value));
        break;
      case 'multiselect':
        out[key] = Array.isArray(value) ? value.map(String) : [String(value)];
        break;
      case 'text':
      case 'combobox':
      case 'textarea':
        out[key] = trimInventedTail(String(value), transcript);
        break;
      default:
        out[key] = String(value);
    }
  }
  return out;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, Number(n) || 0));

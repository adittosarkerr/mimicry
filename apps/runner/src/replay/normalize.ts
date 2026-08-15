import type { RecordedStep } from '@mimic/schema';

/**
 * Trace repair, applied both at ingest and again at replay.
 *
 * The recorder captures what happened; this works out what it *meant*. It is
 * idempotent, so running it over an already-normalised trace changes nothing —
 * which is what lets automations recorded by an older extension build start
 * working without being re-recorded.
 */

const INPUT_TAGS = new Set(['input', 'textarea']);
const INPUT_ROLES = new Set(['combobox', 'textbox', 'searchbox']);

/**
 * Is this step interacting with something you can type into?
 *
 * Sites wrap their search box in a `<label>` or a styled `<div>` and let the
 * click bubble, so the recorded target is often the wrapper rather than the
 * input itself. Judging by tag alone misses those.
 */
function isTextEntry(step: RecordedStep): boolean {
  const snap = step.target?.snapshot;
  if (!snap) return false;
  if (INPUT_TAGS.has(snap.tag)) return true;
  if (snap.role && INPUT_ROLES.has(snap.role)) return true;
  if (snap.attributes?.contenteditable === 'true') return true;
  if (['text', 'combobox', 'email', 'number', 'search'].includes(step.meta.kind)) return true;
  // A label or wrapper that contains an input is, for our purposes, the input.
  if (snap.tag === 'label' && (snap.attributes?.for || /search|destination|where|query/i.test(snap.accessibleName ?? ''))) {
    return true;
  }
  return false;
}

/** Text of the option the user picked. */
function optionText(step: RecordedStep): string | undefined {
  const raw =
    (typeof step.value === 'string' ? step.value : undefined) ??
    step.target?.snapshot?.accessibleName ??
    step.target?.snapshot?.text;
  const cleaned = raw?.replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > 120) return undefined;
  return cleaned;
}

/** Mimic's own recording overlay, if an older build let it slip into a trace. */
function isMimicChrome(step: RecordedStep): boolean {
  const name = `${step.target?.snapshot?.accessibleName ?? ''} ${step.target?.snapshot?.text ?? ''}`;
  return /mark the results area/i.test(name);
}

const INTERACTIVE_TAGS = new Set(['a', 'button', 'input', 'select', 'textarea', 'label', 'option', 'summary']);
const INTERACTIVE_ROLES = new Set(['button', 'link', 'option', 'menuitem', 'tab', 'checkbox', 'radio', 'switch']);

/**
 * A click that landed on a page-sized container.
 *
 * People click controls, not layout wrappers. A click whose target is a huge
 * non-interactive region is the results-picker overlay leaking into the trace —
 * and replaying it opens whatever happens to be under that spot, which is how a
 * search automation ends up on a video page. The user's intent was to mark the
 * results, so that is what it becomes.
 */
function isRegionClick(step: RecordedStep): boolean {
  if (step.type !== 'click') return false;
  const snap = step.target?.snapshot;
  const box = snap?.box;
  if (!snap || !box) return false;
  if (INTERACTIVE_TAGS.has(snap.tag)) return false;
  if (snap.role && INTERACTIVE_ROLES.has(snap.role)) return false;
  if (step.target?.candidates.some((c) => c.strategy === 'role' && INTERACTIVE_ROLES.has(c.value))) {
    return false;
  }
  return box.w >= 600 && box.h >= 400;
}

/**
 * A navigation to nowhere.
 *
 * Every frame announces itself when the recorder wakes up, and a page full of
 * ad iframes announces `about:blank` several times. Replaying one blanks the
 * tab mid-task and everything after it fails on an empty document.
 */
function isDeadNavigation(step: RecordedStep): boolean {
  if (step.type !== 'navigate') return false;
  const url = typeof step.value === 'string' ? step.value : (step.url ?? '');
  return !url || !/^https?:\/\//i.test(url);
}

export function normalizeTrace(input: RecordedStep[]): RecordedStep[] {
  const steps = restoreLostTyping(input.filter((s) => !isMimicChrome(s) && !isDeadNavigation(s)));
  const out: RecordedStep[] = [];

  for (const rawStep of steps) {
    // Reinterpret a stray region click as what the user meant by it.
    const step: RecordedStep = isRegionClick(rawStep)
      ? { ...rawStep, type: 'extract', note: 'marked the results region' }
      : rawStep;

    const previous = out[out.length - 1];

    if (step.type === 'click' && step.hints?.inDropdown) {
      const label = optionText(step);

      // Re-rendering dropdowns fire twice for one pick. The first click already
      // became the combobox step; the second must not be replayed on its own.
      if (previous?.type === 'select' && previous.meta.kind === 'combobox' && label) {
        const already = previous.meta.resolvedOptionText ?? '';
        if (already && (already === label || already.includes(label) || label.includes(already))) {
          out[out.length - 1] = {
            ...previous,
            hints: { ...previous.hints, mergedFrom: [...(previous.hints?.mergedFrom ?? []), step.id] },
          };
          continue;
        }
      }

      // 1. The user typed a query, then picked a suggestion. Older recorder
      //    builds left these as two separate steps.
      const typedIndex = findRecentTyping(out);
      if (typedIndex !== -1 && label) {
        const typed = out[typedIndex];
        out[typedIndex] = {
          ...typed,
          type: 'select',
          meta: {
            ...typed.meta,
            kind: 'combobox',
            resolvedOptionText: label,
            options: typed.meta.options?.length ? typed.meta.options : (step.meta.options ?? []),
          },
          secondaryTarget: step.target,
          hints: { ...typed.hints, mergedFrom: [...(typed.hints?.mergedFrom ?? []), step.id] },
          note: 'typed a query, then picked from the dropdown',
        };
        continue;
      }

      // 2. The user opened the box and picked straight from the list without
      //    typing anything — trending destinations, recent searches, a custom
      //    select. Replaying the literal option element is hopeless: with a
      //    different value that element does not exist. Turn the pair into one
      //    combobox step so replay types the value and matches a suggestion.
      if (previous && previous.type === 'click' && isTextEntry(previous) && label) {
        out[out.length - 1] = {
          ...previous,
          type: 'select',
          value: label,
          meta: {
            ...previous.meta,
            kind: 'combobox',
            label: previous.meta.label ?? previous.target?.snapshot?.accessibleName,
            resolvedOptionText: label,
            options: step.meta.options?.length ? step.meta.options : (previous.meta.options ?? []),
          },
          secondaryTarget: step.target,
          hints: { ...previous.hints, mergedFrom: [...(previous.hints?.mergedFrom ?? []), step.id] },
          note: 'opened the list and picked an option',
        };
        continue;
      }
    }

    out.push(step);
  }

  return out.map((step, i) => ({ ...step, seq: i }));
}

/**
 * Rebuilds the typed query when the recording lost it.
 *
 * A trace that presses Enter inside a search box, and lands on a URL carrying a
 * query string, but has no typing step in between, is a trace whose most
 * important step went missing — the service worker was asleep when it was sent.
 * The URL still says what was typed, so the step can be reconstructed exactly,
 * and the compiled form gets a real field to bind to instead of an Enter press
 * that types nothing.
 *
 * Recordings made by the current extension never need this; it exists so the
 * automations already saved start working without being recorded again.
 */
function restoreLostTyping(steps: RecordedStep[]): RecordedStep[] {
  const out: RecordedStep[] = [];

  for (const step of steps) {
    const isEnter = step.type === 'press' && step.value === 'Enter';
    if (!isEnter || !isTextEntry(step)) {
      out.push(step);
      continue;
    }

    // Anything typed already? Then nothing was lost.
    const typed = out.some(
      (s, i) => i >= out.length - 4 && (s.type === 'input' || s.type === 'select') && s.value,
    );
    if (typed) {
      out.push(step);
      continue;
    }

    const query = queryFromFollowingUrl(steps, step);
    if (!query) {
      out.push(step);
      continue;
    }

    /* The recovered step keeps the original id and the Enter gets a new one.
       The compiled form binds its field to whichever step id it was given, and
       that binding has to land on the thing that types — binding a user's query
       to a keypress fills nothing in. */
    out.push({
      ...step,
      type: 'input',
      value: query,
      note: 'recovered from the results URL — the recording lost the typing step',
    });
    out.push({ ...step, id: `${step.id}_enter` });
  }

  return out;
}

/** The search term in whichever URL the trace reached after this step. */
function queryFromFollowingUrl(steps: RecordedStep[], after: RecordedStep): string | undefined {
  const start = steps.indexOf(after);
  const QUERY_KEYS = ['search_query', 'q', 'query', 'k', 'ss', 's', 'keyword', 'term', 'search'];

  for (let i = start; i < Math.min(steps.length, start + 4); i += 1) {
    const raw = typeof steps[i].value === 'string' ? (steps[i].value as string) : steps[i].url;
    if (!raw || !/^https?:\/\//i.test(raw)) continue;
    try {
      const params = new URL(raw).searchParams;
      for (const key of QUERY_KEYS) {
        const value = params.get(key)?.trim();
        if (value && value.length <= 200) return value;
      }
    } catch {
      /* not a URL we can read */
    }
  }
  return undefined;
}

/** Most recent typing step, if nothing since it moved us elsewhere. */
function findRecentTyping(out: RecordedStep[]): number {
  for (let i = out.length - 1; i >= Math.max(0, out.length - 4); i -= 1) {
    const s = out[i];
    if (s.type === 'input' && s.value) return i;
    if (s.type === 'navigate') break;
  }
  return -1;
}

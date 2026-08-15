import type { RunOutput } from '@mimic/schema';
import { chatJson } from './deepseek';
import { config } from './config';

/**
 * Reading the results and saying something about them.
 *
 * A scraper answers "what is on the page". Plenty of requests are not that:
 * "make me a good PC under 80,000", "which of these is the best value",
 * "is anything here available on the 18th". Handing back two hundred products
 * when somebody asked which one to buy is a correct answer to a question they
 * did not ask.
 *
 * The rules below matter more than the prompt. The model sees only the items
 * that were actually scraped, is told to cite them by index, and is told to say
 * so when the results do not contain the answer — because a confident
 * recommendation invented from nothing is worse than no recommendation, and on
 * a page of ink cartridges that is exactly what would otherwise come back.
 */

const SYSTEM = `You answer a person's request using ONLY the search results supplied.

Rules:
1. Answer the actual question. If they asked which to buy, recommend one and say why. If they asked to compare, compare. If they asked for a list, a one-line summary is enough — they can already see the list.
2. Use only the supplied results. Never add a product, price, flight or fact that is not in them. You have no other knowledge of what this site sells today.
3. Cite what you used by its index in "cites". Every claim about a specific item must come from that item.
4. If the results do not answer the request — wrong category, nothing in budget, the site returned something unrelated — say that plainly in one sentence and set "cites" to []. Do not improvise a substitute.
5. Prices, names and specifications must be quoted exactly as given.
6. Two to five sentences. Plain language, no preamble, no markdown headings.

Respond with a single JSON object: {"text": string, "cites": number[]}`;

/** Requests that a list alone does not satisfy. */
const WANTS_JUDGEMENT =
  /\b(best|good|better|cheapest|recommend|suggest|which|compare|worth|should i|pick|choose|build|make me|under|below|budget|value|top\b)/i;

export interface AnswerInput {
  /** What the person actually asked for, in their words. */
  request: string;
  output: RunOutput;
}

/**
 * Decides whether a written answer is wanted, and writes it.
 *
 * Returns undefined rather than throwing: an automation that produced good
 * results must never fail because the commentary on them could not be written.
 */
export async function answerFromResults({
  request,
  output,
}: AnswerInput): Promise<RunOutput['answer'] | undefined> {
  if (!config.deepseek.enabled) return undefined;

  const items = output.items ?? [];
  if (!items.length || !request.trim()) return undefined;

  /* Only when the request implies a judgement. Writing a paragraph about a
     plain "search youtube for X" is noise on top of a list that already
     answered it, and it costs a model call on every run. */
  if (!WANTS_JUDGEMENT.test(request)) return undefined;

  // Enough to judge on, small enough not to blow the context on 200 products.
  const shortlist = items.slice(0, 40).map((item, index) => ({
    i: index,
    title: item.title,
    price: item.price ? `${item.price.currency} ${item.price.amount}` : undefined,
    rating: item.rating,
    detail: item.description?.slice(0, 160),
    meta: Object.fromEntries(
      Object.entries(item.meta ?? {}).filter(([, v]) => typeof v === 'string' && v),
    ),
  }));

  try {
    const reply = await chatJson<{ text?: string; cites?: unknown[] }>(
      [
        { role: 'system', content: SYSTEM },
        {
          role: 'user',
          content: JSON.stringify({
            request,
            result_count: items.length,
            showing: shortlist.length,
            results: shortlist,
          }),
        },
      ],
      { temperature: 0.2, maxTokens: 700, timeoutMs: 45_000 },
    );

    const text = String(reply.text ?? '').trim();
    if (!text) return undefined;

    const cites = (reply.cites ?? [])
      .map((n) => Number(n))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < items.length)
      .slice(0, 8);

    return { text: text.slice(0, 1200), cites, model: config.deepseek.model };
  } catch {
    // The results stand on their own; the commentary is a bonus.
    return undefined;
  }
}

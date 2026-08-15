import { config } from './config.js';

/**
 * Thin DeepSeek client. The API is OpenAI-compatible, so this is just
 * `/chat/completions` with retries, a timeout, and strict JSON parsing.
 *
 * The key never leaves the server — neither the browser nor the extension ever
 * sees it.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class DeepSeekError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DeepSeekError';
  }
}

interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask the model for a JSON object and parse it before returning. */
  json?: boolean;
  timeoutMs?: number;
  retries?: number;
}

async function once(messages: ChatMessage[], opts: ChatOptions): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000);

  try {
    const res = await fetch(`${config.deepseek.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${config.deepseek.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.deepseek.model,
        messages,
        temperature: opts.temperature ?? 0.2,
        max_tokens: opts.maxTokens ?? 8000,
        ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new DeepSeekError(`DeepSeek returned ${res.status}: ${body.slice(0, 400)}`, res.status);
    }

    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new DeepSeekError('DeepSeek returned an empty completion');
    return content;
  } finally {
    clearTimeout(timer);
  }
}

export async function chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
  if (!config.deepseek.enabled) {
    throw new DeepSeekError('DEEPSEEK_API_KEY is not set');
  }

  const retries = opts.retries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await once(messages, opts);
    } catch (err) {
      lastError = err;
      const status = err instanceof DeepSeekError ? err.status : undefined;
      // 4xx other than rate-limiting won't fix themselves.
      if (status && status !== 429 && status < 500) throw err;
      if (attempt === retries) break;
      await new Promise((r) => setTimeout(r, 800 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new DeepSeekError(String(lastError));
}

/** Chat, but guaranteed to hand back a parsed object (or throw). */
export async function chatJson<T = unknown>(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<T> {
  const raw = await chat(messages, { ...opts, json: true });
  return parseJsonLoose<T>(raw);
}

/**
 * Models sometimes wrap JSON in prose or a code fence despite being asked not
 * to. Dig the object out rather than failing the whole compile over it.
 */
export function parseJsonLoose<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    /* fall through */
  }

  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1].trim()) as T;
    } catch {
      /* fall through */
    }
  }

  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1)) as T;
    } catch {
      /* fall through */
    }
  }

  throw new DeepSeekError(`Could not parse JSON from model output: ${trimmed.slice(0, 200)}`);
}

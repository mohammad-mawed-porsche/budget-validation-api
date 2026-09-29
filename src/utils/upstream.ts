export interface UpstreamRequestOptions {
  timeoutMs: number;
  maxRetries: number;
  retryBaseMs: number;
  fetchImpl?: typeof fetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
}

const retryableStatuses = new Set([429, 500, 502, 503, 504]);

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly statusCode?: number,
  ) {
    super(message);
    this.name = "UpstreamError";
  }
}

function retryDelay(response: Response, body: string, attempt: number, baseMs: number): number {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  try {
    const period = (JSON.parse(body) as { errors?: Array<{ period?: unknown }> }).errors?.[0]?.period;
    if (typeof period === "number" && period >= 0) return period * 1_000;
  } catch {
    // Fall back to exponential backoff for non-JSON responses.
  }
  return baseMs * 2 ** attempt;
}

export async function fetchWithRetry(
  input: URL | string,
  init: RequestInit,
  options: UpstreamRequestOptions,
): Promise<Response> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep = options.sleepImpl ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  for (let attempt = 0; attempt <= options.maxRetries; attempt += 1) {
    const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    let response: Response;
    try {
      // Never forward integration credentials or OAuth bodies to a redirect target.
      response = await fetchImpl(input, { ...init, redirect: "error", signal });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      if (attempt >= options.maxRetries) {
        throw new UpstreamError(`Upstream request failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      await sleep(options.retryBaseMs * 2 ** attempt);
      continue;
    }

    if (response.ok || !retryableStatuses.has(response.status)) return response;
    const body = await response.clone().text();
    if (attempt >= options.maxRetries) return response;
    await sleep(retryDelay(response, body, attempt, options.retryBaseMs));
  }

  throw new UpstreamError("Upstream request exhausted retries.");
}

export function safeUpstreamMessage(body: string): string {
  return body.replace(/[\r\n\t]+/g, " ").slice(0, 500);
}

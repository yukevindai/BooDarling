/** Error raised by critic providers. `transient` errors may be retried once. */
export class CriticProviderError extends Error {
  readonly transient: boolean;
  readonly status?: number;

  constructor(message: string, opts: { transient?: boolean; status?: number } = {}) {
    super(message);
    this.name = "CriticProviderError";
    this.transient = opts.transient ?? false;
    this.status = opts.status;
  }
}

export function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    ((err as { name?: string }).name === "AbortError" || (err as { name?: string }).name === "TimeoutError")
  );
}

/** HTTP statuses worth one retry. */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Is this error worth one automatic retry (network failure, 408/429/5xx)? */
export function isTransientError(err: unknown): boolean {
  if (isAbortError(err)) return false;
  if (err instanceof CriticProviderError) return err.transient;
  // fetch() network failures surface as TypeError("fetch failed") in Node.
  return err instanceof TypeError;
}

/**
 * `fetch` wrapper that maps network failures and non-2xx responses to
 * CriticProviderError (aborts are rethrown untouched). Error messages carry
 * only the status and a short provider message — never request bodies or keys.
 */
export async function fetchJson(
  url: string,
  init: RequestInit & { signal: AbortSignal },
  label: string,
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (isAbortError(err) || init.signal.aborted) throw err;
    const cause = (err as { cause?: { code?: string } })?.cause?.code;
    throw new CriticProviderError(`${label} network error${cause ? ` (${cause})` : ""}`, { transient: true });
  }
  const text = await res.text();
  if (!res.ok) {
    let detail = "";
    try {
      const j = JSON.parse(text) as { error?: { message?: string } | string };
      detail = typeof j.error === "string" ? j.error : (j.error?.message ?? "");
    } catch {
      /* ignore */
    }
    throw new CriticProviderError(`${label} HTTP ${res.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`, {
      transient: isTransientStatus(res.status),
      status: res.status,
    });
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CriticProviderError(`${label} returned invalid JSON`, { transient: true, status: res.status });
  }
}

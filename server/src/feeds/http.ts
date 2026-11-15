export class FeedError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** fetch JSON with a hard timeout. Throws FeedError on network errors, non-2xx, or invalid JSON. */
export async function getJson<T>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'paper-trader/1.0', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new FeedError(`HTTP ${res.status}: ${text.slice(0, 200)}`, res.status);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new FeedError(`Invalid JSON from ${new URL(url).host}`);
    }
  } catch (e) {
    if (e instanceof FeedError) throw e;
    throw new FeedError(`${new URL(url).host}: ${(e as Error).name === 'AbortError' ? 'timeout' : (e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

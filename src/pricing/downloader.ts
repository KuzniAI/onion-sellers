export class NetworkError extends Error {
  url: string;
  status?: number;

  constructor(message: string, url: string, options?: { status?: number; cause?: unknown }) {
    super(message, { cause: options?.cause });
    this.name = "NetworkError";
    this.url = url;
    this.status = options?.status;
  }
}

// Statuses worth retrying. 404 is included because opencode.ai intermittently returns
// "Cannot find any route matching" 404s for pages that do exist.
const RETRYABLE_STATUSES = new Set([404, 408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const RETRY_DELAY_MS = 2000;

export async function downloadHtml(url: string): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await downloadHtmlOnce(url);
    } catch (err) {
      const retryable =
        err instanceof NetworkError &&
        (err.status === undefined || RETRYABLE_STATUSES.has(err.status));
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      console.warn(`${err.message} (attempt ${attempt}/${MAX_ATTEMPTS}, retrying)`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * attempt));
    }
  }
}

async function downloadHtmlOnce(url: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch (err) {
    throw new NetworkError(`Request to ${url} failed: ${(err as Error).message}`, url, {
      cause: err,
    });
  }

  if (!res.ok) {
    const body = await res.text();
    throw new NetworkError(`${res.status} ${res.statusText} on ${url}: ${body}`, url, {
      status: res.status,
    });
  }
  return res.text();
}

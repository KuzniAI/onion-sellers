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

export async function downloadHtml(url: string): Promise<string> {
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

export const SOURCE_URL = "https://opencode.ai/docs/go/";

export async function fetchOpenCodeGoPricingHtml(): Promise<string> {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    const body = await res.text();
    throw Object.assign(new Error(`${res.status} ${res.statusText} on ${SOURCE_URL}: ${body}`), {
      status: res.status,
    });
  }
  return res.text();
}

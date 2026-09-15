// Fetches Artificial Analysis language model benchmark data. Requires AA_API_KEY
// in the environment (see .env.example).

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://artificialanalysis.ai/api/v2";
const OUT_FILE = path.join("data", "artificial-analysis", "language-models.json");

async function fetchAllPages(
  endpointPath: string,
  apiKey: string,
): Promise<{ tier: string; intelligenceIndexVersion: number; rows: unknown[] }> {
  const rows: unknown[] = [];
  let page = 1;
  let tier = "";
  let intelligenceIndexVersion = 0;

  while (true) {
    const url = `${API_BASE}${endpointPath}?page=${page}`;
    const res = await fetch(url, { headers: { "x-api-key": apiKey } });

    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(new Error(`${res.status} ${res.statusText} on ${url}: ${body}`), {
        status: res.status,
      });
    }

    const json = await res.json();
    tier = json.tier;
    intelligenceIndexVersion = json.intelligence_index_version;
    rows.push(...json.data);

    if (!json.pagination?.has_more) break;
    page += 1;
  }

  return { tier, intelligenceIndexVersion, rows };
}

export async function fetchArtificialAnalysisData(): Promise<void> {
  const apiKey = process.env.AA_API_KEY;
  if (!apiKey) {
    throw new Error("Missing AA_API_KEY. Copy .env.example to .env and fill in your key.");
  }

  let result: { tier: string; intelligenceIndexVersion: number; rows: unknown[] };
  let servedBy = "/language/models";

  try {
    result = await fetchAllPages("/language/models", apiKey);
  } catch (err) {
    if ((err as { status?: number }).status === 403) {
      console.log(
        "Key tier does not cover /language/models (Pro+), falling back to /language/models/free ...",
      );
      servedBy = "/language/models/free";
      result = await fetchAllPages("/language/models/free", apiKey);
    } else {
      throw err;
    }
  }

  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(
    OUT_FILE,
    JSON.stringify(
      {
        sourceUrl: `${API_BASE}${servedBy}`,
        fetchedAt: new Date().toISOString(),
        tier: result.tier,
        intelligenceIndexVersion: result.intelligenceIndexVersion,
        modelCount: result.rows.length,
        models: result.rows,
      },
      null,
      2,
    ),
  );

  console.log(`Wrote ${result.rows.length} models (tier: ${result.tier}) to ${OUT_FILE}`);
}

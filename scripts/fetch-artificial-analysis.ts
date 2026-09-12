// One-off fetch of Artificial Analysis language model benchmark data.
// Run with: node --env-file=.env scripts/fetch-artificial-analysis.ts

import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

const API_BASE = "https://artificialanalysis.ai/api/v2";
const OUT_FILE = path.join("data", "artificial-analysis", "language-models.json");

const apiKey = process.env.AA_API_KEY;
if (!apiKey) {
  console.error("Missing AA_API_KEY. Copy .env.example to .env and fill in your key, then run with `node --env-file=.env scripts/fetch-artificial-analysis.ts`.");
  process.exit(1);
}

async function fetchAllPages(endpointPath: string): Promise<{ tier: string; intelligenceIndexVersion: number; rows: unknown[] }> {
  const rows: unknown[] = [];
  let page = 1;
  let tier = "";
  let intelligenceIndexVersion = 0;

  while (true) {
    const url = `${API_BASE}${endpointPath}?page=${page}`;
    const res = await fetch(url, { headers: { "x-api-key": apiKey as string } });

    if (!res.ok) {
      const body = await res.text();
      throw Object.assign(new Error(`${res.status} ${res.statusText} on ${url}: ${body}`), { status: res.status });
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

async function main() {
  let result: { tier: string; intelligenceIndexVersion: number; rows: unknown[] };
  let servedBy = "/language/models";

  try {
    result = await fetchAllPages("/language/models");
  } catch (err) {
    if ((err as { status?: number }).status === 403) {
      console.log("Key tier does not cover /language/models (Pro+), falling back to /language/models/free ...");
      servedBy = "/language/models/free";
      result = await fetchAllPages("/language/models/free");
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

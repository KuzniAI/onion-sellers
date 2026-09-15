// Runs the benchmark pipeline: refresh provider pricing, fetch Artificial Analysis
// data, then score models. config/model-mapping.json is still maintained by hand -- see README.

import { existsSync } from "node:fs";
import { fetchArtificialAnalysisData } from "./artificial-analysis/fetch.ts";
import { copilotSource } from "./copilot/source.ts";
import { openCodeGoSource } from "./opencode-go/source.ts";
import { refreshPricingSource } from "./pricing/refresh.ts";
import { computeScores } from "./scoring/compute-scores.ts";

try {
  if (!existsSync(".env")) {
    console.error("Missing .env. Copy .env.example to .env and fill in AA_API_KEY before running.");
    process.exit(1);
  }

  console.log("== Step 1/4: refreshing GitHub Copilot pricing ==");
  const copilotOk = await refreshPricingSource(copilotSource);

  console.log("\n== Step 2/4: refreshing OpenCode Go pricing ==");
  const openCodeGoOk = await refreshPricingSource(openCodeGoSource);

  console.log("\n== Step 3/4: fetching Artificial Analysis benchmark data ==");
  await fetchArtificialAnalysisData();

  console.log("\n== Step 4/4: scoring models per category ==");
  await computeScores();

  if (!copilotOk || !openCodeGoOk) {
    console.error("\nDone with parser failures; some pricing data is stale (see errors above).");
    process.exitCode = 1;
  } else {
    console.log("\nDone. See data/recommendations.json.");
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}

// Runs the benchmark pipeline: refresh provider pricing, fetch Artificial Analysis
// data, update config/model-mapping.json, then score models. See README for how the
// mapping is maintained.

import { fetchArtificialAnalysisData } from "./artificial-analysis/fetch.ts";
import { copilotSource } from "./copilot/source.ts";
import { updateModelMapping } from "./mapping/update-mapping.ts";
import { openCodeGoSource } from "./opencode-go/source.ts";
import { refreshPricingSource } from "./pricing/refresh.ts";
import { computeScores } from "./scoring/compute-scores.ts";

try {
  if (!process.env.AA_API_KEY) {
    console.error(
      "Missing AA_API_KEY. Locally, copy .env.example to .env and fill it in; in CI, set the AA_API_KEY repository secret.",
    );
    process.exit(1);
  }

  console.log("== Step 1/5: refreshing GitHub Copilot pricing ==");
  const copilotOk = await refreshPricingSource(copilotSource);

  console.log("\n== Step 2/5: refreshing OpenCode Go pricing ==");
  const openCodeGoOk = await refreshPricingSource(openCodeGoSource);

  console.log("\n== Step 3/5: fetching Artificial Analysis benchmark data ==");
  await fetchArtificialAnalysisData();

  console.log("\n== Step 4/5: updating model mapping ==");
  await updateModelMapping();

  console.log("\n== Step 5/5: scoring models per category ==");
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

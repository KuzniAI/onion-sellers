// Runs the benchmark pipeline: refresh provider pricing, fetch Artificial Analysis
// data, update config/model-mapping.json, then score models. See README for how the
// mapping is maintained and how broken parsers are repaired locally.

import { fetchArtificialAnalysisData } from "./artificial-analysis/fetch.ts";
import { updateModelMapping } from "./mapping/update-mapping.ts";
import { refreshPricingSource } from "./pricing/refresh.ts";
import { pricingSources } from "./pricing/sources.ts";
import { computeScores } from "./scoring/compute-scores.ts";

const totalSteps = pricingSources.length + 3;
let step = 0;
const logStep = (label: string) =>
  console.log(`${step > 0 ? "\n" : ""}== Step ${++step}/${totalSteps}: ${label} ==`);

try {
  if (!process.env.AA_API_KEY) {
    console.error(
      "Missing AA_API_KEY. Locally, copy .env.example to .env and fill it in; in CI, set the AA_API_KEY repository secret.",
    );
    process.exit(1);
  }

  const failedSources: string[] = [];
  for (const source of pricingSources) {
    logStep(`refreshing ${source.displayName} pricing`);
    if (!(await refreshPricingSource(source))) failedSources.push(source.displayName);
  }

  logStep("fetching Artificial Analysis benchmark data");
  await fetchArtificialAnalysisData();

  logStep("updating model mapping");
  await updateModelMapping();

  logStep("scoring models per category");
  await computeScores();

  if (failedSources.length > 0) {
    console.error(
      `\nDone with parser failures (${failedSources.join(", ")}); some pricing data is stale or missing (see errors above).`,
    );
    process.exitCode = 1;
  } else {
    console.log("\nDone. See data/recommendations.json.");
  }
} catch (err) {
  console.error(err);
  process.exit(1);
}

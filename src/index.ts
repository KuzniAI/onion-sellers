// Runs the benchmark pipeline: refresh provider pricing, fetch Artificial Analysis
// data, then score models. data/model-mapping.json is still maintained by hand -- see README.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fetchCopilotPricingHtml, SOURCE_URL as COPILOT_SOURCE_URL } from "./copilot/downloader.ts";
import { parseCopilotPricingHtml } from "./copilot/parser.ts";
import { fetchOpenCodeGoPricingHtml, SOURCE_URL as OPENCODE_GO_SOURCE_URL } from "./opencode-go/downloader.ts";
import { parseOpenCodeGoPricingHtml } from "./opencode-go/parser.ts";

const COPILOT_NOTES =
  "Auto-generated from the GitHub Copilot models-and-pricing docs page. " +
  'All prices are per 1M tokens. Models with a "Long context" tier bill at a higher ' +
  "rate once input exceeds thresholdInputTokens; the same model may appear twice " +
  "(Default and Long context rows) -- this is expected, not a duplicate.";

const OPENCODE_GO_NOTES =
  "Auto-generated from the OpenCode Go docs page. OpenCode Go is a flat $10/mo " +
  "subscription; monthlyLimitUsd is each model's per-month usage cap under that " +
  "subscription, not a separate charge. Reference a model in config as " +
  '"opencode-go/<modelId>". Peak/off-peak and context-threshold variants of the ' +
  "same model share one modelId and appear as separate rows, matching the source page. " +
  "Live model list: https://opencode.ai/zen/go/v1/models (id/owner metadata only, no pricing).";

async function writePricingFile(relPath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(relPath), { recursive: true });
  await writeFile(relPath, JSON.stringify(data, null, 2));
}

async function refreshCopilotPricing(): Promise<void> {
  const html = await fetchCopilotPricingHtml();
  const models = parseCopilotPricingHtml(html);
  await writePricingFile(path.join("data", "copilot", "models-pricing.json"), {
    sourceUrl: COPILOT_SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    notes: COPILOT_NOTES,
    models,
  });
  console.log(`Wrote ${models.length} Copilot models to data/copilot/models-pricing.json`);
}

async function refreshOpenCodeGoPricing(): Promise<void> {
  const html = await fetchOpenCodeGoPricingHtml();
  const models = parseOpenCodeGoPricingHtml(html);
  await writePricingFile(path.join("data", "opencode-go", "models-pricing.json"), {
    sourceUrl: OPENCODE_GO_SOURCE_URL,
    fetchedAt: new Date().toISOString(),
    notes: OPENCODE_GO_NOTES,
    models,
  });
  console.log(`Wrote ${models.length} OpenCode Go models to data/opencode-go/models-pricing.json`);
}

function run(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: options.env ?? process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function main() {
  if (!existsSync(".env")) {
    console.error("Missing .env. Copy .env.example to .env and fill in AA_API_KEY before running.");
    process.exit(1);
  }

  console.log("== Step 1/4: refreshing GitHub Copilot pricing ==");
  await refreshCopilotPricing();

  console.log("\n== Step 2/4: refreshing OpenCode Go pricing ==");
  await refreshOpenCodeGoPricing();

  console.log("\n== Step 3/4: fetching Artificial Analysis benchmark data ==");
  await run(["--env-file=.env", "scripts/fetch-artificial-analysis.ts"]);

  console.log("\n== Step 4/4: scoring models per category ==");
  await run(["scripts/compute-scores.ts"]);

  console.log("\nDone. See data/recommendations.json.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

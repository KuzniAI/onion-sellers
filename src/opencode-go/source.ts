import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSource } from "../pricing/source.ts";
import { parseOpenCodeGoPricingHtml, type OpenCodeGoModelRow } from "./parser.ts";

export const openCodeGoSource: PricingSource<OpenCodeGoModelRow> = {
  id: "opencode-go",
  displayName: "OpenCode Go",
  sourceUrl: "https://opencode.ai/docs/go/",
  outFile: path.join("data", "opencode-go", "models-pricing.json"),
  notes:
    "Auto-generated from the OpenCode Go docs page. OpenCode Go is a flat $10/mo " +
    "subscription; monthlyLimitUsd is each model's per-month usage cap under that " +
    "subscription, not a separate charge. Reference a model in config as " +
    '"opencode-go/<modelId>". Peak/off-peak and context-threshold variants of the ' +
    "same model share one modelId and appear as separate rows, matching the source page. " +
    "Live model list: https://opencode.ai/zen/go/v1/models (id/owner metadata only, no pricing).",
  parserPath: fileURLToPath(new URL("./parser.ts", import.meta.url)),
  parseExport: "parseOpenCodeGoPricingHtml",
  rowContract:
    "One row per row of the pricing table (Model / Input / Output / Cached Read / Cached Write / Monthly limit), " +
    "keeping variant suffixes like (Peak) or (≤ 256K tokens) in model. priceInput, priceOutput, monthlyLimitUsd: " +
    'USD numbers (for a promotional limit use the current value, with the base value in notes); priceCachedRead, priceCachedWrite: number or null for "-". ' +
    "Join by model name (falling back to the name without its variant suffix) to the requests table " +
    "(requestsPer5h, requestsPerWeek, requestsPerMonth as integers), the endpoints table (modelId, endpoint, " +
    "aiSdkPackage) and the privacy table (modelTraining text, dataRetentionDays integer); use null when a table " +
    "has no row. notes: optional text for promotions and footnotes.",
  priceFields: { input: "priceInput", output: "priceOutput" },
  parse: parseOpenCodeGoPricingHtml,
};

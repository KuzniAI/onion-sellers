import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSource } from "../pricing/source.ts";
import { parseOpenCodeGoPricingHtml, type OpenCodeGoModelRow } from "./parser.ts";

export const openCodeGoSource: PricingSource<OpenCodeGoModelRow> = {
  id: "opencode-go",
  displayName: "OpenCode Go",
  sourceUrl: "https://opencode.ai/inference/go/v1/models",
  format: "json",
  outFile: path.join("data", "opencode-go", "models-pricing.json"),
  notes:
    "Auto-generated from the OpenCode Go /v1/models JSON endpoint. OpenCode Go is a flat $10/mo " +
    "subscription; monthlyLimitUsd is each model's per-month usage cap under that " +
    "subscription, not a separate charge. Reference a model in config as " +
    '"opencode-go/<modelId>". Peak/off-peak and context-threshold variants of the ' +
    "same model share one modelId and appear as separate rows, matching the source page. " +
    "Prices are USD per 1M tokens.",
  parserPath: fileURLToPath(new URL("./parser.ts", import.meta.url)),
  parseExport: "parseOpenCodeGoPricingHtml",
  rowContract:
    "JSON {object:'list', data:[...]}; one row per entry of data (more rows when cost.multipliers or tiered " +
    "pricing apply, e.g. a Peak row where a multiplier factor applies, with the unmultiplied row labelled Off-peak). " +
    "modelId: entry id; model: entry name (with variant suffix such as (Peak)); priceInput, priceOutput: " +
    "cost.text.input.price / output.price times any multiplier factor; priceCachedRead, priceCachedWrite: " +
    "cost.text.input.cache.read / write or null. Include the go block fields you can (monthly usage limits, " +
    "training, zdr) as optional properties, null when absent. notes: optional text.",
  priceFields: { input: "priceInput", output: "priceOutput" },
  parse: parseOpenCodeGoPricingHtml,
};

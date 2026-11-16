import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSource } from "../pricing/source.ts";
import { parseOpenCodeZenPricingHtml, type OpenCodeZenModelRow } from "./parser.ts";

export const openCodeZenSource: PricingSource<OpenCodeZenModelRow> = {
  id: "opencode-zen",
  displayName: "OpenCode Zen",
  sourceUrl: "https://opencode.ai/zen/v1/models",
  format: "json",
  outFile: path.join("data", "opencode-zen", "models-pricing.json"),
  notes:
    "Auto-generated from the OpenCode Zen /v1/models JSON endpoint. OpenCode Zen is pay-as-you-go; all " +
    "prices are USD per 1M tokens. Free models have 0 prices and are not scored. " +
    'Context-threshold variants of the same model (e.g. "(≤ 272K tokens)") appear as ' +
    "separate rows, matching the source page.",
  parserPath: fileURLToPath(new URL("./parser.ts", import.meta.url)),
  parseExport: "parseOpenCodeZenPricingHtml",
  rowContract:
    "JSON {object:'list', data:[...]}; one row per entry of data (one row per pricing tier when the entry has " +
    'context-threshold tiers, keeping the threshold in model, e.g. "(≤ 272K tokens)"). model: entry name; ' +
    "priceInput, priceOutput: USD per 1M tokens as numbers, free models 0; priceCachedRead, priceCachedWrite: " +
    "number or null when absent; notes: optional text.",
  priceFields: { input: "priceInput", output: "priceOutput" },
  parse: parseOpenCodeZenPricingHtml,
};

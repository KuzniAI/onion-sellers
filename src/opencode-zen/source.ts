import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSource } from "../pricing/source.ts";
import { parseOpenCodeZenPricingHtml, type OpenCodeZenModelRow } from "./parser.ts";

export const openCodeZenSource: PricingSource<OpenCodeZenModelRow> = {
  id: "opencode-zen",
  displayName: "OpenCode Zen",
  sourceUrl: "https://opencode.ai/docs/zen/",
  outFile: path.join("data", "opencode-zen", "models-pricing.json"),
  notes:
    "Auto-generated from the OpenCode Zen docs page. OpenCode Zen is pay-as-you-go; all " +
    "prices are USD per 1M tokens. Free models have 0 prices and are not scored. " +
    'Context-threshold variants of the same model (e.g. "(≤ 272K tokens)") appear as ' +
    "separate rows, matching the source page.",
  parserPath: fileURLToPath(new URL("./parser.ts", import.meta.url)),
  parseExport: "parseOpenCodeZenPricingHtml",
  rowContract:
    "One row per row of the pricing table (Model / Input / Output / Cached Read / Cached Write). " +
    'model: name as shown, keeping variant suffixes like "(≤ 272K tokens)"; priceInput, priceOutput: ' +
    'USD per 1M tokens as numbers, "Free" -> 0; priceCachedRead, priceCachedWrite: number, "Free" -> 0, ' +
    'and null for "-", "—" or an empty cell; notes: optional text for footnotes.',
  priceFields: { input: "priceInput", output: "priceOutput" },
  parse: parseOpenCodeZenPricingHtml,
};

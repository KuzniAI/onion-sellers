import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSource } from "../pricing/source.ts";
import { parseClinePassPricingHtml, type ClinePassModelRow } from "./parser.ts";

export const clinePassSource: PricingSource<ClinePassModelRow> = {
  id: "clinepass",
  displayName: "ClinePass",
  sourceUrl: "https://docs.cline.bot/getting-started/clinepass",
  outFile: path.join("data", "clinepass", "models-pricing.json"),
  notes:
    "Auto-generated from the ClinePass docs page. ClinePass is a flat monthly subscription; " +
    "prices are the page's reference API rates (USD per 1M tokens) that usage is counted " +
    "against, not separate charges. Reference a model in Cline by its modelId " +
    '(e.g. "cline-pass/glm-5.3").',
  parserPath: fileURLToPath(new URL("./parser.ts", import.meta.url)),
  parseExport: "parseClinePassPricingHtml",
  rowContract:
    "One row per model in the Reference pricing table (Input / Output / Cached Read / Cached Write), " +
    'joined by model name to the Models table for modelId (e.g. "cline-pass/glm-5.3", null when not listed). ' +
    "model: display name as shown; priceInput, priceOutput: USD per 1M tokens as numbers; priceCachedRead, " +
    'priceCachedWrite: number, or null for "-", "—" or an empty cell; notes: optional text for footnotes.',
  priceFields: { input: "priceInput", output: "priceOutput" },
  parse: parseClinePassPricingHtml,
};

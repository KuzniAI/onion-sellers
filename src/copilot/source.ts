import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSource } from "../pricing/source.ts";
import { parseCopilotPricingHtml, type CopilotModelRow } from "./parser.ts";

export const copilotSource: PricingSource<CopilotModelRow> = {
  id: "copilot",
  displayName: "Copilot",
  sourceUrl: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
  outFile: path.join("data", "copilot", "models-pricing.json"),
  notes:
    "Auto-generated from the GitHub Copilot models-and-pricing docs page. " +
    'All prices are per 1M tokens. Models with a "Long context" tier bill at a higher ' +
    "rate once input exceeds thresholdInputTokens; the same model may appear twice " +
    "(Default and Long context rows) -- this is expected, not a duplicate.",
  parserPath: fileURLToPath(new URL("./parser.ts", import.meta.url)),
  parseExport: "parseCopilotPricingHtml",
  rowContract:
    "One row per model pricing row (a model with Default and Long context tiers yields two rows). " +
    "creator: display name of the model vendor; model: name as shown; releaseStatus, category: text as shown; " +
    "tier: tier text or null when the page has no tier; thresholdInputTokens: integer input-token threshold for " +
    "the tier or null; price1mInput, price1mCachedInput, price1mOutput: USD per 1M tokens as numbers; " +
    'price1mCacheWrite: number, or null when shown as "-".',
  priceFields: { input: "price1mInput", output: "price1mOutput" },
  parse: parseCopilotPricingHtml,
};

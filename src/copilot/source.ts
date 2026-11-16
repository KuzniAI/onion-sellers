import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSource } from "../pricing/source.ts";
import { parseCopilotPricingHtml, type CopilotModelRow } from "./parser.ts";

export const copilotSource: PricingSource<CopilotModelRow> = {
  id: "copilot",
  displayName: "Copilot",
  sourceUrl:
    "https://raw.githubusercontent.com/github/docs/main/data/tables/copilot/models-and-pricing.yml",
  format: "yaml",
  outFile: path.join("data", "copilot", "models-pricing.json"),
  notes:
    "Auto-generated from GitHub docs' models-and-pricing.yml (a YAML list of models). " +
    'All prices are per 1M tokens. Models with a "Long context" tier bill at a higher ' +
    "rate once input exceeds thresholdInputTokens; the same model may appear twice " +
    "(Default and Long context rows) -- this is expected, not a duplicate.",
  parserPath: fileURLToPath(new URL("./parser.ts", import.meta.url)),
  parseExport: "parseCopilotPricingHtml",
  rowContract:
    "One row per list item of the YAML (a model with Default and Long context tiers yields two rows). " +
    "creator: the item's provider, as a display name (openai -> OpenAI, xai -> xAI); model: name as shown; releaseStatus, category: text as shown; " +
    "tier: tier text or null when the page has no tier; thresholdInputTokens: integer input-token threshold for " +
    "the tier (the threshold field, e.g. '≤ 200K' -> 200000) or null for 'Not applicable'; price1mInput, price1mCachedInput, price1mOutput: USD per 1M tokens as numbers; " +
    'price1mCacheWrite: number, or null for "Not applicable". Prices are strings like "$1.75" in the YAML.',
  priceFields: { input: "price1mInput", output: "price1mOutput" },
  parse: parseCopilotPricingHtml,
};

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
  parse: parseCopilotPricingHtml,
};

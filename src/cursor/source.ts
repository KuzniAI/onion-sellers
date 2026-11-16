import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSource } from "../pricing/source.ts";
import { parseCursorPricingMarkdown, type CursorModelRow } from "./parser.ts";

export const cursorSource: PricingSource<CursorModelRow> = {
  id: "cursor",
  displayName: "Cursor",
  sourceUrl: "https://cursor.com/docs/models-and-pricing.md",
  format: "markdown",
  outFile: path.join("data", "cursor", "models-pricing.json"),
  notes:
    "Auto-generated from the Cursor models-and-pricing docs page (markdown). Cursor is a " +
    "subscription; prices are API list rates in USD per 1M tokens that usage is drawn " +
    "against. Rows come from the per-provider model tables (Cursor, Anthropic, OpenAI, ...). " +
    "Fast and long-context variants appear as separate rows, matching the source page.",
  parserPath: fileURLToPath(new URL("./parser.ts", import.meta.url)),
  parseExport: "parseCursorPricingMarkdown",
  rowContract:
    "One row per row of every model pricing table (columns Model / Provider / Input / Cache write / " +
    "Cache read / Output / US data residency / Notes); skip the plan table. model: display name with the " +
    'markdown link removed, keeping variant suffixes like "(Fast)" or "500k"; provider: text as shown; ' +
    "priceInput, priceOutput: USD per 1M tokens as numbers; priceCacheWrite, priceCacheRead: number, or null " +
    'for "-"; notes: the Notes cell text, omitted when "-".',
  priceFields: { input: "priceInput", output: "priceOutput" },
  parse: parseCursorPricingMarkdown,
};

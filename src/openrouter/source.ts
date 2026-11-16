import path from "node:path";
import { fileURLToPath } from "node:url";
import type { PricingSource } from "../pricing/source.ts";
import { parseOpenRouterModelsJson, type OpenRouterModelRow } from "./parser.ts";

export const openRouterSource: PricingSource<OpenRouterModelRow> = {
  id: "openrouter",
  displayName: "OpenRouter",
  sourceUrl: "https://openrouter.ai/api/v1/models",
  format: "json",
  outFile: path.join("data", "openrouter", "models-pricing.json"),
  notes:
    "Auto-generated from the OpenRouter /api/v1/models JSON endpoint. OpenRouter is " +
    "pay-as-you-go; prices are converted from USD per token to USD per 1M tokens. " +
    'Reference a model by its modelId (e.g. "openrouter/<modelId>"). Free models have 0 prices.',
  parserPath: fileURLToPath(new URL("./parser.ts", import.meta.url)),
  parseExport: "parseOpenRouterModelsJson",
  rowContract:
    "JSON {data:[...]}; one row per entry of data that is a text-output chat model (skip entries whose " +
    "architecture.output_modalities lacks text, and entries with negative or non-numeric prompt/completion " +
    "pricing such as auto-routers). modelId: entry id; model: entry name; priceInput, priceOutput: " +
    "pricing.prompt / pricing.completion (strings, USD per token) multiplied by 1,000,000 and rounded to avoid " +
    "float noise; priceCachedRead, priceCachedWrite: pricing.input_cache_read / input_cache_write converted the " +
    "same way, or null when absent; notes: optional text.",
  priceFields: { input: "priceInput", output: "priceOutput" },
  parse: parseOpenRouterModelsJson,
};

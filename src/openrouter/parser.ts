export type OpenRouterModelRow = {
  modelId: string;
  model: string;
  priceInput: number;
  priceOutput: number;
  priceCachedRead: number | null;
  priceCachedWrite: number | null;
  notes?: string;
};

// Stub: the OpenRouter source is JSON (https://openrouter.ai/api/v1/models).
// Run `npm start` locally with PARSER_REPAIR=1 and a Pi agent will write the real parser.
export function parseOpenRouterModelsJson(_text: string): OpenRouterModelRow[] {
  throw new Error("parseOpenRouterModelsJson: parser not written yet");
}

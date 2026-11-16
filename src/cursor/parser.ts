export type CursorModelRow = {
  model: string;
  provider: string;
  priceInput: number;
  priceCacheWrite: number | null;
  priceCacheRead: number | null;
  priceOutput: number;
  notes?: string;
};

// Stub: the Cursor source is markdown (https://cursor.com/docs/models-and-pricing.md).
// Run `npm start` locally with PARSER_REPAIR=1 and a Pi agent will write the real parser.
export function parseCursorPricingMarkdown(_text: string): CursorModelRow[] {
  throw new Error("parseCursorPricingMarkdown: parser not written yet");
}

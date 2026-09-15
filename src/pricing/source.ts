export type PricingSource<Row> = {
  id: string;
  displayName: string;
  sourceUrl: string;
  outFile: string;
  notes: string;
  // Absolute path of the parser module, so a repair agent knows which file to rewrite.
  parserPath: string;
  // Name of the parse function exported from parserPath, used to re-import a rewritten parser.
  parseExport: string;
  // Plain-text description of the rows a repair agent must produce.
  rowContract: string;
  // Row fields holding USD per 1M input/output tokens, used for validation and scoring.
  priceFields: { input: string; output: string };
  parse: (html: string) => Row[];
};

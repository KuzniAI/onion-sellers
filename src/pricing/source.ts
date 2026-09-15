export type PricingSource<Row> = {
  id: string;
  displayName: string;
  sourceUrl: string;
  outFile: string;
  notes: string;
  // Absolute path of the parser module, so a repair agent knows which file to rewrite.
  parserPath: string;
  parse: (html: string) => Row[];
};

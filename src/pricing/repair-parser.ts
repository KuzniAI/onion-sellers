import type { PricingSource } from "./source.ts";

export type ParserFailure = {
  source: PricingSource<unknown>;
  html: string;
  error: unknown;
};

// TODO: run a Pi agent via SDK to rewrite `source.parserPath` against the downloaded
// `html`, then retry parsing. For now this only reports the failure.
export async function repairParser({ source, error }: ParserFailure): Promise<void> {
  console.error(
    `[${source.id}] parser failed for ${source.sourceUrl}: ${error instanceof Error ? error.message : String(error)}\n` +
      `  Parser: ${source.parserPath}\n` +
      `  Automatic parser repair is not implemented yet; keeping existing ${source.outFile}.`,
  );
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadHtml } from "./downloader.ts";
import { repairParser } from "./repair-parser.ts";
import type { PricingSource } from "./source.ts";

// Returns false when parsing failed (existing data file is left untouched).
// Network errors are not caught and abort the pipeline.
export async function refreshPricingSource<Row>(source: PricingSource<Row>): Promise<boolean> {
  const html = await downloadHtml(source.sourceUrl);

  let models: Row[];
  try {
    models = source.parse(html);
  } catch (error) {
    await repairParser({ source, html, error });
    return false;
  }

  await mkdir(path.dirname(source.outFile), { recursive: true });
  await writeFile(
    source.outFile,
    JSON.stringify(
      {
        sourceUrl: source.sourceUrl,
        fetchedAt: new Date().toISOString(),
        notes: source.notes,
        models,
      },
      null,
      2,
    ),
  );
  console.log(`Wrote ${models.length} ${source.displayName} models to ${source.outFile}`);
  return true;
}

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { downloadHtml, NetworkError } from "./downloader.ts";
import { repairParser } from "./repair-parser.ts";
import type { PricingSource } from "./source.ts";

// Returns false when the download failed (after retries) or parsing failed and could not be
// repaired; the existing data file is left untouched in both cases.
export async function refreshPricingSource<Row>(source: PricingSource<Row>): Promise<boolean> {
  let html: string;
  try {
    html = await downloadHtml(source.sourceUrl);
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    console.error(`Failed to download ${source.displayName} pricing: ${error.message}`);
    return false;
  }

  let models: Row[];
  try {
    models = source.parse(html);
  } catch (error) {
    const repaired = await repairParser({ source, html, error });
    if (!repaired) return false;
    models = repaired;
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

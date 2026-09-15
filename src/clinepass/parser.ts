import * as cheerio from "cheerio";

export type ClinePassModelRow = {
  model: string;
  modelId: string | null;
  priceInput: number;
  priceOutput: number;
  priceCachedRead: number | null;
  priceCachedWrite: number | null;
  notes?: string;
};

export function parseClinePassPricingHtml(html: string): ClinePassModelRow[] {
  const $ = cheerio.load(html);
  const tables = $("table").toArray();

  const pricingTable = findTableByHeaders($, tables, [
    "Model",
    "Input",
    "Output",
    "Cached Read",
    "Cached Write",
  ]);
  const modelsTable = findTableByHeaders($, tables, ["Model", "Model ID"]);

  if (!pricingTable) {
    throw new Error(
      "parseClinePassPricingHtml: reference pricing table not found -- page structure may have changed",
    );
  }
  if (!modelsTable) {
    throw new Error(
      "parseClinePassPricingHtml: models table not found -- page structure may have changed",
    );
  }

  // Footnote definitions appear right after the pricing table as paragraphs like
  // "<sup>1</sup> DeepSeek API pricing"; map footnote number -> its text.
  const footnotes = new Map<string, string>();
  for (const sup of $("sup").toArray()) {
    const marker = cellText($(sup));
    if (!/^\d+$/.test(marker)) continue;
    const clone = $(sup).parent().clone();
    clone.find("sup").remove();
    const text = clone.text().replace(/\s+/g, " ").trim();
    if (text) footnotes.set(marker, text);
  }

  const modelIds = rowsByModel($, modelsTable);

  const rows: ClinePassModelRow[] = [];
  for (const tr of $(pricingTable).find("tbody tr").toArray()) {
    const cells = $(tr).find("td").toArray();
    if (cells.length < 5) {
      throw new Error(
        `parseClinePassPricingHtml: pricing row has ${cells.length} cells, expected 5 -- page structure may have changed`,
      );
    }

    // Display name without the footnote marker; the marker becomes the notes field.
    const $modelCell = $(cells[0]);
    const footnoteMarkers = $modelCell
      .find("sup")
      .toArray()
      .map((sup) => cellText($(sup)))
      .filter((marker) => /^\d+$/.test(marker));
    const model = cloneWithoutSup($modelCell).text().trim();

    const notes = footnoteMarkers
      .map((marker) => footnotes.get(marker))
      .filter((text): text is string => Boolean(text))
      .join("; ");

    // The pricing table splits some models into variant rows (peak/off-peak,
    // context thresholds) while the models table lists each model once under
    // its base name, so fall back to the base name for the modelId join.
    const base = stripVariantSuffix(model);
    const idRow = modelIds.get(model) ?? modelIds.get(base);

    const priceInput = parseRequiredPrice(cellText($(cells[1])), model, "Input");
    const priceOutput = parseRequiredPrice(cellText($(cells[2])), model, "Output");

    rows.push({
      model,
      modelId: idRow?.[1] ?? null,
      priceInput,
      priceOutput,
      priceCachedRead: parsePrice(cellText($(cells[3]))),
      priceCachedWrite: parsePrice(cellText($(cells[4]))),
      notes: notes || undefined,
    });
  }

  if (rows.length === 0) {
    throw new Error(
      "parseClinePassPricingHtml: no model rows found in the reference pricing table -- page structure may have changed",
    );
  }
  return rows;
}

// Strips a trailing variant qualifier like " (Peak)", " (Off-peak)" or
// "(≤ 256K tokens)" so variant pricing rows still join against the models
// table, which only lists each model under its base name.
function stripVariantSuffix(model: string): string {
  return model.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function findTableByHeaders($: cheerio.CheerioAPI, tables: any[], expected: string[]) {
  return tables.find((table) => {
    const headers = $(table)
      .find("thead th")
      .toArray()
      .map((th) => cellText($(th)));
    return expected.every((name) => headers.includes(name));
  });
}

// Model name -> all cell texts for that row (index 0 is always the model name itself).
function rowsByModel($: cheerio.CheerioAPI, table: any): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (!table) return map;
  for (const tr of $(table).find("tbody tr").toArray()) {
    const cells = $(tr)
      .find("td")
      .toArray()
      .map((td) => cellText($(td)));
    map.set(cells[0], cells);
  }
  return map;
}

function cloneWithoutSup($cell: cheerio.Cheerio<any>): cheerio.Cheerio<any> {
  const clone = $cell.clone();
  clone.find("sup").remove();
  return clone;
}

// Required cell (Input/Output): must be a numeric USD price. Anything else is
// fatal so we never silently emit partial or wrong pricing data.
function parseRequiredPrice(text: string, model: string, column: string): number {
  const price = parsePrice(text);
  if (price === null) {
    throw new Error(
      `parseClinePassPricingHtml: unexpected ${column} price for "${model}": "${text}" -- page structure may have changed`,
    );
  }
  return price;
}

// Optional cell (Cached Read/Cached Write): "-", "—", "" and other non-numeric
// placeholders mean "not offered" -> null.
function parsePrice(text: string | null): number | null {
  if (text === null) return null;
  const stripped = text.replace("$", "").trim();
  if (!/^(\d+(\.\d+)?|\.\d+)$/.test(stripped)) return null;
  return parseFloat(stripped);
}

function cellText($cell: cheerio.Cheerio<any>): string {
  return $cell.text().trim();
}

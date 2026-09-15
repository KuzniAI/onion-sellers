import * as cheerio from "cheerio";

export type OpenCodeZenModelRow = {
  model: string;
  priceInput: number;
  priceOutput: number;
  priceCachedRead: number | null;
  priceCachedWrite: number | null;
  notes?: string;
};

const PRICING_HEADERS = ["Model", "Input", "Output", "Cached Read", "Cached Write"];

export function parseOpenCodeZenPricingHtml(html: string): OpenCodeZenModelRow[] {
  const $ = cheerio.load(html);
  const tables = $("table").toArray();

  const pricingTable = tables.find((table) => {
    const headers = $(table)
      .find("thead th")
      .toArray()
      .map((th) => cellText($(th)));
    return PRICING_HEADERS.every((name) => headers.includes(name));
  });

  if (!pricingTable) {
    throw new Error(
      "parseOpenCodeZenPricingHtml: pricing table not found (expected headers: " +
        PRICING_HEADERS.join(", ") +
        ") -- page structure may have changed",
    );
  }

  // Footnote paragraphs directly after the pricing table are keyed by model name
  // in a <strong> tag, e.g. "<p><strong>GPT 5.6 Sol:</strong> Prices shown ...</p>".
  const footnotes = new Map<string, string>();
  for (const p of $(pricingTable).nextAll("p").toArray()) {
    const strong = $(p).find("strong").first();
    if (strong.length === 0) continue;
    const key = cellText(strong).replace(/:$/, "").trim();
    const rest = $(p).text().trim().slice(cellText(strong).length).trim();
    if (key && rest) footnotes.set(key, rest.replace(/^:\s*/, ""));
  }

  const rows: OpenCodeZenModelRow[] = [];
  for (const tr of $(pricingTable).find("tbody tr").toArray()) {
    const cells = $(tr).find("td").toArray();
    if (cells.length < PRICING_HEADERS.length) {
      throw new Error(
        `parseOpenCodeZenPricingHtml: pricing row has ${cells.length} cells, expected ${PRICING_HEADERS.length}`,
      );
    }

    const model = cellText($(cells[0]));
    if (!model) continue;

    const priceInput = parseRequiredPrice(cellText($(cells[1])), model, "Input");
    const priceOutput = parseRequiredPrice(cellText($(cells[2])), model, "Output");

    // Footnote paragraphs key models by base name ("GPT 5.6 Sol"), while the table
    // splits context-threshold variants ("GPT 5.6 Sol (≤ 272K tokens)").
    const notes = footnotes.get(model) ?? footnotes.get(stripVariantSuffix(model));

    rows.push({
      model,
      priceInput,
      priceOutput,
      priceCachedRead: parseOptionalPrice(cellText($(cells[3]))),
      priceCachedWrite: parseOptionalPrice(cellText($(cells[4]))),
      ...(notes ? { notes } : {}),
    });
  }

  if (rows.length === 0) {
    throw new Error(
      "parseOpenCodeZenPricingHtml: no model rows found in pricing table -- page structure may have changed",
    );
  }
  return rows;
}

// Required cell: a USD-per-1M-tokens price, or "Free" (0). Anything else is fatal
// so we never silently emit partial or wrong pricing data.
function parseRequiredPrice(text: string, model: string, column: string): number {
  const price = parsePriceOrFree(text);
  if (price === undefined) {
    throw new Error(
      `parseOpenCodeZenPricingHtml: unexpected ${column} price for "${model}": "${text}"`,
    );
  }
  return price;
}

// Optional cell: like a required price, but "-", "--", em dash or an empty cell
// means "not applicable" and maps to null.
function parseOptionalPrice(text: string): number | null {
  const price = parsePriceOrFree(text);
  return price === undefined ? null : price;
}

function parsePriceOrFree(text: string): number | undefined {
  const cleaned = text.trim();
  if (cleaned === "") return undefined;
  if (/^free$/i.test(cleaned)) return 0;
  if (/^(--?|—|–)$/.test(cleaned)) return undefined;
  if (!/^\$\d+(\.\d+)?$/.test(cleaned)) return undefined;
  return parseFloat(cleaned.replace("$", ""));
}

// Strips a trailing variant qualifier like " (≤ 272K tokens)".
function stripVariantSuffix(model: string): string {
  return model.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function cellText($cell: cheerio.Cheerio<any>): string {
  const clone = $cell.clone();
  clone.find("sup").remove();
  return clone.text().trim().replace(/\s+/g, " ");
}

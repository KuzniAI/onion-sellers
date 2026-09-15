import * as cheerio from "cheerio";

export type OpenCodeGoModelRow = {
  model: string;
  modelId: string | null;
  priceInput: number;
  priceOutput: number;
  priceCachedRead: number | null;
  priceCachedWrite: number | null;
  monthlyLimitUsd: number;
  requestsPer5h: number | null;
  requestsPerWeek: number | null;
  requestsPerMonth: number | null;
  endpoint: string | null;
  aiSdkPackage: string | null;
  modelTraining: string | null;
  dataRetentionDays: number | null;
  notes?: string;
};

export function parseOpenCodeGoPricingHtml(html: string): OpenCodeGoModelRow[] {
  const $ = cheerio.load(html);
  const tables = $("table").toArray();

  const pricingTable = findTableByHeaders($, tables, [
    "Model",
    "Input",
    "Output",
    "Cached Read",
    "Cached Write",
    "Monthly limit",
  ]);
  const requestsTable = findTableByHeaders($, tables, [
    "Model",
    "requests per 5 hour",
    "requests per week",
    "requests per month",
  ]);
  const endpointsTable = findTableByHeaders($, tables, [
    "Model",
    "Model ID",
    "Endpoint",
    "AI SDK Package",
  ]);
  const privacyTable = findTableByHeaders($, tables, ["Model", "Model training", "Data retention"]);

  if (!pricingTable) {
    throw new Error(
      "parseOpenCodeGoPricingHtml: pricing table not found -- page structure may have changed",
    );
  }

  const requestsByModel = rowsByModel($, requestsTable);
  const endpointsByModel = rowsByModel($, endpointsTable);
  const privacyByModel = rowsByModel($, privacyTable);

  const rows: OpenCodeGoModelRow[] = [];
  for (const tr of $(pricingTable).find("tbody tr").toArray()) {
    const cells = $(tr).find("td").toArray();
    const model = cellText($(cells[0]));
    const { limit, note: limitNote } = parseMonthlyLimit($, cells[5]);

    // The requests/endpoints/privacy tables list each model once under its base name
    // (no peak/off-peak or context-threshold split), so fall back to the base name
    // when the pricing table's variant-suffixed name has no exact match.
    const base = stripVariantSuffix(model);
    const req = requestsByModel.get(model) ?? requestsByModel.get(base);
    const ep = endpointsByModel.get(model) ?? endpointsByModel.get(base);
    const priv = privacyByModel.get(model) ?? privacyByModel.get(base);
    const missing = [!req && "requests", !ep && "endpoints", !priv && "privacy"].filter(
      (x): x is string => Boolean(x),
    );
    if (missing.length > 0) {
      console.warn(`opencode-go: "${model}" has no matching row in: ${missing.join(", ")}`);
    }

    const { days, note: retentionNote } = parseDataRetention(priv?.[2] ?? null);

    rows.push({
      model,
      modelId: ep?.[1] ?? null,
      priceInput: parsePrice(cellText($(cells[1])))!,
      priceOutput: parsePrice(cellText($(cells[2])))!,
      priceCachedRead: parsePrice(cellText($(cells[3]))),
      priceCachedWrite: parsePrice(cellText($(cells[4]))),
      monthlyLimitUsd: limit,
      requestsPer5h: req ? parseCount(req[1]) : null,
      requestsPerWeek: req ? parseCount(req[2]) : null,
      requestsPerMonth: req ? parseCount(req[3]) : null,
      endpoint: ep?.[2] ?? null,
      aiSdkPackage: ep?.[3] ?? null,
      modelTraining: priv?.[1] ?? null,
      dataRetentionDays: days,
      notes: [limitNote, retentionNote].filter(Boolean).join("; ") || undefined,
    });
  }

  if (rows.length === 0) {
    throw new Error(
      "parseOpenCodeGoPricingHtml: no model rows found -- page structure may have changed",
    );
  }
  return rows;
}

// Strips a trailing variant qualifier like " (Off-Peak)", " (Peak)", " (≤ 256K tokens)"
// so peak/off-peak and context-threshold pricing rows can still join against the
// requests/endpoints/privacy tables, which only list each model under its base name.
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

function parseMonthlyLimit($: cheerio.CheerioAPI, cell: any): { limit: number; note?: string } {
  const $cell = $(cell);
  const strong = $cell.find("strong");
  if (strong.length > 0) {
    const del = $cell.find("del");
    const small = $cell.find("small");
    const base = del.length > 0 ? parsePrice(cellText(del)) : null;
    const promo = small.length > 0 ? cellText(small) : null;
    const note =
      base !== null
        ? `Promotional monthly limit (base $${base}): ${promo ?? ""}`.trim()
        : (promo ?? undefined);
    return { limit: parsePrice(cellText(strong))!, note };
  }
  return { limit: parsePrice(cellText($cell))! };
}

function parseDataRetention(text: string | null): { days: number | null; note?: string } {
  if (text === null) return { days: null };

  const hadFootnoteMark = text.endsWith("*");
  const stripped = hadFootnoteMark ? text.slice(0, -1) : text;

  const match = stripped.match(/(\d+)\s*days/);
  if (!match) {
    return { days: null, note: text };
  }
  return { days: Number(match[1]), note: hadFootnoteMark ? "see page footnote *" : undefined };
}

function parseCount(text: string): number {
  return parseInt(text.replace(/,/g, ""), 10);
}

function parsePrice(text: string | null): number | null {
  if (text === null || text === "-") return null;
  return parseFloat(text.replace("$", ""));
}

// Strips footnote/promo markup noise so plain-text extraction stays predictable;
// callers that need the sub-structure (e.g. <strong>/<del>/<small>) read it before calling this.
function cellText($cell: cheerio.Cheerio<any>): string {
  const clone = $cell.clone();
  clone.find("sup").remove();
  return clone.text().trim();
}

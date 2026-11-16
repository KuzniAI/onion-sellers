export type ClinePassModelRow = {
  model: string;
  modelId: string | null;
  priceInput: number;
  priceOutput: number;
  priceCachedRead: number | null;
  priceCachedWrite: number | null;
  notes?: string;
};

const FN = "parseClinePassPricingHtml";

const PRICING_HEADERS = ["Model", "Input", "Output", "Cached Read", "Cached Write"] as const;
const MODELS_HEADERS = ["Model", "Model ID"] as const;

type Table = {
  headers: string[];
  rows: { cells: string[]; line: number }[];
  line: number;
};

export function parseClinePassPricingHtml(text: string): ClinePassModelRow[] {
  const tables = parseTables(text);
  const pricing = findTable(tables, PRICING_HEADERS, "reference pricing");
  const models = findTable(tables, MODELS_HEADERS, "models");
  const footnotes = parseFootnotes(text);
  const modelIds = modelIdsByName(models);

  const rows: ClinePassModelRow[] = [];
  for (const { cells, line } of pricing.rows) {
    if (cells.length !== pricing.headers.length) {
      throw new Error(
        `${FN}: pricing row at line ${line} has ${cells.length} cells, expected ${pricing.headers.length} -- page structure may have changed`,
      );
    }

    const { name, markers } = extractFootnoteMarkers(cells[0] ?? "");
    const model = name;
    if (model === "") {
      throw new Error(`${FN}: pricing row at line ${line} has an empty model name`);
    }

    const notes = [
      ...footnoteNotes(markers, footnotes, model, line),
      ...cacheWriteNotes(cells[4] ?? "", model, line),
    ];
    const base = stripVariantSuffix(model);
    const modelId = modelIds.get(model) ?? modelIds.get(base) ?? null;

    const row: ClinePassModelRow = {
      model,
      modelId,
      priceInput: parseRequiredPrice(cells[1] ?? "", "Input", model, line),
      priceOutput: parseRequiredPrice(cells[2] ?? "", "Output", model, line),
      priceCachedRead: parseOptionalPrice(cells[3] ?? "", "Cached Read", model, line),
      priceCachedWrite: parseOptionalPrice(cells[4] ?? "", "Cached Write", model, line),
    };
    if (notes.length > 0) row.notes = notes.join("; ");
    rows.push(row);
  }

  if (rows.length === 0) {
    throw new Error(
      `${FN}: no model rows found in the reference pricing table -- page structure may have changed`,
    );
  }
  return rows;
}

function findTable(tables: Table[], expected: readonly string[], label: string): Table {
  const matches = tables.filter((table) => sameHeaders(table.headers, expected));
  if (matches.length === 0) {
    const missing =
      label === "reference pricing"
        ? `${FN}: reference pricing table not found -- page structure may have changed`
        : `${FN}: ${label} table not found -- page structure may have changed`;
    throw new Error(missing);
  }
  if (matches.length > 1) {
    throw new Error(`${FN}: multiple ${label} tables found -- page structure may have changed`);
  }
  const table = matches[0];
  if (!table || table.rows.length === 0) {
    throw new Error(
      `${FN}: no model rows found in the ${label} table -- page structure may have changed`,
    );
  }
  return table;
}

function sameHeaders(headers: string[], expected: readonly string[]): boolean {
  if (headers.length !== expected.length) return false;
  return expected.every((name, index) => headers[index] === name);
}

function modelIdsByName(table: Table): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const { cells, line } of table.rows) {
    if (cells.length !== table.headers.length) {
      throw new Error(
        `${FN}: models row at line ${line} has ${cells.length} cells, expected ${table.headers.length} -- page structure may have changed`,
      );
    }
    const name = cleanCell(cells[0] ?? "");
    if (name === "") {
      throw new Error(`${FN}: models row at line ${line} has an empty model name`);
    }
    if (map.has(name)) {
      throw new Error(`${FN}: models table lists "${name}" more than once`);
    }
    const id = cleanCell(cells[1] ?? "");
    map.set(name, id === "" || isPlaceholder(id) ? null : id);
  }
  return map;
}

// Strips a trailing variant qualifier like " (Peak)", " (Off-peak)" or
// "(≤ 256K tokens)" so variant pricing rows still join against the models
// table, which only lists each model under its base name.
function stripVariantSuffix(model: string): string {
  return model.replace(/\s*\([^)]*\)\s*$/, "").trim();
}

function parseFootnotes(text: string): Map<string, string> {
  const footnotes = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    const sup = /^<sup>(\d+)<\/sup>\s*(.*)$/.exec(trimmed);
    const md = sup ? null : /^\[\^(\d+)\]:\s*(.*)$/.exec(trimmed);
    const match = sup ?? md;
    if (!match) continue;
    const marker = match[1] ?? "";
    const body = cleanCell(match[2] ?? "");
    if (marker === "" || body === "") continue;
    footnotes.set(marker, body);
  }
  return footnotes;
}

function extractFootnoteMarkers(raw: string): { name: string; markers: string[] } {
  const markers: string[] = [];
  const without = raw.replace(/<sup>(\d+)<\/sup>|\[\^(\d+)\]/g, (_full, sup, md) => {
    const marker = typeof sup === "string" && sup !== "" ? sup : md;
    if (typeof marker === "string" && marker !== "") markers.push(marker);
    return "";
  });
  return { name: cleanCell(without), markers };
}

function footnoteNotes(
  markers: string[],
  footnotes: Map<string, string>,
  model: string,
  line: number,
): string[] {
  return markers.map((marker) => {
    const text = footnotes.get(marker);
    if (!text) {
      throw new Error(
        `${FN}: line ${line} (${model}) references footnote ${marker}, but that footnote was not found`,
      );
    }
    return text;
  });
}

// "$2.00 (5min) / $4.00 (1h)" is a real price, not a missing cell. Keep one row
// (the contract is one row per pricing-table row) and record every TTL in notes.
function cacheWriteNotes(raw: string, model: string, line: number): string[] {
  const text = cleanCell(raw);
  if (isPlaceholder(text) || parseUsd(text) !== null) return [];
  const tiers = parseTtlPrices(text);
  if (!tiers) {
    throw new Error(
      `${FN}: unexpected Cached Write price for "${model}" at line ${line}: ${JSON.stringify(text)} -- page structure may have changed`,
    );
  }
  return [
    `Cache write by TTL: ${text} (priceCachedWrite is the shortest TTL, $${formatUsd(tiers[0]?.price ?? 0)})`,
  ];
}

function parseRequiredPrice(raw: string, column: string, model: string, line: number): number {
  const text = cleanCell(raw);
  const price = parseUsd(text);
  if (price === null) {
    throw new Error(
      `${FN}: unexpected ${column} price for "${model}" at line ${line}: ${JSON.stringify(text)} -- page structure may have changed`,
    );
  }
  return price;
}

function parseOptionalPrice(
  raw: string,
  column: string,
  model: string,
  line: number,
): number | null {
  const text = cleanCell(raw);
  if (isPlaceholder(text)) return null;
  const price = parseUsd(text);
  if (price !== null) return price;
  const tiers = parseTtlPrices(text);
  if (!tiers) {
    throw new Error(
      `${FN}: unexpected ${column} price for "${model}" at line ${line}: ${JSON.stringify(text)} -- page structure may have changed`,
    );
  }
  const shortest = tiers[0];
  if (!shortest) {
    throw new Error(
      `${FN}: unexpected ${column} price for "${model}" at line ${line}: ${JSON.stringify(text)} -- page structure may have changed`,
    );
  }
  return shortest.price;
}

function parseUsd(text: string): number | null {
  const match = /^\$(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

type TtlPrice = { minutes: number; price: number };

function parseTtlPrices(text: string): TtlPrice[] | null {
  const parts = text
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  if (parts.length < 2) return null;
  const tiers: TtlPrice[] = [];
  for (const part of parts) {
    const match = /^\$(\d+(?:\.\d+)?)\s*\(([^)]+)\)$/.exec(part);
    if (!match) return null;
    const price = Number(match[1]);
    const minutes = parseDuration(match[2] ?? "");
    if (!Number.isFinite(price) || minutes === null) return null;
    tiers.push({ minutes, price });
  }
  tiers.sort((a, b) => a.minutes - b.minutes);
  return tiers;
}

function parseDuration(label: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|m|h|hr|hrs|hour|hours)$/i.exec(
    label.trim(),
  );
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  const unit = (match[2] ?? "").toLowerCase();
  if (unit === "h" || unit.startsWith("hr") || unit.startsWith("hour")) return amount * 60;
  return amount;
}

function formatUsd(value: number): string {
  return Number.isInteger(value) ? value.toFixed(2) : String(value);
}

function isPlaceholder(text: string): boolean {
  return text === "" || text === "-" || text === "—" || text === "–";
}

function parseTables(text: string): Table[] {
  const lines = text.split(/\r?\n/);
  const tables: Table[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const headerCells = splitPipeRow(line);
    if (!headerCells) continue;
    const separator = lines[i + 1] ?? "";
    if (!isSeparatorRow(separator)) continue;

    const headers = headerCells.map((cell) => cleanCell(cell));
    const tableLine = i + 1;
    const rows: Table["rows"] = [];
    i += 2;
    for (; i < lines.length; i++) {
      const rowLine = lines[i] ?? "";
      if (/^\s*(```|~~~)/.test(rowLine)) {
        i -= 1;
        break;
      }
      const cells = splitPipeRow(rowLine);
      if (!cells) break;
      if (isSeparatorRow(rowLine)) {
        throw new Error(`${FN}: unexpected separator row at line ${i + 1}`);
      }
      rows.push({ cells, line: i + 1 });
    }
    i -= 1;
    tables.push({ headers, rows, line: tableLine });
  }

  return tables;
}

// Splits a markdown pipe row on unescaped `|`. Returns null when the line is not a table row.
function splitPipeRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return null;

  const cells: string[] = [];
  let current = "";
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === "\\" && i + 1 < trimmed.length) {
      current += ch + trimmed[i + 1];
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());

  if (cells[0] === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function isSeparatorRow(line: string): boolean {
  const cells = splitPipeRow(line);
  if (!cells || cells.length === 0) return false;
  return cells.every((cell) => /^:?-+:?$/.test(cell));
}

function cleanCell(raw: string): string {
  const withoutLinks = raw.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  const unescaped = withoutLinks.replace(/\\(.)/g, "$1");
  return unescaped.replace(/`([^`]*)`/g, "$1").trim();
}

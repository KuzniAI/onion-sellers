export type CursorModelRow = {
  model: string;
  provider: string;
  priceInput: number;
  priceCacheWrite: number | null;
  priceCacheRead: number | null;
  priceOutput: number;
  notes?: string;
};

const FN = "parseCursorPricingMarkdown";

const EXPECTED_HEADERS = [
  "Model",
  "Provider",
  "Input",
  "Cache write",
  "Cache read",
  "Output",
  "US data residency",
  "Notes",
] as const;

export function parseCursorPricingMarkdown(text: string): CursorModelRow[] {
  const lines = text.split(/\r?\n/);
  const rows: CursorModelRow[] = [];
  let tablesFound = 0;

  for (let i = 0; i < lines.length; i++) {
    const cells = splitPipeRow(lines[i] ?? "");
    if (!cells || !headersMatch(cells)) continue;

    tablesFound += 1;
    const tableLine = i + 1;
    i += 1;
    if (i >= lines.length || !isSeparatorRow(lines[i] ?? "")) {
      throw new Error(
        `${FN}: model pricing table at line ${tableLine} is missing its separator row`,
      );
    }

    const tableRows: CursorModelRow[] = [];
    for (i += 1; i < lines.length; i++) {
      const rowCells = splitPipeRow(lines[i] ?? "");
      if (!rowCells) break;
      if (isSeparatorRow(lines[i] ?? "")) {
        throw new Error(`${FN}: unexpected separator row at line ${i + 1}`);
      }
      tableRows.push(parseModelRow(rowCells, i + 1));
    }
    i -= 1;

    if (tableRows.length === 0) {
      throw new Error(`${FN}: model pricing table at line ${tableLine} has no rows`);
    }
    rows.push(...tableRows);
  }

  if (tablesFound === 0) {
    throw new Error(
      `${FN}: expected model pricing table (${EXPECTED_HEADERS.join(" / ")}) was not found`,
    );
  }
  if (rows.length === 0) {
    throw new Error(`${FN}: no model rows found`);
  }
  return rows;
}

function headersMatch(cells: string[]): boolean {
  if (cells.length !== EXPECTED_HEADERS.length) return false;
  return EXPECTED_HEADERS.every((header, index) => cells[index] === header);
}

function parseModelRow(cells: string[], line: number): CursorModelRow {
  if (cells.length !== EXPECTED_HEADERS.length) {
    throw new Error(
      `${FN}: line ${line} has ${cells.length} columns, expected ${EXPECTED_HEADERS.length}`,
    );
  }

  const model = cleanCell(cells[0] ?? "");
  const provider = cleanCell(cells[1] ?? "");
  if (model === "") {
    throw new Error(`${FN}: line ${line} has an empty model name`);
  }
  if (provider === "") {
    throw new Error(`${FN}: line ${line} (${model}) has an empty provider`);
  }

  const notes = cleanCell(cells[7] ?? "");
  const row: CursorModelRow = {
    model,
    provider,
    priceInput: parseRequiredPrice(cells[2] ?? "", "Input", model, line),
    priceCacheWrite: parseOptionalPrice(cells[3] ?? "", "Cache write", model, line),
    priceCacheRead: parseOptionalPrice(cells[4] ?? "", "Cache read", model, line),
    priceOutput: parseRequiredPrice(cells[5] ?? "", "Output", model, line),
  };
  if (notes !== "" && notes !== "-") row.notes = notes;
  return row;
}

function parseRequiredPrice(raw: string, field: string, model: string, line: number): number {
  const price = parsePrice(raw, field, model, line);
  if (price === null) {
    throw new Error(`${FN}: line ${line} (${model}) ${field} is "-", expected a USD price`);
  }
  return price;
}

function parseOptionalPrice(
  raw: string,
  field: string,
  model: string,
  line: number,
): number | null {
  return parsePrice(raw, field, model, line);
}

function parsePrice(raw: string, field: string, model: string, line: number): number | null {
  const text = cleanCell(raw);
  if (text === "-") return null;
  const match = /^\$(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) {
    throw new Error(
      `${FN}: line ${line} (${model}) ${field} is not a USD per 1M tokens price (${JSON.stringify(text)})`,
    );
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    throw new Error(`${FN}: line ${line} (${model}) ${field} is not a finite number`);
  }
  return value;
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
  return cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function cleanCell(raw: string): string {
  const withoutLinks = raw.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  return withoutLinks.replace(/\\(.)/g, "$1").trim();
}

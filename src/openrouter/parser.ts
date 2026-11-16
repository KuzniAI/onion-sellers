export type OpenRouterModelRow = {
  modelId: string;
  model: string;
  priceInput: number;
  priceOutput: number;
  priceCachedRead: number | null;
  priceCachedWrite: number | null;
  notes?: string;
};

const FN = "parseOpenRouterModelsJson";

// USD per token, as published by OpenRouter (optional leading minus for routers).
const TOKEN_PRICE = /^-?\d+(?:\.\d+)?$/;

export function parseOpenRouterModelsJson(text: string): OpenRouterModelRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${FN}: invalid JSON (${detail})`);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.data)) {
    throw new Error(
      `${FN}: expected pricing table {data:[...]} was not found -- page structure may have changed`,
    );
  }
  if (parsed.data.length === 0) {
    throw new Error(`${FN}: no model rows found -- page structure may have changed`);
  }

  const rows: OpenRouterModelRow[] = [];
  for (let index = 0; index < parsed.data.length; index++) {
    const row = parseEntry(parsed.data[index], index);
    if (row) rows.push(row);
  }
  if (rows.length === 0) {
    throw new Error(`${FN}: no text-output model rows found -- page structure may have changed`);
  }
  return rows;
}

function parseEntry(entry: unknown, index: number): OpenRouterModelRow | null {
  if (!isRecord(entry)) {
    throw new Error(`${FN}: data[${index}] is not an object`);
  }

  const modelId = expectString(entry.id, `data[${index}].id`);
  const model = expectString(entry.name, `data[${index}].name`);
  const where = `data[${index}] "${model}" (${modelId})`;

  if (!outputsText(entry.architecture, where)) return null;

  if (!isRecord(entry.pricing)) {
    throw new Error(`${FN}: ${where} is missing pricing`);
  }
  const prompt = readPromptPrice(entry.pricing.prompt, `${where} pricing.prompt`);
  const completion = readPromptPrice(entry.pricing.completion, `${where} pricing.completion`);
  // Auto-routers publish negative prices; other non-numeric sentinels are not billable rows.
  if (prompt === null || completion === null) return null;

  const row: OpenRouterModelRow = {
    modelId,
    model,
    priceInput: prompt,
    priceOutput: completion,
    priceCachedRead: readCachePrice(
      entry.pricing.input_cache_read,
      `${where} pricing.input_cache_read`,
    ),
    priceCachedWrite: readCachePrice(
      entry.pricing.input_cache_write,
      `${where} pricing.input_cache_write`,
    ),
  };
  const notes = cacheWriteNote(entry.pricing.input_cache_write_1h, where);
  if (notes) row.notes = notes;
  return row;
}

function outputsText(architecture: unknown, where: string): boolean {
  if (!isRecord(architecture)) {
    throw new Error(`${FN}: ${where} is missing architecture`);
  }
  const modalities = architecture.output_modalities;
  if (!Array.isArray(modalities)) {
    throw new Error(`${FN}: ${where} architecture.output_modalities is missing`);
  }
  for (let i = 0; i < modalities.length; i++) {
    if (typeof modalities[i] !== "string") {
      throw new Error(`${FN}: ${where} architecture.output_modalities[${i}] is not a string`);
    }
  }
  return modalities.includes("text");
}

// Required prompt/completion: skip the row when the published price is negative or not numeric.
function readPromptPrice(value: unknown, where: string): number | null {
  if (typeof value !== "string") {
    throw new Error(`${FN}: ${where} is missing or not a string`);
  }
  if (!TOKEN_PRICE.test(value) || value.startsWith("-")) return null;
  return usdPerMillion(value);
}

// Absent cache prices stay null. A present but unusable value is a shape error, not a silent null.
function readCachePrice(value: unknown, where: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !TOKEN_PRICE.test(value) || value.startsWith("-")) {
    throw new Error(`${FN}: ${where} is not a non-negative USD-per-token string`);
  }
  return usdPerMillion(value);
}

function cacheWriteNote(value: unknown, where: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !TOKEN_PRICE.test(value) || value.startsWith("-")) {
    throw new Error(
      `${FN}: ${where} pricing.input_cache_write_1h is not a non-negative USD-per-token string`,
    );
  }
  return `1h cache write $${formatUsd(usdPerMillion(value))} per 1M tokens`;
}

// Shift the decimal point instead of multiplying, so 0.0000001405 becomes 0.1405 rather than 0.14049999999999999.
function usdPerMillion(perToken: string): number {
  const [intPart, fracPart = ""] = perToken.split(".");
  const digits = `${intPart}${fracPart}`;
  let shifted: string;
  if (fracPart.length <= 6) {
    shifted = `${digits}${"0".repeat(6 - fracPart.length)}`;
  } else {
    const point = intPart.length + 6;
    shifted = `${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  shifted = shifted.replace(/^0+(?=\d)/, "");
  if (shifted.startsWith(".")) shifted = `0${shifted}`;
  shifted = shifted.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  if (shifted === "") shifted = "0";
  const price = Number(shifted);
  if (!Number.isFinite(price)) {
    throw new Error(`${FN}: could not convert token price ${JSON.stringify(perToken)}`);
  }
  return price;
}

function formatUsd(price: number): string {
  return String(price);
}

function expectString(value: unknown, where: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${FN}: ${where} is missing or not a non-empty string`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

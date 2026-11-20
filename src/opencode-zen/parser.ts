export type OpenCodeZenModelRow = {
  model: string;
  priceInput: number;
  priceOutput: number;
  priceCachedRead: number | null;
  priceCachedWrite: number | null;
  notes?: string;
};

const FN = "parseOpenCodeZenPricingHtml";

type CachePrices = {
  read: number | null;
  write: number | null;
  notes: string[];
};

type Tier = {
  suffix: string;
  priceInput: number;
  priceOutput: number;
  cache: CachePrices;
};

export function parseOpenCodeZenPricingHtml(text: string): OpenCodeZenModelRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${FN}: invalid JSON (${detail})`);
  }

  if (!isRecord(parsed) || parsed.object !== "list" || !Array.isArray(parsed.data)) {
    throw new Error(
      `${FN}: pricing table not found (expected JSON {object:'list', data:[...]} with name and cost.text input/output prices) -- page structure may have changed`,
    );
  }
  if (parsed.data.length === 0) {
    throw new Error(`${FN}: no model rows found -- page structure may have changed`);
  }

  const rows = parsed.data.flatMap((entry, index) => parseEntry(entry, index));
  if (rows.length === 0) {
    throw new Error(`${FN}: no model rows found -- page structure may have changed`);
  }
  return rows;
}

function parseEntry(entry: unknown, index: number): OpenCodeZenModelRow[] {
  if (!isRecord(entry)) {
    throw new Error(`${FN}: data[${index}] is not an object`);
  }
  const name = expectString(entry, "name", `data[${index}].name`);
  const where = `"${name}"`;

  // The endpoint also lists embedding, image, realtime and other non-chat
  // models priced per image/minute. Only chat models are compared here.
  if (entry.type !== undefined && entry.type !== "chat") {
    if (typeof entry.type !== "string") throw new Error(`${FN}: ${where} type is not a string`);
    return [];
  }

  if (!isRecord(entry.cost)) {
    throw new Error(`${FN}: ${where} is missing cost -- pricing table may have changed`);
  }
  assertOnlyKeys(entry.cost, ["text", "audio", "multipliers"], `${where} cost`);
  if (!isRecord(entry.cost.text)) {
    throw new Error(`${FN}: ${where} is missing cost.text -- pricing table may have changed`);
  }
  assertOnlyKeys(entry.cost.text, ["input", "output"], `${where} cost.text`);

  const tiers = parseTiers(entry.cost.text, where);
  const extraNotes = [
    ...parseMultiplierNotes(entry.cost.multipliers, where),
    ...parseAudioNotes(entry.cost.audio, where),
  ];

  return tiers.map((tier) => {
    const notes = [...tier.cache.notes, ...extraNotes];
    const row: OpenCodeZenModelRow = {
      model: `${name}${tier.suffix}`,
      priceInput: tier.priceInput,
      priceOutput: tier.priceOutput,
      priceCachedRead: tier.cache.read,
      priceCachedWrite: tier.cache.write,
    };
    if (notes.length > 0) row.notes = notes.join("; ");
    return row;
  });
}

function parseTiers(text: Record<string, unknown>, where: string): Tier[] {
  if (!isRecord(text.input)) {
    throw new Error(`${FN}: ${where} cost.text.input is missing`);
  }
  if (!isRecord(text.output)) {
    throw new Error(`${FN}: ${where} cost.text.output is missing`);
  }
  assertOnlyKeys(text.input, ["price", "cache", "overrides"], `${where} cost.text.input`);
  assertOnlyKeys(text.output, ["price", "overrides"], `${where} cost.text.output`);

  const baseInput = expectPrice(text.input.price, `${where} cost.text.input.price`);
  const baseOutput = expectPrice(text.output.price, `${where} cost.text.output.price`);
  const baseCache = parseCache(text.input.cache, `${where} cost.text.input.cache`);

  const inputOverrides = parseOverrides(text.input.overrides, `${where} input`, true);
  const outputOverrides = parseOverrides(text.output.overrides, `${where} output`, false);
  if (inputOverrides.length === 0 && outputOverrides.length === 0) {
    return [{ suffix: "", priceInput: baseInput, priceOutput: baseOutput, cache: baseCache }];
  }

  const thresholds = inputOverrides.map((override) => override.threshold);
  const outputThresholds = outputOverrides.map((override) => override.threshold);
  if (
    thresholds.length !== outputThresholds.length ||
    thresholds.some((threshold) => !outputThresholds.includes(threshold))
  ) {
    throw new Error(
      `${FN}: ${where} input and output context tiers do not match -- page structure may have changed`,
    );
  }
  if (new Set(thresholds).size !== thresholds.length) {
    throw new Error(`${FN}: ${where} has duplicate context tiers`);
  }

  const sorted = [...thresholds].sort((a, b) => a - b);
  const tiers: Tier[] = [
    {
      suffix: ` (≤ ${formatTokens(sorted[0]!)} tokens)`,
      priceInput: baseInput,
      priceOutput: baseOutput,
      cache: baseCache,
    },
  ];
  for (let i = 0; i < sorted.length; i++) {
    const threshold = sorted[i]!;
    const input = inputOverrides.find((override) => override.threshold === threshold);
    const output = outputOverrides.find((override) => override.threshold === threshold);
    if (!input || !output) {
      throw new Error(`${FN}: ${where} context tier ${threshold} is missing a price`);
    }
    const next = sorted[i + 1];
    const above = `> ${formatTokens(threshold)}`;
    const suffix =
      next === undefined ? ` (${above} tokens)` : ` (${above} and ≤ ${formatTokens(next)} tokens)`;
    tiers.push({
      suffix,
      priceInput: input.price,
      priceOutput: output.price,
      cache: input.cache ?? { read: null, write: null, notes: [] },
    });
  }
  return tiers;
}

type Override = {
  threshold: number;
  price: number;
  cache: CachePrices | null;
};

function parseOverrides(value: unknown, where: string, withCache: boolean): Override[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${FN}: ${where} overrides is not an array`);
  }
  return value.map((item, index) => {
    const at = `${where} overrides[${index}]`;
    if (!isRecord(item)) throw new Error(`${FN}: ${at} is not an object`);
    assertOnlyKeys(item, withCache ? ["when", "price", "cache"] : ["when", "price"], at);
    return {
      threshold: readContextGt(item.when, at),
      price: expectPrice(item.price, `${at}.price`),
      cache: withCache ? parseCache(item.cache, `${at}.cache`) : null,
    };
  });
}

function readContextGt(when: unknown, where: string): number {
  if (!isRecord(when)) throw new Error(`${FN}: ${where}.when is not an object`);
  assertOnlyKeys(when, ["context"], `${where}.when`);
  if (!isRecord(when.context)) throw new Error(`${FN}: ${where}.when.context is not an object`);
  assertOnlyKeys(when.context, ["gt"], `${where}.when.context`);
  const threshold = when.context.gt;
  if (typeof threshold !== "number" || !Number.isInteger(threshold) || threshold < 0) {
    throw new Error(`${FN}: ${where}.when.context.gt is not a non-negative integer`);
  }
  return threshold;
}

function parseCache(value: unknown, where: string): CachePrices {
  if (value === undefined) return { read: null, write: null, notes: [] };
  if (!isRecord(value)) throw new Error(`${FN}: ${where} is not an object`);
  assertOnlyKeys(value, ["read", "write"], where);
  const read = value.read === undefined ? null : expectPrice(value.read, `${where}.read`);
  const write = parseCacheWrite(value.write, where);
  return { read, write: write.price, notes: write.notes };
}

function parseCacheWrite(value: unknown, where: string): { price: number | null; notes: string[] } {
  if (value === undefined) return { price: null, notes: [] };
  if (typeof value === "number") {
    return { price: expectPrice(value, `${where}.write`), notes: [] };
  }
  if (!isRecord(value)) {
    throw new Error(`${FN}: ${where}.write is not a number or duration map`);
  }
  const entries = Object.entries(value).map(([label, price]) => {
    const minutes = parseDuration(label);
    if (minutes === null) {
      throw new Error(`${FN}: ${where}.write duration "${label}" is not understood`);
    }
    return { label, minutes, price: expectPrice(price, `${where}.write.${label}`) };
  });
  if (entries.length === 0) {
    throw new Error(`${FN}: ${where}.write has no durations`);
  }
  entries.sort((a, b) => a.minutes - b.minutes);
  const listed = entries.map((entry) => `${entry.label} $${formatUsd(entry.price)}`).join(", ");
  return {
    price: entries[0]!.price,
    notes: [`Cache write by TTL: ${listed} (priceCachedWrite is the shortest TTL)`],
  };
}

function parseDuration(label: string): number | null {
  const match = /^(\d+)(m|h)$/.exec(label);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2] === "h" ? amount * 60 : amount;
}

function parseMultiplierNotes(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${FN}: ${where} cost.multipliers is not an array`);
  }
  return value.map((item, index) => {
    const at = `${where} cost.multipliers[${index}]`;
    if (!isRecord(item)) throw new Error(`${FN}: ${at} is not an object`);
    assertOnlyKeys(item, ["when", "factor"], at);
    const factor = describeFactor(item.factor, `${at}.factor`);
    if (!isRecord(item.when)) throw new Error(`${FN}: ${at}.when is not an object`);
    assertOnlyKeys(item.when, ["date", "service_tier"], `${at}.when`);
    if (item.when.date === undefined && item.when.service_tier === undefined) {
      throw new Error(`${FN}: ${at}.when has no conditions`);
    }
    const date = item.when.date === undefined ? null : describeDate(item.when.date, `${at}.when`);
    if (item.when.service_tier === undefined) {
      return `Prices are ${factor} from ${date!}`;
    }
    const tier = readServiceTier(item.when.service_tier, `${at}.when`);
    return `"${tier}" service tier: ${factor}${date === null ? "" : ` ${date}`}`;
  });
}

// A factor is either a plain multiplier for all prices, or a map from
// modality (e.g. "text") to that modality's multiplier.
function describeFactor(value: unknown, where: string): string {
  if (typeof value === "number") return `${formatUsd(expectFactor(value, where))}x`;
  if (!isRecord(value)) throw new Error(`${FN}: ${where} is not a number or modality map`);
  assertOnlyKeys(value, ["text", "audio"], where);
  const entries = Object.entries(value);
  if (entries.length === 0) throw new Error(`${FN}: ${where} has no modalities`);
  return entries
    .map(([modality, f]) => `${formatUsd(expectFactor(f, `${where}.${modality}`))}x ${modality}`)
    .join(", ");
}

function expectFactor(value: unknown, where: string): number {
  const factor = expectPrice(value, where);
  if (factor <= 0) throw new Error(`${FN}: ${where} must be positive`);
  return factor;
}

function describeDate(value: unknown, where: string): string {
  if (!isRecord(value)) throw new Error(`${FN}: ${where}.date is not an object`);
  assertOnlyKeys(value, ["gte", "lt"], `${where}.date`);
  const bounds: string[] = [];
  if (value.gte !== undefined) bounds.push(`from ${readDate(value.gte, `${where}.date.gte`)}`);
  if (value.lt !== undefined) bounds.push(`before ${readDate(value.lt, `${where}.date.lt`)}`);
  if (bounds.length === 0) throw new Error(`${FN}: ${where}.date has no bounds`);
  return bounds.join(" and ");
}

function readDate(value: unknown, where: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${FN}: ${where} is not a YYYY-MM-DD date`);
  }
  return value;
}

function readServiceTier(value: unknown, where: string): string {
  if (!isRecord(value)) throw new Error(`${FN}: ${where}.service_tier is not an object`);
  assertOnlyKeys(value, ["equals"], `${where}.service_tier`);
  return expectString(value, "equals", `${where}.service_tier.equals`);
}

function parseAudioNotes(value: unknown, where: string): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) throw new Error(`${FN}: ${where} cost.audio is not an object`);
  assertOnlyKeys(value, ["input"], `${where} cost.audio`);
  if (!isRecord(value.input)) throw new Error(`${FN}: ${where} cost.audio.input is not an object`);
  assertOnlyKeys(value.input, ["price", "cache"], `${where} cost.audio.input`);
  const price = expectPrice(value.input.price, `${where} cost.audio.input.price`);
  const cache = parseCache(value.input.cache, `${where} cost.audio.input.cache`);
  const cached = [
    ...(cache.read === null ? [] : [`cached read $${formatUsd(cache.read)}`]),
    ...(cache.write === null ? [] : [`cached write $${formatUsd(cache.write)}`]),
  ];
  const suffix = cached.length > 0 ? ` (${cached.join(", ")})` : "";
  return [`Audio input $${formatUsd(price)} per 1M tokens${suffix}`, ...cache.notes];
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
}

function formatUsd(price: number): string {
  return String(price);
}

function expectString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${FN}: ${where} is missing or not a non-empty string`);
  }
  return value;
}

function expectPrice(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${FN}: ${where} is missing or not a non-negative finite number`);
  }
  return value;
}

function assertOnlyKeys(record: Record<string, unknown>, allowed: string[], where: string): void {
  const extra = Object.keys(record).filter((key) => !allowed.includes(key));
  if (extra.length > 0) {
    throw new Error(`${FN}: ${where} has unexpected fields: ${extra.join(", ")}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

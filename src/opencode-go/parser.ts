export type OpenCodeGoModelRow = {
  model: string;
  modelId: string;
  priceInput: number;
  priceOutput: number;
  priceCachedRead: number | null;
  priceCachedWrite: number | null;
  // Go-plan monthly usage cap (USD). Null when the plan lists no cap.
  monthlyLimitUsd: number | null;
  monthlyLimitGoPlusUsd: number | null;
  monthlyLimitGoTeamsUsd: number | null;
  training: boolean | null;
  zdr: boolean | null;
  limitedRegions: boolean | null;
  endpoint: string | null;
  aiSdkPackage: string | null;
  notes?: string;
};

const FN = "parseOpenCodeGoPricingHtml";

const API_KINDS = ["chat-completions", "responses", "messages", "generate-content"] as const;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri"];

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

type Multiplier = {
  factor: number;
  whenText: string;
};

export function parseOpenCodeGoPricingHtml(text: string): OpenCodeGoModelRow[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${FN}: invalid JSON (${detail})`);
  }

  if (!isRecord(parsed) || parsed.object !== "list" || !Array.isArray(parsed.data)) {
    throw new Error(
      `${FN}: pricing table not found -- expected {object:'list', data:[...]} -- page structure may have changed`,
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

function parseEntry(entry: unknown, index: number): OpenCodeGoModelRow[] {
  if (!isRecord(entry)) {
    throw new Error(`${FN}: data[${index}] is not an object`);
  }
  const modelId = expectString(entry, "id", `data[${index}].id`);
  const name = expectString(entry, "name", `${modelId}.name`);
  const where = `"${name}" (${modelId})`;

  if (!isRecord(entry.cost)) {
    throw new Error(`${FN}: ${where} is missing cost -- pricing table may have changed`);
  }
  assertOnlyKeys(entry.cost, ["text", "multipliers", "audio"], `${where} cost`);
  if (!isRecord(entry.cost.text)) {
    throw new Error(`${FN}: ${where} is missing cost.text -- pricing table may have changed`);
  }
  assertOnlyKeys(entry.cost.text, ["input", "output"], `${where} cost.text`);

  const tiers = parseTiers(entry.cost.text, where);
  const multipliers = parseMultipliers(entry.cost.multipliers, where);
  const audioNote = parseAudioNote(entry.cost.audio, where);
  const go = parseGo(entry.go, where);
  const api = parseApi(entry.api, modelId, where);

  const slices = expandVariants(name, tiers, multipliers);
  return slices.map((slice) => {
    const notes = [...slice.notes, ...(audioNote ? [audioNote] : []), ...go.notes];
    const row: OpenCodeGoModelRow = {
      model: slice.model,
      modelId,
      priceInput: slice.priceInput,
      priceOutput: slice.priceOutput,
      priceCachedRead: slice.priceCachedRead,
      priceCachedWrite: slice.priceCachedWrite,
      monthlyLimitUsd: go.monthlyLimitUsd,
      monthlyLimitGoPlusUsd: go.monthlyLimitGoPlusUsd,
      monthlyLimitGoTeamsUsd: go.monthlyLimitGoTeamsUsd,
      training: go.training,
      zdr: go.zdr,
      limitedRegions: go.limitedRegions,
      endpoint: api.endpoint,
      aiSdkPackage: api.aiSdkPackage,
    };
    if (notes.length > 0) row.notes = notes.join("; ");
    return row;
  });
}

function expandVariants(
  name: string,
  tiers: Tier[],
  multipliers: Multiplier[],
): Array<{
  model: string;
  priceInput: number;
  priceOutput: number;
  priceCachedRead: number | null;
  priceCachedWrite: number | null;
  notes: string[];
}> {
  const peakSummary = multipliers.map((m) => `${m.factor}x ${m.whenText}`).join("; ");
  const rows = [];
  for (const tier of tiers) {
    if (multipliers.length === 0) {
      rows.push({
        model: `${name}${tier.suffix}`,
        priceInput: tier.priceInput,
        priceOutput: tier.priceOutput,
        priceCachedRead: tier.cache.read,
        priceCachedWrite: tier.cache.write,
        notes: [...tier.cache.notes],
      });
      continue;
    }

    rows.push({
      model: `${name}${tier.suffix} (Off-peak)`,
      priceInput: tier.priceInput,
      priceOutput: tier.priceOutput,
      priceCachedRead: tier.cache.read,
      priceCachedWrite: tier.cache.write,
      notes: [...tier.cache.notes, `Off-peak; peak is ${peakSummary}`],
    });
    multipliers.forEach((multiplier, i) => {
      const peakLabel = multipliers.length === 1 ? " (Peak)" : ` (Peak ${i + 1})`;
      rows.push({
        model: `${name}${tier.suffix}${peakLabel}`,
        priceInput: scale(tier.priceInput, multiplier.factor),
        priceOutput: scale(tier.priceOutput, multiplier.factor),
        priceCachedRead: scaleNullable(tier.cache.read, multiplier.factor),
        priceCachedWrite: scaleNullable(tier.cache.write, multiplier.factor),
        notes: [
          ...scaleNotes(tier.cache.notes, multiplier.factor),
          `Peak ${multiplier.factor}x ${multiplier.whenText}`,
        ],
      });
    });
  }
  return rows;
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

  const baseInput = expectFinite(text.input.price, `${where} cost.text.input.price`);
  const baseOutput = expectFinite(text.output.price, `${where} cost.text.output.price`);
  const baseCache = parseCache(text.input.cache, `${where} cost.text.input.cache`, true);

  const inputOverrides = parseOverrides(text.input.overrides, `${where} input`, true);
  const outputOverrides = parseOverrides(text.output.overrides, `${where} output`, false);
  if (inputOverrides.length === 0 && outputOverrides.length === 0) {
    return [{ suffix: "", priceInput: baseInput, priceOutput: baseOutput, cache: baseCache }];
  }

  const thresholds = inputOverrides.map((override) => override.threshold);
  if (
    thresholds.length !== outputOverrides.length ||
    thresholds.some((threshold, i) => outputOverrides[i]?.threshold !== threshold)
  ) {
    throw new Error(
      `${FN}: ${where} input and output context tiers do not match -- page structure may have changed`,
    );
  }
  const unique = new Set(thresholds);
  if (unique.size !== thresholds.length) {
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
      cache: input.cache ?? baseCache,
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
    const threshold = readContextGt(item.when, at);
    const price = expectFinite(item.price, `${at}.price`);
    const cache = withCache ? parseCache(item.cache, `${at}.cache`, false) : null;
    return { threshold, price, cache };
  });
}

function readContextGt(when: unknown, where: string): number {
  if (!isRecord(when)) throw new Error(`${FN}: ${where}.when is not an object`);
  assertOnlyKeys(when, ["context"], `${where}.when`);
  if (!isRecord(when.context)) throw new Error(`${FN}: ${where}.when.context is not an object`);
  assertOnlyKeys(when.context, ["gt"], `${where}.when.context`);
  const threshold = expectFinite(when.context.gt, `${where}.when.context.gt`);
  if (!Number.isInteger(threshold) || threshold < 0) {
    throw new Error(`${FN}: ${where}.when.context.gt is not a non-negative integer`);
  }
  return threshold;
}

function parseCache(value: unknown, where: string, absentOk: boolean): CachePrices {
  if (value === undefined) {
    if (absentOk) return { read: null, write: null, notes: [] };
    throw new Error(`${FN}: ${where} is missing`);
  }
  if (!isRecord(value)) throw new Error(`${FN}: ${where} is not an object`);
  assertOnlyKeys(value, ["read", "write"], where);
  const read = value.read === undefined ? null : expectFinite(value.read, `${where}.read`);
  const write = parseCacheWrite(value.write, where);
  return { read, write: write.price, notes: write.notes };
}

function parseCacheWrite(value: unknown, where: string): { price: number | null; notes: string[] } {
  if (value === undefined) return { price: null, notes: [] };
  if (typeof value === "number") {
    return { price: expectFinite(value, `${where}.write`), notes: [] };
  }
  if (!isRecord(value)) {
    throw new Error(`${FN}: ${where}.write is not a number or duration map`);
  }
  const entries = Object.entries(value).map(([label, price]) => {
    const minutes = parseDuration(label);
    if (minutes === null) {
      throw new Error(`${FN}: ${where}.write duration "${label}" is not understood`);
    }
    return { label, minutes, price: expectFinite(price, `${where}.write.${label}`) };
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
  const match = /^(\d+(?:\.\d+)?)(m|h)$/.exec(label);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return null;
  return match[2] === "h" ? amount * 60 : amount;
}

function parseMultipliers(value: unknown, where: string): Multiplier[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error(`${FN}: ${where} cost.multipliers is not an array`);
  }
  return value.map((item, index) => {
    const at = `${where} cost.multipliers[${index}]`;
    if (!isRecord(item)) throw new Error(`${FN}: ${at} is not an object`);
    assertOnlyKeys(item, ["when", "factor"], at);
    const factor = expectFinite(item.factor, `${at}.factor`);
    if (factor <= 0) throw new Error(`${FN}: ${at}.factor must be positive`);
    return { factor, whenText: describeMultiplierWhen(item.when, at) };
  });
}

function describeMultiplierWhen(when: unknown, where: string): string {
  if (!isRecord(when)) throw new Error(`${FN}: ${where}.when is not an object`);
  const keys = Object.keys(when).sort();
  if (keys.length === 1 && keys[0] === "date") {
    return `from ${readDateGte(when.date, where)}`;
  }
  if (keys.length === 2 && keys[0] === "any" && keys[1] === "utc_days") {
    return `${describeDays(when.utc_days, where)} ${describeWindows(when.any, where)}`;
  }
  throw new Error(
    `${FN}: ${where}.when is not a known peak schedule (${JSON.stringify(when)}) -- page structure may have changed`,
  );
}

function readDateGte(value: unknown, where: string): string {
  if (!isRecord(value)) throw new Error(`${FN}: ${where}.when.date is not an object`);
  assertOnlyKeys(value, ["gte"], `${where}.when.date`);
  return expectString(value, "gte", `${where}.when.date.gte`);
}

function describeDays(value: unknown, where: string): string {
  if (!isRecord(value)) throw new Error(`${FN}: ${where}.when.utc_days is not an object`);
  assertOnlyKeys(value, ["in"], `${where}.when.utc_days`);
  if (!Array.isArray(value.in) || value.in.some((day) => typeof day !== "string")) {
    throw new Error(`${FN}: ${where}.when.utc_days.in is not a string array`);
  }
  const days = value.in;
  if (days.length === WEEKDAYS.length && WEEKDAYS.every((day, i) => days[i] === day)) {
    return "weekdays";
  }
  return days.join("/");
}

function describeWindows(value: unknown, where: string): string {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${FN}: ${where}.when.any is not a non-empty array`);
  }
  const windows = value.map((item, index) => {
    const at = `${where}.when.any[${index}]`;
    if (!isRecord(item)) throw new Error(`${FN}: ${at} is not an object`);
    assertOnlyKeys(item, ["all"], at);
    if (!Array.isArray(item.all) || item.all.length !== 2) {
      throw new Error(`${FN}: ${at}.all is not a two-bound hour window`);
    }
    const gte = readHour(item.all[0], "gte", at);
    const lt = readHour(item.all[1], "lt", at);
    return `${gte}-${lt}`;
  });
  return `${windows.join(" and ")} UTC`;
}

function readHour(value: unknown, bound: "gte" | "lt", where: string): string {
  if (!isRecord(value)) throw new Error(`${FN}: ${where} hour bound is not an object`);
  assertOnlyKeys(value, ["utc_hours"], `${where} hour bound`);
  if (!isRecord(value.utc_hours)) throw new Error(`${FN}: ${where}.utc_hours is not an object`);
  assertOnlyKeys(value.utc_hours, [bound], `${where}.utc_hours`);
  const hour = value.utc_hours[bound];
  if (typeof hour !== "string" || !/^\d{2}:\d{2}$/.test(hour)) {
    throw new Error(`${FN}: ${where}.utc_hours.${bound} is not HH:MM`);
  }
  return hour;
}

function parseAudioNote(value: unknown, where: string): string | null {
  if (value === undefined) return null;
  if (!isRecord(value)) throw new Error(`${FN}: ${where} cost.audio is not an object`);
  assertOnlyKeys(value, ["input"], `${where} cost.audio`);
  if (!isRecord(value.input)) throw new Error(`${FN}: ${where} cost.audio.input is not an object`);
  assertOnlyKeys(value.input, ["price"], `${where} cost.audio.input`);
  const price = expectFinite(value.input.price, `${where} cost.audio.input.price`);
  return `Audio input $${formatUsd(price)}/1M tokens`;
}

type GoFields = {
  monthlyLimitUsd: number | null;
  monthlyLimitGoPlusUsd: number | null;
  monthlyLimitGoTeamsUsd: number | null;
  training: boolean | null;
  zdr: boolean | null;
  limitedRegions: boolean | null;
  notes: string[];
};

function parseGo(value: unknown, where: string): GoFields {
  const empty: GoFields = {
    monthlyLimitUsd: null,
    monthlyLimitGoPlusUsd: null,
    monthlyLimitGoTeamsUsd: null,
    training: null,
    zdr: null,
    limitedRegions: null,
    notes: [],
  };
  if (value === undefined) return empty;
  if (!isRecord(value)) throw new Error(`${FN}: ${where} go is not an object`);

  const known = ["monthly_usage", "training", "zdr", "limited_regions"];
  const extra = Object.keys(value).filter((key) => !known.includes(key));
  const notes =
    extra.length > 0
      ? [
          `Additional go fields: ${extra.map((key) => `${key}=${JSON.stringify(value[key])}`).join(", ")}`,
        ]
      : [];

  let monthlyLimitUsd: number | null = null;
  let monthlyLimitGoPlusUsd: number | null = null;
  let monthlyLimitGoTeamsUsd: number | null = null;
  if (value.monthly_usage != null) {
    if (!isRecord(value.monthly_usage)) {
      throw new Error(`${FN}: ${where} go.monthly_usage is not an object`);
    }
    const usage = value.monthly_usage;
    monthlyLimitUsd = readOptionalLimit(usage, "go", where);
    monthlyLimitGoPlusUsd = readOptionalLimit(usage, "go-plus", where);
    monthlyLimitGoTeamsUsd = readOptionalLimit(usage, "go-teams", where);
    const extraLimits = Object.keys(usage).filter(
      (key) => key !== "go" && key !== "go-plus" && key !== "go-teams",
    );
    if (extraLimits.length > 0) {
      const listed = extraLimits
        .map(
          (key) =>
            `${key} $${formatUsd(expectFinite(usage[key], `${where} go.monthly_usage.${key}`))}`,
        )
        .join(", ");
      notes.push(`Other monthly limits: ${listed}`);
    }
  }

  return {
    monthlyLimitUsd,
    monthlyLimitGoPlusUsd,
    monthlyLimitGoTeamsUsd,
    training: readOptionalBoolean(value, "training", where),
    zdr: readOptionalBoolean(value, "zdr", where),
    limitedRegions: readOptionalBoolean(value, "limited_regions", where),
    notes,
  };
}

function readOptionalLimit(
  usage: Record<string, unknown>,
  key: string,
  where: string,
): number | null {
  if (!(key in usage) || usage[key] == null) return null;
  return expectFinite(usage[key], `${where} go.monthly_usage.${key}`);
}

function readOptionalBoolean(
  record: Record<string, unknown>,
  key: string,
  where: string,
): boolean | null {
  if (!(key in record) || record[key] == null) return null;
  if (typeof record[key] !== "boolean") {
    throw new Error(`${FN}: ${where} go.${key} is not a boolean`);
  }
  return record[key];
}

function parseApi(
  value: unknown,
  modelId: string,
  where: string,
): { endpoint: string | null; aiSdkPackage: string | null } {
  if (value === undefined) return { endpoint: null, aiSdkPackage: null };
  if (!isRecord(value)) throw new Error(`${FN}: ${where} api is not an object`);
  const present = API_KINDS.filter((kind) => value[kind] != null);
  const unknown = Object.keys(value).filter(
    (key) => !API_KINDS.includes(key as (typeof API_KINDS)[number]),
  );
  if (unknown.length > 0) {
    throw new Error(`${FN}: ${where} has unknown API blocks: ${unknown.join(", ")}`);
  }
  if (present.length === 0) return { endpoint: null, aiSdkPackage: null };
  if (present.length > 1) {
    throw new Error(`${FN}: ${where} has multiple API blocks: ${present.join(", ")}`);
  }
  const kind = present[0]!;
  const block = value[kind];
  if (!isRecord(block)) throw new Error(`${FN}: ${where} api.${kind} is not an object`);
  const baseUrl = expectString(block, "base_url", `${where} api.${kind}.base_url`).replace(
    /\/$/,
    "",
  );
  let aiSdkPackage: string | null = null;
  if (block.sdk != null) {
    if (!isRecord(block.sdk)) throw new Error(`${FN}: ${where} api.${kind}.sdk is not an object`);
    if (block.sdk.aisdk != null) {
      aiSdkPackage = expectString(block.sdk, "aisdk", `${where} api.${kind}.sdk.aisdk`);
    }
  }
  return { endpoint: endpointFor(kind, baseUrl, modelId), aiSdkPackage };
}

function endpointFor(kind: (typeof API_KINDS)[number], baseUrl: string, modelId: string): string {
  switch (kind) {
    case "chat-completions":
      return `${baseUrl}/chat/completions`;
    case "responses":
      return `${baseUrl}/responses`;
    case "messages":
      return `${baseUrl}/messages`;
    case "generate-content":
      return `${baseUrl}/models/${modelId}`;
  }
}

function scale(price: number, factor: number): number {
  return Math.round(price * factor * 1e12) / 1e12;
}

function scaleNullable(price: number | null, factor: number): number | null {
  return price === null ? null : scale(price, factor);
}

function scaleNotes(notes: string[], factor: number): string[] {
  if (factor === 1) return notes;
  return notes.map((note) =>
    note.replace(/\$(\d+(?:\.\d+)?)/g, (_match, amount: string) => {
      return `$${formatUsd(scale(Number(amount), factor))}`;
    }),
  );
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000 && tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`;
  if (tokens >= 1_000 && tokens % 1_000 === 0) return `${tokens / 1_000}K`;
  return String(tokens);
}

function formatUsd(price: number): string {
  return String(Math.round(price * 1e12) / 1e12);
}

function expectString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${FN}: ${where} is missing or not a string`);
  }
  return value;
}

function expectFinite(value: unknown, where: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${FN}: ${where} is missing or not a finite number`);
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

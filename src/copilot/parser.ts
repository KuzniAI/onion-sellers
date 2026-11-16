import { parse } from "yaml";

export type CopilotModelRow = {
  creator: string;
  model: string;
  releaseStatus: string;
  category: string;
  tier: string | null;
  thresholdInputTokens: number | null;
  price1mInput: number;
  price1mCachedInput: number;
  price1mCacheWrite: number | null;
  price1mOutput: number;
};

const FN = "parseCopilotPricingHtml";
const NOT_APPLICABLE = "Not applicable";

// YAML provider slug -> display creator name.
const CREATOR_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  xai: "xAI",
  microsoft: "Microsoft",
  moonshot_ai: "Moonshot AI",
  "moonshot-ai": "Moonshot AI",
  github: "GitHub",
  "fine-tuned-github": "GitHub (Fine-tuned)",
};

export function parseCopilotPricingHtml(text: string): CopilotModelRow[] {
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`${FN}: YAML could not be parsed: ${message}`);
  }

  if (!Array.isArray(parsed)) {
    const kind = parsed === null || parsed === undefined ? "empty document" : typeof parsed;
    throw new Error(`${FN}: expected a YAML list of model rows, got ${kind}`);
  }
  if (parsed.length === 0) {
    throw new Error(`${FN}: no model rows found -- page structure may have changed`);
  }

  return parsed.map((item, index) => parseItem(item, index));
}

function parseItem(item: unknown, index: number): CopilotModelRow {
  if (!isRecord(item)) {
    throw new Error(`${FN}: item ${index + 1} is not a mapping`);
  }

  const modelRaw = requireString(item, "model", index);
  const model = stripFootnotes(modelRaw);
  if (model === "") {
    throw new Error(`${FN}: item ${index + 1} has an empty model name`);
  }

  const provider = requireString(item, "provider", index);
  const creator = CREATOR_NAMES[provider];
  if (!creator) {
    throw new Error(
      `${FN}: item ${index + 1} (${model}) has unknown provider ${JSON.stringify(provider)}`,
    );
  }

  return {
    creator,
    model,
    releaseStatus: requireString(item, "release_status", index),
    category: requireString(item, "category", index),
    tier: optionalText(item, "tier", model, index),
    thresholdInputTokens: parseThreshold(
      optionalText(item, "threshold", model, index),
      model,
      index,
    ),
    price1mInput: parseRequiredPrice(item, "input", model, index),
    price1mCachedInput: parseRequiredPrice(item, "cached_input", model, index),
    price1mCacheWrite: parseOptionalPrice(item, "cache_write", model, index),
    price1mOutput: parseRequiredPrice(item, "output", model, index),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(item: Record<string, unknown>, field: string, index: number): string {
  const value = item[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${FN}: item ${index + 1} is missing a ${field} string`);
  }
  return value.trim();
}

function optionalText(
  item: Record<string, unknown>,
  field: string,
  model: string,
  index: number,
): string | null {
  if (!Object.hasOwn(item, field) || item[field] === undefined) return null;
  const value = item[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `${FN}: item ${index + 1} (${model}) ${field} is not text (${JSON.stringify(value)})`,
    );
  }
  return value.trim();
}

function parseThreshold(text: string | null, model: string, index: number): number | null {
  if (text === null || text === NOT_APPLICABLE) return null;
  const match = /^(?:≤|>)\s*(\d+)K$/.exec(text);
  if (!match) {
    throw new Error(
      `${FN}: item ${index + 1} (${model}) threshold is not an input-token threshold (${JSON.stringify(text)})`,
    );
  }
  return Number(match[1]) * 1000;
}

function parseRequiredPrice(
  item: Record<string, unknown>,
  field: string,
  model: string,
  index: number,
): number {
  if (!Object.hasOwn(item, field) || item[field] === undefined) {
    throw new Error(`${FN}: item ${index + 1} (${model}) is missing ${field}`);
  }
  const value = item[field];
  if (typeof value !== "string") {
    throw new Error(
      `${FN}: item ${index + 1} (${model}) ${field} is not a USD price (${JSON.stringify(value)})`,
    );
  }
  return parsePrice(value.trim(), field, model, index);
}

function parseOptionalPrice(
  item: Record<string, unknown>,
  field: string,
  model: string,
  index: number,
): number | null {
  if (!Object.hasOwn(item, field) || item[field] === undefined) return null;
  const value = item[field];
  if (typeof value !== "string") {
    throw new Error(
      `${FN}: item ${index + 1} (${model}) ${field} is not a USD price (${JSON.stringify(value)})`,
    );
  }
  const text = value.trim();
  if (text === NOT_APPLICABLE) return null;
  return parsePrice(text, field, model, index);
}

function parsePrice(text: string, field: string, model: string, index: number): number {
  const match = /^\$(\d+(?:\.\d+)?)$/.exec(text);
  if (!match) {
    throw new Error(
      `${FN}: item ${index + 1} (${model}) ${field} is not a USD per 1M tokens price (${JSON.stringify(text)})`,
    );
  }
  const value = Number(match[1]);
  if (!Number.isFinite(value)) {
    throw new Error(`${FN}: item ${index + 1} (${model}) ${field} is not a finite number`);
  }
  return value;
}

// Footnote markers (e.g. "Gemini 3.8 Flash[^gemini-flash-promo]") are not part of the shown name.
function stripFootnotes(name: string): string {
  return name.replace(/\[\^[^\]]+\]/g, "").trim();
}

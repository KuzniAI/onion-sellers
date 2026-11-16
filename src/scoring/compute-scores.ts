// Combines local provider pricing + Artificial Analysis benchmark data into
// per-category recommendations.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { pricingSources } from "../pricing/sources.ts";

// A PricingSource id, e.g. "copilot".
export type Provider = string;

interface Candidate {
  provider: Provider;
  model: string;
  priceInput: number;
  priceOutput: number;
}

export interface MappingEntry {
  provider: Provider;
  providerModel: string;
  aaSlug: string | null;
  note?: string;
}

// Free-tier row from /language/models/free. Since Intelligence Index v5 Artificial
// Analysis no longer publishes a Coding or Agentic Index (those fields are always null),
// so they're not read here.
export interface AaModel {
  id: string;
  name: string;
  slug: string;
  evaluations: {
    artificial_analysis_intelligence_index?: number | null;
  };
  // What one Intelligence Index task cost to run at AA's prices; it reflects how many
  // tokens the model actually spends, not just its per-token price.
  artificial_analysis_intelligence_index_cost?: {
    cost_per_task?: { total_cost?: number | null } | null;
  } | null;
  pricing?: {
    price_1m_input_tokens?: number | null;
    price_1m_output_tokens?: number | null;
  } | null;
  performance?: {
    median_output_tokens_per_second?: number | null;
  } | null;
  performance_v3?: {
    mean_output_tokens_per_second?: number | null;
  } | null;
}

type Metric = "intelligenceIndex" | "costEfficiency" | "speed";

const METRICS: Metric[] = ["intelligenceIndex", "costEfficiency", "speed"];

type CategoryWeights = Partial<Record<Metric, number>>;

interface CategoryConfig {
  description?: string;
  outputToInputRatio?: number;
  weights: CategoryWeights;
}

interface CategoriesConfig {
  topNPerProvider: number;
  expectedIntelligenceIndexVersion: number;
  categories: Record<string, CategoryConfig>;
}

interface BlacklistEntry {
  match: string;
  reason: string;
}

interface ScoredCandidate {
  provider: Provider;
  model: string;
  aaSlug: string;
  score: number;
  breakdown: {
    intelligenceIndex: number;
    speed: number;
    // Estimated USD for one Intelligence Index task at this provider's prices.
    costPerTask: number;
  };
  priceBlendedPer1M: number;
}

// Default output tokens per 1 input token (typical agentic coding workload). A category can
// override it with outputToInputRatio in config/categories.json.
const DEFAULT_OUTPUT_TO_INPUT_RATIO = 3;

function blendedPrice(
  priceInput: number,
  priceOutput: number,
  outputToInputRatio: number = DEFAULT_OUTPUT_TO_INPUT_RATIO,
): number {
  const totalParts = 1 + outputToInputRatio;
  return (priceInput * 1 + priceOutput * outputToInputRatio) / totalParts;
}

// Strips variant qualifiers like " (<= 256K tokens)", " (Off-Peak)", " (Peak)" so
// tiered/peak pricing rows collapse to one representative candidate per base model.
export function baseModelName(model: string): string {
  let stripped = model;
  while (/\s*\([^)]*\)\s*$/.test(stripped)) {
    stripped = stripped.replace(/\s*\([^)]*\)\s*$/, "").trim();
  }
  return stripped;
}

function dedupeCheapest(
  rows: { model: string; priceInput: number; priceOutput: number }[],
): { model: string; priceInput: number; priceOutput: number }[] {
  const byBase = new Map<string, { model: string; priceInput: number; priceOutput: number }>();
  for (const row of rows) {
    const base = baseModelName(row.model);
    const existing = byBase.get(base);
    if (
      !existing ||
      blendedPrice(row.priceInput, row.priceOutput) <
        blendedPrice(existing.priceInput, existing.priceOutput)
    ) {
      byBase.set(base, { model: base, priceInput: row.priceInput, priceOutput: row.priceOutput });
    }
  }
  return [...byBase.values()];
}

export async function loadCandidates(): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const source of pricingSources) {
    let raw: { models: Record<string, unknown>[] };
    try {
      raw = JSON.parse(await readFile(source.outFile, "utf8"));
    } catch (err) {
      // A provider whose parser has never succeeded has no data yet; score the others.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      console.warn(
        `No ${source.displayName} pricing data at ${source.outFile}; skipping provider.`,
      );
      continue;
    }

    const { input, output } = source.priceFields;
    const rows = dedupeCheapest(
      raw.models.map((m) => ({
        model: m.model as string,
        priceInput: m[input] as number,
        priceOutput: m[output] as number,
      })),
    );
    candidates.push(...rows.map((r) => ({ provider: source.id, ...r })));
  }
  return candidates;
}

function normalize(value: number, min: number, max: number): number {
  if (max === min) return 1;
  return (value - min) / (max - min);
}

// Fails loudly on config that no longer matches the data, instead of publishing
// rankings where a weighted metric silently scores nothing (which happened when AA
// dropped the Coding and Agentic indexes).
function validateConfig(config: CategoriesConfig, aaVersion: unknown): void {
  if (aaVersion !== config.expectedIntelligenceIndexVersion) {
    throw new Error(
      `Artificial Analysis reports Intelligence Index version ${String(aaVersion)}, but config/categories.json expects ${config.expectedIntelligenceIndexVersion}. ` +
        "Check the API docs for changed or removed fields, adjust scoring, then update expectedIntelligenceIndexVersion.",
    );
  }
  for (const [name, category] of Object.entries(config.categories)) {
    const unknown = Object.keys(category.weights).filter((k) => !METRICS.includes(k as Metric));
    if (unknown.length > 0) {
      throw new Error(
        `Category "${name}" weights unknown metrics: ${unknown.join(", ")}. Known metrics: ${METRICS.join(", ")}.`,
      );
    }
  }
}

export async function computeScores(): Promise<void> {
  const config: CategoriesConfig = JSON.parse(
    await readFile(path.join("config", "categories.json"), "utf8"),
  );
  const blacklist: BlacklistEntry[] = JSON.parse(
    await readFile(path.join("config", "blacklist.json"), "utf8"),
  );
  const aaData = JSON.parse(
    await readFile(path.join("data", "artificial-analysis", "language-models.json"), "utf8"),
  );
  validateConfig(config, aaData.intelligenceIndexVersion);

  const allCandidates = await loadCandidates();

  const candidates = allCandidates.filter((c) => {
    const hit = blacklist.find((b) => c.model.toLowerCase().includes(b.match.toLowerCase()));
    if (hit) {
      console.warn(`Blacklisted ${c.provider}/${c.model}: ${hit.reason}`);
      return false;
    }
    return true;
  });

  const mapping: MappingEntry[] = JSON.parse(
    await readFile(path.join("config", "model-mapping.json"), "utf8"),
  );
  const aaBySlug = new Map<string, AaModel>((aaData.models as AaModel[]).map((m) => [m.slug, m]));

  const enriched: {
    provider: Provider;
    model: string;
    aaSlug: string;
    intelligenceIndex: number;
    speed: number;
    aaCostPerTask: number;
    aaPriceInput: number;
    aaPriceOutput: number;
    priceInput: number;
    priceOutput: number;
  }[] = [];

  for (const candidate of candidates) {
    const label = `${candidate.provider}/${candidate.model}`;
    if (blendedPrice(candidate.priceInput, candidate.priceOutput) <= 0) {
      // Cost efficiency is 1 / cost, so free models would be infinitely efficient.
      console.warn(`Skipping ${label}: free model, not scored.`);
      continue;
    }

    const map = mapping.find(
      (m) => m.provider === candidate.provider && m.providerModel === candidate.model,
    );
    if (!map || !map.aaSlug) {
      console.warn(`Skipping ${label}: no Artificial Analysis mapping.`);
      continue;
    }
    const aa = aaBySlug.get(map.aaSlug);
    if (!aa) {
      console.warn(`Skipping ${label}: aaSlug "${map.aaSlug}" not found in fetched data.`);
      continue;
    }

    // Every scored model needs all inputs; nothing is estimated or zero-filled.
    const intelligenceIndex = aa.evaluations.artificial_analysis_intelligence_index ?? null;
    const speed =
      aa.performance?.median_output_tokens_per_second ??
      aa.performance_v3?.mean_output_tokens_per_second ??
      null;
    const aaCostPerTask =
      aa.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost ?? null;
    const aaPriceInput = aa.pricing?.price_1m_input_tokens ?? null;
    const aaPriceOutput = aa.pricing?.price_1m_output_tokens ?? null;
    const missing = [
      intelligenceIndex == null && "intelligence index",
      speed == null && "speed",
      aaCostPerTask == null && "cost per task",
      (aaPriceInput == null ||
        aaPriceOutput == null ||
        blendedPrice(aaPriceInput, aaPriceOutput) <= 0) &&
        "AA pricing",
    ].filter((m): m is string => typeof m === "string");
    if (missing.length > 0) {
      console.warn(`Skipping ${label} ("${map.aaSlug}"): no ${missing.join(", ")}.`);
      continue;
    }

    enriched.push({
      provider: candidate.provider,
      model: candidate.model,
      aaSlug: map.aaSlug,
      intelligenceIndex: intelligenceIndex!,
      speed: speed!,
      aaCostPerTask: aaCostPerTask!,
      aaPriceInput: aaPriceInput!,
      aaPriceOutput: aaPriceOutput!,
      priceInput: candidate.priceInput,
      priceOutput: candidate.priceOutput,
    });
  }

  if (enriched.length === 0) {
    throw new Error(
      "No candidates have complete benchmark data; refusing to publish empty rankings.",
    );
  }

  const categories: Record<string, Record<Provider, ScoredCandidate[]>> = {};

  for (const [categoryName, categoryConfig] of Object.entries(config.categories)) {
    const weights = categoryConfig.weights;
    const ratio = categoryConfig.outputToInputRatio ?? DEFAULT_OUTPUT_TO_INPUT_RATIO;

    const blendedPrices = enriched.map((e) => blendedPrice(e.priceInput, e.priceOutput, ratio));
    // Scale AA's measured cost per task by how this provider's price compares to AA's,
    // so a model that's cheap per token but verbose isn't mistaken for a cheap one.
    const costsPerTask = enriched.map(
      (e, i) =>
        (e.aaCostPerTask * blendedPrices[i]) / blendedPrice(e.aaPriceInput, e.aaPriceOutput, ratio),
    );
    const values: Record<Metric, number[]> = {
      intelligenceIndex: enriched.map((e) => e.intelligenceIndex),
      speed: enriched.map((e) => e.speed),
      costEfficiency: costsPerTask.map((c) => 1 / c),
    };
    const normalized = Object.fromEntries(
      METRICS.map((m) => {
        const min = Math.min(...values[m]);
        const max = Math.max(...values[m]);
        return [m, values[m].map((v) => normalize(v, min, max))];
      }),
    ) as Record<Metric, number[]>;

    const scored: ScoredCandidate[] = enriched.map((e, i) => {
      const score = METRICS.reduce((sum, m) => sum + (weights[m] ?? 0) * normalized[m][i], 0);
      return {
        provider: e.provider,
        model: e.model,
        aaSlug: e.aaSlug,
        score: Math.round(score * 1000) / 1000,
        breakdown: {
          intelligenceIndex: e.intelligenceIndex,
          speed: e.speed,
          costPerTask: Math.round(costsPerTask[i] * 10000) / 10000,
        },
        priceBlendedPer1M: Math.round(blendedPrices[i] * 1000) / 1000,
      };
    });

    scored.sort((a, b) => b.score - a.score);

    categories[categoryName] = Object.fromEntries(
      pricingSources.map((source) => [
        source.id,
        scored.filter((s) => s.provider === source.id).slice(0, config.topNPerProvider),
      ]),
    );
  }

  const outFile = path.join("data", "recommendations.json");
  await mkdir(path.dirname(outFile), { recursive: true });
  await writeFile(
    outFile,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        topNPerProvider: config.topNPerProvider,
        candidatesConsidered: enriched.length,
        intelligenceIndexVersion: aaData.intelligenceIndexVersion,
        categories,
      },
      null,
      2,
    ),
  );

  console.log(
    `Wrote recommendations for ${Object.keys(categories).length} categories (${enriched.length} scored candidates) to ${outFile}`,
  );
}

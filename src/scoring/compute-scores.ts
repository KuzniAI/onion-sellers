// Combines local provider pricing + Artificial Analysis benchmark data into
// per-category recommendations. The formula is documented in config/categories.json.

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
  model_creator?: { id?: string } | null;
  evaluations: {
    artificial_analysis_intelligence_index?: number | null;
    artificial_analysis_engineering_index?: number | null;
    artificial_analysis_finance_and_accounting_index?: number | null;
    artificial_analysis_strategy_and_ops_index?: number | null;
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
  // The older `performance` block returns null from 2026-12-10, so only v3 is read.
  performance_v3?: {
    mean_output_tokens_per_second?: number | null;
    mean_time_to_first_answer_token_seconds?: number | null;
  } | null;
}

// Quality metrics a category can mix, and the AA evaluation field each one reads.
const QUALITY_FIELDS = {
  intelligenceIndex: "artificial_analysis_intelligence_index",
  engineeringIndex: "artificial_analysis_engineering_index",
  financeAndAccountingIndex: "artificial_analysis_finance_and_accounting_index",
  strategyAndOpsIndex: "artificial_analysis_strategy_and_ops_index",
} as const satisfies Record<string, keyof AaModel["evaluations"]>;

type QualityMetric = keyof typeof QUALITY_FIELDS;

const QUALITY_METRICS = Object.keys(QUALITY_FIELDS) as QualityMetric[];

interface CategoryConfig {
  description?: string;
  // Mix of quality metrics in raw index points; weights sum to 1.
  quality: Partial<Record<QualityMetric, number>>;
  // Quality points a model may give up to be half the price / twice as fast.
  pointsPerCostDoubling: number;
  pointsPerTimeDoubling: number;
}

interface CategoriesConfig {
  topNPerProvider: number;
  expectedIntelligenceIndexVersion: number;
  // "Cheap enough" and "fast enough": below these, no further credit is earned.
  costFloorPerTask: number;
  responseTimeFloorSeconds: number;
  categories: Record<string, CategoryConfig>;
}

interface BlacklistEntry {
  match: string;
  reason: string;
}

interface ScoredCandidate {
  provider: Provider;
  model: string;
  // Reasoning effort of the Artificial Analysis variant this row was scored at, e.g.
  // "High"; null when AA lists the model without an effort label.
  effort: string | null;
  aaSlug: string;
  score: number;
  breakdown: Record<QualityMetric, number> & {
    // This category's quality mix, in index points.
    quality: number;
    // Estimated USD for one Intelligence Index task at this provider's prices.
    costPerTask: number;
    // Seconds until a 500-token answer is complete, thinking time included.
    responseTimeSeconds: number;
  };
  priceBlendedPer1M: number;
}

// One Artificial Analysis effort variant of a provider model, with every scoring input.
interface Variant {
  provider: Provider;
  model: string;
  effort: string | null;
  aaSlug: string;
  quality: Record<QualityMetric, number>;
  costPerTask: number;
  responseTimeSeconds: number;
  priceBlendedPer1M: number;
}

// Output tokens per 1 input token used to blend prices (typical agentic coding workload).
const OUTPUT_TO_INPUT_RATIO = 3;

// A model at this cost per task and response time scores exactly its quality.
const REFERENCE_COST_PER_TASK = 1;
const REFERENCE_RESPONSE_TIME_SECONDS = 60;

// Length of the answer that response time is measured for, matching how Artificial
// Analysis defined its end-to-end response time.
const RESPONSE_TOKENS = 500;

// Parenthesized qualifiers AA uses for reasoning-effort variants of one model. Anything
// else in parentheses (e.g. a release date) marks a different model, not a variant.
const EFFORT_LABELS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "reasoning",
  "non-reasoning",
]);

function blendedPrice(priceInput: number, priceOutput: number): number {
  return (priceInput + priceOutput * OUTPUT_TO_INPUT_RATIO) / (1 + OUTPUT_TO_INPUT_RATIO);
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

// "Claude Opus 5.5 (Max, Default Fallback)" -> "Max"; null when the name has no
// trailing effort qualifier.
function effortLabel(aaName: string): string | null {
  const qualifier = aaName
    .match(/\(([^)]*)\)\s*$/)?.[1]
    .split(",")[0]
    .trim();
  return qualifier && EFFORT_LABELS.has(qualifier.toLowerCase()) ? qualifier : null;
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

// Fails loudly on config that no longer matches the data or the formula, instead of
// publishing rankings where a configured metric silently scores nothing (which happened
// when AA dropped the Coding and Agentic indexes).
function validateConfig(config: CategoriesConfig, aaVersion: unknown): void {
  if (aaVersion !== config.expectedIntelligenceIndexVersion) {
    throw new Error(
      `Artificial Analysis reports Intelligence Index version ${String(aaVersion)}, but config/categories.json expects ${config.expectedIntelligenceIndexVersion}. ` +
        "Check the API docs for changed or removed fields, adjust scoring, then update expectedIntelligenceIndexVersion.",
    );
  }
  for (const key of ["costFloorPerTask", "responseTimeFloorSeconds"] as const) {
    if (!(config[key] > 0)) {
      throw new Error(`config/categories.json: ${key} must be a positive number.`);
    }
  }
  for (const [name, category] of Object.entries(config.categories)) {
    const metrics = Object.keys(category.quality ?? {});
    const unknown = metrics.filter((k) => !QUALITY_METRICS.includes(k as QualityMetric));
    if (unknown.length > 0) {
      throw new Error(
        `Category "${name}" mixes unknown quality metrics: ${unknown.join(", ")}. Known metrics: ${QUALITY_METRICS.join(", ")}.`,
      );
    }
    const total = Object.values(category.quality ?? {}).reduce((sum, w) => sum + w, 0);
    if (metrics.length === 0 || Math.abs(total - 1) > 1e-6) {
      throw new Error(
        `Category "${name}" quality weights must sum to 1 (got ${total}), so quality stays in index points.`,
      );
    }
    for (const key of ["pointsPerCostDoubling", "pointsPerTimeDoubling"] as const) {
      if (!(category[key] >= 0)) {
        throw new Error(`Category "${name}": ${key} must be a number >= 0.`);
      }
    }
  }
}

// The mapped AA model plus its reasoning-effort siblings: same creator, same name once
// qualifiers are stripped, and a recognized effort label.
function effortVariants(mapped: AaModel, aaModels: AaModel[]): AaModel[] {
  const base = baseModelName(mapped.name);
  return aaModels.filter(
    (m) =>
      m === mapped ||
      (m.model_creator?.id === mapped.model_creator?.id &&
        baseModelName(m.name) === base &&
        effortLabel(m.name) !== null),
  );
}

// Builds a scorable variant, or returns the names of the inputs it lacks. Every scored
// variant needs all inputs; nothing is estimated or zero-filled.
function buildVariant(candidate: Candidate, aa: AaModel): Variant | string[] {
  const quality = Object.fromEntries(
    QUALITY_METRICS.map((m) => [m, aa.evaluations[QUALITY_FIELDS[m]] ?? null]),
  ) as Record<QualityMetric, number | null>;
  const aaCostPerTask =
    aa.artificial_analysis_intelligence_index_cost?.cost_per_task?.total_cost ?? null;
  const aaPriceInput = aa.pricing?.price_1m_input_tokens ?? null;
  const aaPriceOutput = aa.pricing?.price_1m_output_tokens ?? null;
  const aaBlended =
    aaPriceInput != null && aaPriceOutput != null ? blendedPrice(aaPriceInput, aaPriceOutput) : 0;
  const tokensPerSecond = aa.performance_v3?.mean_output_tokens_per_second ?? null;
  const timeToAnswer = aa.performance_v3?.mean_time_to_first_answer_token_seconds ?? null;

  const missing = [
    ...QUALITY_METRICS.filter((m) => quality[m] == null),
    !(aaCostPerTask != null && aaCostPerTask > 0) && "cost per task",
    !(aaBlended > 0) && "AA pricing",
    (!(tokensPerSecond != null && tokensPerSecond > 0) || timeToAnswer == null) && "performance_v3",
  ].filter((m): m is string => typeof m === "string");
  if (missing.length > 0) return missing;

  const providerBlended = blendedPrice(candidate.priceInput, candidate.priceOutput);
  return {
    provider: candidate.provider,
    model: candidate.model,
    effort: effortLabel(aa.name),
    aaSlug: aa.slug,
    quality: quality as Record<QualityMetric, number>,
    // Scale AA's measured cost per task by how this provider's price compares to AA's,
    // so a model that's cheap per token but verbose isn't mistaken for a cheap one.
    costPerTask: (aaCostPerTask! * providerBlended) / aaBlended,
    responseTimeSeconds: timeToAnswer! + RESPONSE_TOKENS / tokensPerSecond!,
    priceBlendedPer1M: providerBlended,
  };
}

const round = (value: number, digits: number) => Math.round(value * 10 ** digits) / 10 ** digits;

function scoreVariant(
  variant: Variant,
  category: CategoryConfig,
  config: CategoriesConfig,
): ScoredCandidate {
  const quality = QUALITY_METRICS.reduce(
    (sum, m) => sum + (category.quality[m] ?? 0) * variant.quality[m],
    0,
  );
  const costDoublings = Math.log2(
    Math.max(variant.costPerTask, config.costFloorPerTask) / REFERENCE_COST_PER_TASK,
  );
  const timeDoublings = Math.log2(
    Math.max(variant.responseTimeSeconds, config.responseTimeFloorSeconds) /
      REFERENCE_RESPONSE_TIME_SECONDS,
  );
  const score =
    quality -
    category.pointsPerCostDoubling * costDoublings -
    category.pointsPerTimeDoubling * timeDoublings;

  return {
    provider: variant.provider,
    model: variant.model,
    effort: variant.effort,
    aaSlug: variant.aaSlug,
    score: round(score, 1),
    breakdown: {
      quality: round(quality, 1),
      costPerTask: round(variant.costPerTask, 4),
      responseTimeSeconds: round(variant.responseTimeSeconds, 1),
      ...variant.quality,
    },
    priceBlendedPer1M: round(variant.priceBlendedPer1M, 3),
  };
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
  const aaModels = aaData.models as AaModel[];
  const aaBySlug = new Map<string, AaModel>(aaModels.map((m) => [m.slug, m]));

  const variants: Variant[] = [];
  let modelsScored = 0;

  for (const candidate of candidates) {
    const label = `${candidate.provider}/${candidate.model}`;
    if (blendedPrice(candidate.priceInput, candidate.priceOutput) <= 0) {
      // A free model has no cost per task to trade off against quality.
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
    const mapped = aaBySlug.get(map.aaSlug);
    if (!mapped) {
      console.warn(`Skipping ${label}: aaSlug "${map.aaSlug}" not found in fetched data.`);
      continue;
    }

    const built = effortVariants(mapped, aaModels).map((aa) => ({
      aa,
      result: buildVariant(candidate, aa),
    }));
    const scorable = built.flatMap((b) => (Array.isArray(b.result) ? [] : [b.result]));
    if (scorable.length === 0) {
      const missing = built.find((b) => b.aa === mapped)?.result as string[];
      console.warn(`Skipping ${label} ("${map.aaSlug}"): no ${missing.join(", ")}.`);
      continue;
    }
    variants.push(...scorable);
    modelsScored += 1;
  }

  if (variants.length === 0) {
    throw new Error(
      "No candidates have complete benchmark data; refusing to publish empty rankings.",
    );
  }

  const categories: Record<string, Record<Provider, ScoredCandidate[]>> = {};

  for (const [categoryName, categoryConfig] of Object.entries(config.categories)) {
    // Ties on the published (rounded) score go to the cheaper variant.
    const scored = variants
      .map((v) => scoreVariant(v, categoryConfig, config))
      .sort((a, b) => b.score - a.score || a.breakdown.costPerTask - b.breakdown.costPerTask);

    categories[categoryName] = Object.fromEntries(
      pricingSources.map((source) => {
        // Sorted best-first, so the first row seen for a model is its best effort.
        const bestPerModel = new Map<string, ScoredCandidate>();
        for (const row of scored) {
          if (row.provider === source.id && !bestPerModel.has(row.model)) {
            bestPerModel.set(row.model, row);
          }
        }
        return [source.id, [...bestPerModel.values()].slice(0, config.topNPerProvider)];
      }),
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
        candidatesConsidered: modelsScored,
        variantsConsidered: variants.length,
        intelligenceIndexVersion: aaData.intelligenceIndexVersion,
        categories,
      },
      null,
      2,
    ),
  );

  console.log(
    `Wrote recommendations for ${Object.keys(categories).length} categories (${modelsScored} scored models, ${variants.length} effort variants) to ${outFile}`,
  );
}

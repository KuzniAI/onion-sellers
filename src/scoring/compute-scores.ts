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

export interface AaModel {
  id: string;
  name: string;
  slug: string;
  evaluations: {
    artificial_analysis_intelligence_index?: number | null;
    artificial_analysis_coding_index?: number | null;
    artificial_analysis_agentic_index?: number | null;
  };
  performance?: {
    median_output_tokens_per_second?: number | null;
  };
}

interface CategoryWeights {
  agenticIndex?: number;
  codingIndex?: number;
  intelligenceIndex?: number;
  costEfficiency?: number;
  speed?: number;
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
  breakdown: Record<string, number>;
  priceBlendedPer1M: number;
}

const OUTPUT_OUTPUT_TO_INPUT_RATIO = 3; // assume 3 output tokens per 1 input token (typical agentic workload)

function blendedPrice(priceInput: number, priceOutput: number): number {
  const totalParts = 1 + OUTPUT_OUTPUT_TO_INPUT_RATIO;
  return (priceInput * 1 + priceOutput * OUTPUT_OUTPUT_TO_INPUT_RATIO) / totalParts;
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

export async function computeScores(): Promise<void> {
  const config = JSON.parse(await readFile(path.join("config", "categories.json"), "utf8"));
  const blacklist: BlacklistEntry[] = JSON.parse(
    await readFile(path.join("config", "blacklist.json"), "utf8"),
  );
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
  const aaData = JSON.parse(
    await readFile(path.join("data", "artificial-analysis", "language-models.json"), "utf8"),
  );
  const aaBySlug = new Map<string, AaModel>((aaData.models as AaModel[]).map((m) => [m.slug, m]));

  const enriched: {
    provider: Provider;
    model: string;
    aaSlug: string;
    agenticIndex: number;
    codingIndex: number;
    intelligenceIndex: number;
    speed: number;
    blendedPrice1m: number;
  }[] = [];

  for (const candidate of candidates) {
    const blendedPrice1m = blendedPrice(candidate.priceInput, candidate.priceOutput);
    if (blendedPrice1m <= 0) {
      // Cost efficiency is 1 / price, so free models would be infinitely efficient.
      console.warn(`Skipping ${candidate.provider}/${candidate.model}: free model, not scored.`);
      continue;
    }

    const map = mapping.find(
      (m) => m.provider === candidate.provider && m.providerModel === candidate.model,
    );
    if (!map || !map.aaSlug) {
      console.warn(
        `Skipping ${candidate.provider}/${candidate.model}: no Artificial Analysis mapping.`,
      );
      continue;
    }
    const aa = aaBySlug.get(map.aaSlug);
    if (!aa) {
      console.warn(
        `Skipping ${candidate.provider}/${candidate.model}: aaSlug "${map.aaSlug}" not found in fetched data.`,
      );
      continue;
    }
    const {
      artificial_analysis_agentic_index,
      artificial_analysis_coding_index,
      artificial_analysis_intelligence_index,
    } = aa.evaluations;
    const speed = aa.performance?.median_output_tokens_per_second;
    if (
      artificial_analysis_agentic_index == null ||
      artificial_analysis_coding_index == null ||
      artificial_analysis_intelligence_index == null ||
      speed == null
    ) {
      console.warn(
        `Skipping ${candidate.provider}/${candidate.model}: incomplete benchmark data for "${map.aaSlug}".`,
      );
      continue;
    }

    enriched.push({
      provider: candidate.provider,
      model: candidate.model,
      aaSlug: map.aaSlug,
      agenticIndex: artificial_analysis_agentic_index,
      codingIndex: artificial_analysis_coding_index,
      intelligenceIndex: artificial_analysis_intelligence_index,
      speed,
      blendedPrice1m,
    });
  }

  const categories: Record<string, Record<Provider, ScoredCandidate[]>> = {};

  for (const [categoryName, categoryConfig] of Object.entries(config.categories) as [
    string,
    { weights: CategoryWeights },
  ][]) {
    const weights = categoryConfig.weights;
    if (enriched.length === 0) {
      categories[categoryName] = Object.fromEntries(pricingSources.map((s) => [s.id, []]));
      continue;
    }

    const costEfficiencies = enriched.map((e) => 1 / e.blendedPrice1m);
    const ranges = {
      agenticIndex: [
        Math.min(...enriched.map((e) => e.agenticIndex)),
        Math.max(...enriched.map((e) => e.agenticIndex)),
      ],
      codingIndex: [
        Math.min(...enriched.map((e) => e.codingIndex)),
        Math.max(...enriched.map((e) => e.codingIndex)),
      ],
      intelligenceIndex: [
        Math.min(...enriched.map((e) => e.intelligenceIndex)),
        Math.max(...enriched.map((e) => e.intelligenceIndex)),
      ],
      speed: [Math.min(...enriched.map((e) => e.speed)), Math.max(...enriched.map((e) => e.speed))],
      costEfficiency: [Math.min(...costEfficiencies), Math.max(...costEfficiencies)],
    };

    const scored: ScoredCandidate[] = enriched.map((e, i) => {
      const normAgentic = normalize(e.agenticIndex, ranges.agenticIndex[0], ranges.agenticIndex[1]);
      const normCoding = normalize(e.codingIndex, ranges.codingIndex[0], ranges.codingIndex[1]);
      const normIntelligence = normalize(
        e.intelligenceIndex,
        ranges.intelligenceIndex[0],
        ranges.intelligenceIndex[1],
      );
      const normSpeed = normalize(e.speed, ranges.speed[0], ranges.speed[1]);
      const normCost = normalize(
        costEfficiencies[i],
        ranges.costEfficiency[0],
        ranges.costEfficiency[1],
      );

      const score =
        (weights.agenticIndex ?? 0) * normAgentic +
        (weights.codingIndex ?? 0) * normCoding +
        (weights.intelligenceIndex ?? 0) * normIntelligence +
        (weights.costEfficiency ?? 0) * normCost +
        (weights.speed ?? 0) * normSpeed;

      return {
        provider: e.provider,
        model: e.model,
        aaSlug: e.aaSlug,
        score: Math.round(score * 1000) / 1000,
        breakdown: {
          agenticIndex: e.agenticIndex,
          codingIndex: e.codingIndex,
          intelligenceIndex: e.intelligenceIndex,
          speed: e.speed,
          costEfficiency: Math.round(costEfficiencies[i] * 1000) / 1000,
        },
        priceBlendedPer1M: Math.round(e.blendedPrice1m * 1000) / 1000,
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

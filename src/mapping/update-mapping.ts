// Keeps config/model-mapping.json in sync with provider pricing and Artificial Analysis
// data. Entries whose aaSlug still exists in AA data are never touched, so manual choices
// and notes survive; missing, null, or broken entries are (re)matched by model name.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  baseModelName,
  loadCandidates,
  type AaModel,
  type MappingEntry,
  type Provider,
} from "../scoring/compute-scores.ts";

const MAPPING_FILE = path.join("config", "model-mapping.json");

// Order-insensitive token key, so "Claude Haiku 4.5" matches AA's "Claude 4.5 Haiku (Reasoning)".
function nameKey(name: string): string {
  return baseModelName(name)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .sort()
    .join(" ");
}

// Maps name key -> slug of AA's base variant (the unsuffixed slug, e.g. "gpt-5-6-luna" rather
// than "gpt-5-6-luna-low"), or null when the variants can't be told apart.
function buildAaIndex(models: AaModel[]): Map<string, string | null> {
  const groups = new Map<string, string[]>();
  for (const model of models) {
    const key = nameKey(model.name);
    groups.set(key, [...(groups.get(key) ?? []), model.slug]);
  }

  const index = new Map<string, string | null>();
  for (const [key, slugs] of groups) {
    const shortest = slugs.reduce((a, b) => (b.length < a.length ? b : a));
    const isBase = slugs.every((s) => s === shortest || s.startsWith(`${shortest}-`));
    index.set(key, isBase ? shortest : null);
  }
  return index;
}

// Mirrors the hand-written layout: one entry per line, blank line between providers.
function serialize(mapping: MappingEntry[]): string {
  const groups = new Map<Provider, MappingEntry[]>();
  for (const entry of mapping) {
    groups.set(entry.provider, [...(groups.get(entry.provider) ?? []), entry]);
  }
  const formatEntry = (entry: MappingEntry) =>
    `  { ${Object.entries(entry)
      .map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`)
      .join(", ")} }`;
  const blocks = [...groups.values()].map((group) => group.map(formatEntry).join(",\n"));
  return `[\n${blocks.join(",\n\n")}\n]\n`;
}

export async function updateModelMapping(): Promise<void> {
  const candidates = await loadCandidates();
  const aaData = JSON.parse(
    await readFile(path.join("data", "artificial-analysis", "language-models.json"), "utf8"),
  );
  const aaModels = aaData.models as AaModel[];
  const aaSlugs = new Set(aaModels.map((m) => m.slug));
  const aaIndex = buildAaIndex(aaModels);
  const mapping: MappingEntry[] = JSON.parse(await readFile(MAPPING_FILE, "utf8"));

  const changes: string[] = [];
  let unmatched = 0;

  for (const candidate of candidates) {
    const label = `${candidate.provider}/${candidate.model}`;
    const entry = mapping.find(
      (m) => m.provider === candidate.provider && m.providerModel === candidate.model,
    );
    if (entry?.aaSlug && aaSlugs.has(entry.aaSlug)) continue;

    // undefined: no AA model with this name; null: several variants, none clearly the base.
    const match = aaIndex.get(nameKey(candidate.model));

    if (match) {
      if (entry) {
        changes.push(`updated ${label}: ${entry.aaSlug ?? "null"} -> ${match}`);
        entry.aaSlug = match;
        delete entry.note;
      } else {
        mapping.push({
          provider: candidate.provider,
          providerModel: candidate.model,
          aaSlug: match,
        });
        changes.push(`added ${label} -> ${match}`);
      }
      continue;
    }

    unmatched++;
    if (!entry) {
      const note =
        match === null
          ? "Auto: several Artificial Analysis variants match this name; set aaSlug by hand."
          : "Auto: no Artificial Analysis match found; set aaSlug by hand if one exists.";
      mapping.push({
        provider: candidate.provider,
        providerModel: candidate.model,
        aaSlug: null,
        note,
      });
      changes.push(`added ${label} -> null`);
    } else if (entry.aaSlug) {
      changes.push(`updated ${label}: ${entry.aaSlug} (no longer in AA data) -> null`);
      entry.note = `Auto: previous aaSlug "${entry.aaSlug}" no longer exists in Artificial Analysis data.`;
      entry.aaSlug = null;
    }
    // Existing null entries with no new match are left as-is, keeping their note.
  }

  for (const change of changes) console.log(`  ${change}`);
  if (changes.length === 0) {
    console.log(`Model mapping up to date (${unmatched} candidates without an AA match).`);
    return;
  }

  await writeFile(MAPPING_FILE, serialize(mapping));
  console.log(
    `Wrote ${changes.length} mapping changes to ${MAPPING_FILE} (${unmatched} candidates without an AA match).`,
  );
}

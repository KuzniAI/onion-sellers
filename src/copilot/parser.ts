import * as cheerio from "cheerio";

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

// GitHub's own section slugs (table aria-labelledby) -> display creator name.
const CREATOR_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  "fine-tuned-github": "GitHub (Fine-tuned)",
  microsoft: "Microsoft",
  xai: "xAI",
  "moonshot-ai": "Moonshot AI",
};

export function parseCopilotPricingHtml(html: string): CopilotModelRow[] {
  const $ = cheerio.load(html);
  const rows: CopilotModelRow[] = [];

  $("table[aria-labelledby]").each((_, table) => {
    const slug = $(table).attr("aria-labelledby")!;
    const creator = CREATOR_NAMES[slug];
    if (!creator) return;

    const headers = $(table).find("thead th").toArray().map((th) => cellText($(th)));
    const col = (name: string) => headers.indexOf(name);

    $(table)
      .find("tbody tr")
      .each((_, tr) => {
        const cells = $(tr).find("td").toArray();
        const at = (index: number) => (index === -1 ? null : cellText($(cells[index])));

        rows.push({
          creator,
          model: at(col("Model"))!,
          releaseStatus: at(col("Release status"))!,
          category: at(col("Category"))!,
          tier: at(col("Tier")),
          thresholdInputTokens: parseThreshold(at(col("Threshold (input tokens)"))),
          price1mInput: parsePrice(at(col("Input")))!,
          price1mCachedInput: parsePrice(at(col("Cached input")))!,
          price1mCacheWrite: parsePrice(at(col("Cache write"))),
          price1mOutput: parsePrice(at(col("Output")))!,
        });
      });
  });

  if (rows.length === 0) {
    throw new Error("parseCopilotPricingHtml: no model rows found -- page structure may have changed");
  }
  return rows;
}

// Strips footnote markers (e.g. "Gemini 3.6 Flash<sup><a data-footnote-ref>1</a></sup>")
// so they don't get glued onto the visible cell text.
function cellText($cell: cheerio.Cheerio<any>): string {
  const clone = $cell.clone();
  clone.find("sup").remove();
  return clone.text().trim();
}

function parsePrice(text: string | null): number | null {
  if (text === null || text === "Not applicable") return null;
  return parseFloat(text.replace("$", ""));
}

function parseThreshold(text: string | null): number | null {
  if (text === null || text === "Not applicable") return null;
  const match = text.match(/(\d+)K/);
  return match ? Number(match[1]) * 1000 : null;
}

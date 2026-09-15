// Local-only parser repair: when a pricing parser throws, a Pi agent (via the Pi SDK)
// rewrites `source.parserPath` against the downloaded HTML, and the pipeline re-imports
// and validates the result itself. See README "Parser repair (local only)".

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { PricingSource } from "./source.ts";

export type ParserFailure<Row> = {
  source: PricingSource<Row>;
  html: string;
  error: unknown;
};

const MAX_ATTEMPTS = 3;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Repo-relative path with forward slashes, so prompts read the same on every OS.
function relative(file: string): string {
  return path.relative(process.cwd(), file).split(path.sep).join("/");
}

// Set in the environment of every Pi repair session, so a pipeline the agent runs itself
// (e.g. `npm start`) cannot start another repair session. Read once at load, before this
// process sets it for its own agent.
const REPAIR_SESSION_ENV = "PARSER_REPAIR_SESSION";
const insideRepairSession = Boolean(process.env[REPAIR_SESSION_ENV]);

// The CI check wins over PARSER_REPAIR: the daily workflow must never rewrite code.
function repairBlockedReason(): string | null {
  if (process.env.CI || process.env.GITHUB_ACTIONS) {
    return "running in CI; parser repair is local-only";
  }
  if (insideRepairSession) {
    return "already running inside a Pi repair session";
  }
  if (process.env.PARSER_REPAIR !== "1") {
    return "set PARSER_REPAIR=1 in .env to let a Pi agent rewrite it";
  }
  if (!process.env.PI_REPAIR_PROVIDER || !process.env.PI_REPAIR_MODEL) {
    return "PI_REPAIR_PROVIDER and PI_REPAIR_MODEL must be set";
  }
  return null;
}

// Returns the rows parsed by the repaired parser, or null when repair is disabled or failed
// (the existing data file is then left untouched).
export async function repairParser<Row>({
  source,
  html,
  error,
}: ParserFailure<Row>): Promise<Row[] | null> {
  console.error(
    `[${source.id}] parser failed for ${source.sourceUrl}: ${errorMessage(error)}\n` +
      `  Parser: ${source.parserPath}`,
  );

  const blocked = repairBlockedReason();
  if (blocked) {
    console.error(`  Parser repair skipped (${blocked}); keeping existing ${source.outFile}.`);
    return null;
  }

  const htmlPath = path.join(path.dirname(source.outFile), "source.html");
  await mkdir(path.dirname(htmlPath), { recursive: true });
  await writeFile(htmlPath, html);

  try {
    return await runPiRepair(source, html, htmlPath, errorMessage(error));
  } catch (err) {
    console.error(`[${source.id}] Pi repair crashed: ${errorMessage(err)}`);
    return null;
  }
}

async function runPiRepair<Row>(
  source: PricingSource<Row>,
  html: string,
  htmlPath: string,
  firstError: string,
): Promise<Row[] | null> {
  // Imported lazily so runs without the flag (including CI) never load the Pi SDK.
  const { createAgentSession, ModelRuntime, SessionManager } =
    await import("@earendil-works/pi-coding-agent");

  const provider = process.env.PI_REPAIR_PROVIDER!;
  const modelId = process.env.PI_REPAIR_MODEL!;
  const modelRuntime = await ModelRuntime.create();
  const model = modelRuntime.getModel(provider, modelId);
  if (!model) {
    console.error(`  Parser repair skipped: Pi has no model "${provider}/${modelId}".`);
    return null;
  }

  // Inherited by every command the agent runs.
  process.env[REPAIR_SESSION_ENV] = "1";
  const { session } = await createAgentSession({
    cwd: process.cwd(),
    model,
    modelRuntime,
    tools: [
      "read",
      "grep",
      "find",
      "ls",
      "edit",
      "write",
      process.platform === "win32" ? "powershell" : "bash",
    ],
    sessionManager: SessionManager.inMemory(),
  });

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      process.stdout.write(event.assistantMessageEvent.delta);
    } else if (event.type === "tool_execution_start") {
      console.log(`\n[${source.id}] pi -> ${event.toolName}`);
    }
  });

  try {
    let lastError = firstError;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(
        `\n[${source.id}] Pi repair attempt ${attempt}/${MAX_ATTEMPTS} with ${provider}/${modelId}`,
      );
      await session.prompt(
        attempt === 1
          ? initialPrompt(source, htmlPath, lastError)
          : retryPrompt(source, htmlPath, lastError),
      );

      try {
        const rows = await loadRepairedRows(source, html);
        console.log(
          `\n[${source.id}] Pi repair succeeded (${rows.length} rows). Review and commit ${relative(source.parserPath)}.`,
        );
        return rows;
      } catch (err) {
        lastError = errorMessage(err);
        console.error(`\n[${source.id}] repaired parser still fails: ${lastError}`);
      }
    }

    console.error(
      `[${source.id}] Pi repair gave up after ${MAX_ATTEMPTS} attempts; keeping existing ${source.outFile}. ` +
        `Pi's last attempt is left in ${relative(source.parserPath)} (see git diff).`,
    );
    return null;
  } finally {
    unsubscribe();
    session.dispose();
  }
}

// Validates the rewritten parser in-process instead of trusting the agent's own check.
async function loadRepairedRows<Row>(source: PricingSource<Row>, html: string): Promise<Row[]> {
  // The query string bypasses Node's module cache, which still holds the parser loaded at startup.
  const mod = await import(`${pathToFileURL(source.parserPath).href}?repair=${Date.now()}`);
  const parse = mod[source.parseExport];
  if (typeof parse !== "function") {
    throw new Error(`${relative(source.parserPath)} does not export ${source.parseExport}()`);
  }

  const rows: unknown = parse(html);
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`${source.parseExport}() returned no rows`);
  }
  const { input, output } = source.priceFields;
  rows.forEach((row, i) => {
    if (typeof row?.model !== "string" || row.model === "") {
      throw new Error(`row ${i} has no "model" string`);
    }
    for (const field of [input, output]) {
      if (!Number.isFinite(row[field])) {
        throw new Error(`row ${i} (${row.model}): "${field}" is not a finite number`);
      }
    }
  });
  return rows as Row[];
}

function initialPrompt<Row>(source: PricingSource<Row>, htmlPath: string, error: string): string {
  const parser = relative(source.parserPath);
  const page = relative(htmlPath);
  return [
    `The ${source.displayName} pricing parser fails with: ${error}`,
    "",
    `Rewrite ${parser} so it parses ${page} (the page downloaded from ${source.sourceUrl}).`,
    "",
    "Rules:",
    `- Edit only ${parser}. Keep its exported row type and the exported function ${source.parseExport}(html: string).`,
    `- Rows must follow this contract: ${source.rowContract}`,
    "- Use cheerio (already installed) and follow the style of src/opencode-go/parser.ts: find tables by their header text, not by position.",
    "- Throw a descriptive Error when an expected table is missing or no rows are found; never return partial data.",
    "- The project runs TypeScript directly on Node with type stripping (see AGENTS.md): no enums, namespaces or parameter properties, and import local files with the .ts extension.",
    `- Verify against the saved page: node --input-type=module -e "import { readFileSync } from 'node:fs'; import { ${source.parseExport} } from './${parser}'; console.log(JSON.stringify(${source.parseExport}(readFileSync('${page}', 'utf8')), null, 2))"`,
    "- Then run `npm run lint` and `npm run format` and fix anything they report.",
    "- Do not run `npm start` or any other part of the pipeline; the pipeline re-checks the parser itself when you finish.",
    "",
    "Finish with a short summary of the tables you parsed.",
  ].join("\n");
}

function retryPrompt<Row>(source: PricingSource<Row>, htmlPath: string, error: string): string {
  return [
    `The pipeline re-imported ${relative(source.parserPath)} and ${source.parseExport}() still fails validation: ${error}`,
    `Fix the parser, verify it again against ${relative(htmlPath)}, and re-run \`npm run lint\` and \`npm run format\`. Do not run \`npm start\`.`,
  ].join("\n");
}

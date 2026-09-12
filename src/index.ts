// Runs the benchmark pipeline: fetch Artificial Analysis data, then score models.
// Provider pricing (data/copilot, data/opencode-go) and data/model-mapping.json
// are still maintained by hand -- see README.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

function run(args: string[], options: { env?: NodeJS.ProcessEnv } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      stdio: "inherit",
      env: options.env ?? process.env,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${args.join(" ")} exited with code ${code}`));
    });
  });
}

async function main() {
  if (!existsSync(".env")) {
    console.error("Missing .env. Copy .env.example to .env and fill in AA_API_KEY before running.");
    process.exit(1);
  }

  console.log("== Step 1/2: fetching Artificial Analysis benchmark data ==");
  await run(["--env-file=.env", "scripts/fetch-artificial-analysis.ts"]);

  console.log("\n== Step 2/2: scoring models per category ==");
  await run(["scripts/compute-scores.ts"]);

  console.log("\nDone. See data/recommendations.json.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

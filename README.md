# Agentic Onion Sellers

Choose a best onion seller for you.

1. GitHub Copilot https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
2. OpenCode Go https://opencode.ai/docs/go/
3. OpenCode Zen https://opencode.ai/docs/zen/
4. ClinePass https://docs.cline.bot/getting-started/clinepass

## Model mapping

`config/model-mapping.json` links each provider model to its Artificial Analysis slug. Every run updates it:

- New provider models are added, matched to AA by name (word order and variant qualifiers like `(Reasoning)` are ignored; the base, unsuffixed AA slug is used).
- Entries with `aaSlug: null` are retried each run, and entries whose slug disappeared from AA data are re-matched.
- Entries whose `aaSlug` still exists in AA data are never touched, so you can override a match by editing `aaSlug` by hand.

## Parser repair (local only)

Pricing parsers (`src/<provider>/parser.ts`) are written and repaired by a [Pi](https://github.com/badlogic/pi-mono) coding agent through the Pi SDK (`@earendil-works/pi-coding-agent`), not by hand. When a parser throws, `src/pricing/repair-parser.ts` hands the downloaded page to Pi:

1. The page is saved to `data/<provider>/source.html`. Pi is told to rewrite only that provider's `parser.ts` against it, following the row contract in the provider's `source.ts`, and to run lint and format.
2. The pipeline re-imports the rewritten parser and validates the rows itself: at least one row, and every row has a model name plus numeric input/output prices. If validation fails, the error goes back to Pi, for up to 3 attempts.
3. On success the pricing file is written as usual. Review the parser change (`git diff src/`) and commit it.

Repair is off by default and never runs in CI:

- `PARSER_REPAIR=1` in `.env` turns it on. It is ignored whenever `CI` or `GITHUB_ACTIONS` is set, so in the daily workflow a broken parser just fails the run.
- `PI_REPAIR_PROVIDER` and `PI_REPAIR_MODEL` pick the Pi model (`opencode-go` / `glm-5.3-flash` in `.env.example`).
- Credentials come from Pi, not this project: run `npx pi` and `/login`, or set the provider's API key env var (`OPENCODE_API_KEY` for `opencode-go`).

OpenCode Zen and ClinePass start with stub parsers that throw. Run `npm start` locally once with `PARSER_REPAIR=1` to have Pi generate them. The daily workflow fails until those generated parsers are committed.

## Automation

`.github/workflows/daily.yml` runs the pipeline every day at 05:17 UTC (or on demand from the Actions tab):

- Mapping changes to `config/model-mapping.json` are committed straight to `main`.
- Results go to the orphan `data` branch: `latest/` holds the current `recommendations.json`, provider pricing, and the raw Artificial Analysis data; `history/YYYY-MM-DD/` keeps one snapshot per day.
- `site/index.html` is published with the latest data to https://kuzniai.github.io/onion-sellers/, including the Artificial Analysis data's fetch date so a rate-limited run is visible.
- If a pricing parser fails or a source download errors, the run fails before anything is committed or published, so the site keeps showing the last successful run untouched. Parser repair never runs in the workflow; fix parsers locally (see above). A 429 from Artificial Analysis is not fatal: the pipeline keeps the previous day's benchmark data and continues.

One-time setup:

1. Add the `AA_API_KEY` repository secret (Settings → Secrets and variables → Actions).
2. Settings → Pages → Source: **GitHub Actions**.
3. Run the workflow once by hand.

The workflow declares its own `contents: write` and `pages: write` permissions, so the repository's default workflow permissions can stay read-only. Pushing mapping changes requires `main` to accept pushes from `github-actions[bot]`.

GitHub disables scheduled workflows in public repositories after 60 days without activity; re-enable it in the Actions tab if that happens.

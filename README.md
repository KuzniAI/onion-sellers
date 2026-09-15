# Agentic Onion Sellers

Choose a best onion seller for you.

1. GitHub Copilot https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
2. OpenCode Go https://opencode.ai/docs/go/

## Model mapping

`config/model-mapping.json` links each provider model to its Artificial Analysis slug. Every run updates it:

- New provider models are added, matched to AA by name (word order and variant qualifiers like `(Reasoning)` are ignored; the base, unsuffixed AA slug is used).
- Entries with `aaSlug: null` are retried each run, and entries whose slug disappeared from AA data are re-matched.
- Entries whose `aaSlug` still exists in AA data are never touched, so you can override a match by editing `aaSlug` by hand.

## Automation

`.github/workflows/daily.yml` runs the pipeline every day at 05:17 UTC (or on demand from the Actions tab):

- Mapping changes to `config/model-mapping.json` are committed straight to `main`.
- Results go to the orphan `data` branch: `latest/` holds the current `recommendations.json` and provider pricing, `history/YYYY-MM-DD/` keeps one snapshot per day. Raw Artificial Analysis data is not stored or published.
- `site/index.html` is published with the latest data to https://kuzniai.github.io/onion-sellers/.
- If a pricing parser fails or a source download errors, the run fails before anything is committed or published, so the site keeps showing the last successful run untouched.

One-time setup:

1. Add the `AA_API_KEY` repository secret (Settings → Secrets and variables → Actions).
2. Settings → Pages → Source: **GitHub Actions**.
3. Run the workflow once by hand.

The workflow declares its own `contents: write` and `pages: write` permissions, so the repository's default workflow permissions can stay read-only. Pushing mapping changes requires `main` to accept pushes from `github-actions[bot]`.

GitHub disables scheduled workflows in public repositories after 60 days without activity; re-enable it in the Actions tab if that happens.

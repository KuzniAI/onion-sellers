# Agentic Onion Sellers

Choose a best onion seller for you.

1. GitHub Copilot https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
2. OpenCode Go https://opencode.ai/docs/go/

## Model mapping

`config/model-mapping.json` links each provider model to its Artificial Analysis slug. Every run updates it:

- New provider models are added, matched to AA by name (word order and variant qualifiers like `(Reasoning)` are ignored; the base, unsuffixed AA slug is used).
- Entries with `aaSlug: null` are retried each run, and entries whose slug disappeared from AA data are re-matched.
- Entries whose `aaSlug` still exists in AA data are never touched, so you can override a match by editing `aaSlug` by hand.

import { clinePassSource } from "../clinepass/source.ts";
import { copilotSource } from "../copilot/source.ts";
import { cursorSource } from "../cursor/source.ts";
import { openCodeGoSource } from "../opencode-go/source.ts";
import { openCodeZenSource } from "../opencode-zen/source.ts";
import { openRouterSource } from "../openrouter/source.ts";
import type { PricingSource } from "./source.ts";

// Every provider the pipeline refreshes and scores, in display order.
export const pricingSources: PricingSource<unknown>[] = [
  openCodeGoSource,
  openCodeZenSource,
  cursorSource,
  copilotSource,
  clinePassSource,
  openRouterSource,
];

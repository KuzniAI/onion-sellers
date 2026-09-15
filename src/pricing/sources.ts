import { clinePassSource } from "../clinepass/source.ts";
import { copilotSource } from "../copilot/source.ts";
import { openCodeGoSource } from "../opencode-go/source.ts";
import { openCodeZenSource } from "../opencode-zen/source.ts";

// Every provider the pipeline refreshes and scores, in display order.
export const pricingSources = [copilotSource, openCodeGoSource, openCodeZenSource, clinePassSource];

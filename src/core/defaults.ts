import type { ApprovalSettings } from "./settings.ts";

/** Safe initial settings used by the Settings provider and Web form. */
export const APPROVE_FOR_ME_DEFAULTS = {
  version: 1,
  mode: "rules-and-llm",
  rules: {
    commandPrefixes: [],
    reviewerInstructions: "",
  },
  reviewer: {
    timeoutMs: 30_000,
  },
  limits: {
    trustedTranscriptChars: 12_000,
    untrustedToolDataChars: 8_000,
    reviewerOutputChars: 2_000,
  },
} as const satisfies ApprovalSettings;

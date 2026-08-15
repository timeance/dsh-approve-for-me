import { validateCommandPrefix, type CommandPrefixRule } from "./shell.ts";

/** Available deterministic and model-assisted review modes. */
export type ApprovalReviewMode = "rules-only" | "rules-and-llm";

/** Explicit reviewer model selection. Credentials remain owned by Harness. */
export interface ReviewerModelSettings {
  /** Optional Harness provider override. Omit with model to inherit the request session. */
  provider?: string;
  /** Optional Harness model override. Omit with provider to inherit the request session. */
  model?: string;
  /** Maximum reviewer request duration. */
  timeoutMs: number;
}

/** Size limits applied before content reaches the reviewer model. */
export interface ReviewerContentLimits {
  /** Maximum serialized trusted transcript length. */
  trustedTranscriptChars: number;
  /** Maximum serialized untrusted request-data length. */
  untrustedToolDataChars: number;
  /** Maximum accepted reviewer response length. */
  reviewerOutputChars: number;
}

/** Persisted settings for the approve-for-me plugin. */
export interface ApprovalSettings {
  /** Persisted settings schema version. */
  version: 1;
  /** Review mode selected by the user. */
  mode: ApprovalReviewMode;
  /** Positive command-prefix allowlist and optional reviewer instructions. */
  rules: {
    commandPrefixes: readonly CommandPrefixRule[];
    reviewerInstructions: string;
  };
  /** Reviewer timeout and optional explicit route; omitted routes inherit the request session. */
  reviewer?: ReviewerModelSettings;
  /** Explicit content and response limits. */
  limits: ReviewerContentLimits;
}

/** One fail-closed settings validation issue. */
export interface SettingsIssue {
  /** JSON-like path to the invalid value. */
  path: string;
  /** Stable description suitable for diagnostics. */
  message: string;
}

/** Result of validating persisted plugin settings. */
export type SettingsParseResult =
  | { readonly ok: true; readonly settings: ApprovalSettings }
  | { readonly ok: false; readonly issues: readonly SettingsIssue[] };

const MAX_RULES = 200;
const MAX_PREFIX_CHARS = 1_000;
const MAX_INSTRUCTION_CHARS = 8_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_CONTENT_CHARS = 256;
const MAX_CONTENT_CHARS = 100_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 200;
}

function isIntegerInRange(value: unknown, minimum: number, maximum: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= minimum && value <= maximum;
}

/**
 * Validates persisted settings without substituting permissive defaults.
 *
 * @param input Value loaded from the Harness settings service.
 * @returns Validated settings, or issues that disable automatic approval.
 */
export function parseApprovalSettings(input: unknown): SettingsParseResult {
  const issues: SettingsIssue[] = [];
  if (!isRecord(input)) return { ok: false, issues: [{ path: "$", message: "expected an object" }] };
  if (!hasOnlyKeys(input, ["version", "mode", "rules", "reviewer", "limits"])) {
    issues.push({ path: "$", message: "contains unknown settings fields" });
  }
  if (input.version !== 1) issues.push({ path: "$.version", message: "must equal 1" });
  if (input.mode !== "rules-only" && input.mode !== "rules-and-llm") {
    issues.push({ path: "$.mode", message: "must be rules-only or rules-and-llm" });
  }

  const parsedRules: CommandPrefixRule[] = [];
  let reviewerInstructions = "";
  if (!isRecord(input.rules) || !hasOnlyKeys(input.rules, ["commandPrefixes", "reviewerInstructions"])) {
    issues.push({ path: "$.rules", message: "must contain only commandPrefixes and reviewerInstructions" });
  } else {
    if (!Array.isArray(input.rules.commandPrefixes) || input.rules.commandPrefixes.length > MAX_RULES) {
      issues.push({ path: "$.rules.commandPrefixes", message: `must be an array with at most ${MAX_RULES} entries` });
    } else {
      input.rules.commandPrefixes.forEach((entry, index) => {
        const path = `$.rules.commandPrefixes[${index}]`;
        if (!isRecord(entry) || !hasOnlyKeys(entry, ["tool", "prefix"])) {
          issues.push({ path, message: "must contain only tool and prefix" });
          return;
        }
        if (entry.tool !== "shell" && entry.tool !== "pwsh") {
          issues.push({ path: `${path}.tool`, message: "must be shell or pwsh" });
          return;
        }
        if (
          typeof entry.prefix !== "string" ||
          entry.prefix.trim() !== entry.prefix ||
          entry.prefix.length === 0 ||
          entry.prefix.length > MAX_PREFIX_CHARS
        ) {
          issues.push({ path: `${path}.prefix`, message: "must be a bounded non-empty literal prefix" });
          return;
        }
        const rule = { tool: entry.tool, prefix: entry.prefix } satisfies CommandPrefixRule;
        if (!validateCommandPrefix(rule).ok) {
          issues.push({ path: `${path}.prefix`, message: "must be one literal command segment without shell expansion" });
          return;
        }
        parsedRules.push(rule);
      });
    }
    if (
      typeof input.rules.reviewerInstructions !== "string" ||
      input.rules.reviewerInstructions.length > MAX_INSTRUCTION_CHARS
    ) {
      issues.push({
        path: "$.rules.reviewerInstructions",
        message: `must be a string with at most ${MAX_INSTRUCTION_CHARS} characters`,
      });
    } else {
      reviewerInstructions = input.rules.reviewerInstructions;
    }
  }

  let reviewer: ReviewerModelSettings | undefined;
  if (input.reviewer !== undefined) {
    if (!isRecord(input.reviewer) || !hasOnlyKeys(input.reviewer, ["provider", "model", "timeoutMs"])) {
      issues.push({ path: "$.reviewer", message: "must contain only provider, model, and timeoutMs" });
    } else {
      let reviewerValid = true;
      const hasProvider = Object.hasOwn(input.reviewer, "provider");
      const hasModel = Object.hasOwn(input.reviewer, "model");
      if (hasProvider !== hasModel) {
        issues.push({ path: "$.reviewer", message: "provider and model must be configured together" });
        reviewerValid = false;
      } else if (hasProvider && (
        !isBoundedIdentifier(input.reviewer.provider) ||
        !isBoundedIdentifier(input.reviewer.model)
      )) {
        issues.push({ path: "$.reviewer", message: "contains an invalid provider or model" });
        reviewerValid = false;
      }
      const timeoutMs = input.reviewer.timeoutMs;
      if (!isIntegerInRange(timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS)) {
        issues.push({ path: "$.reviewer.timeoutMs", message: "must be a bounded integer timeout" });
        reviewerValid = false;
      }
      if (reviewerValid) {
        reviewer = {
          ...(hasProvider
            ? {
                provider: input.reviewer.provider as string,
                model: input.reviewer.model as string,
              }
            : {}),
          timeoutMs: timeoutMs as number,
        };
      }
    }
  }

  let limits: ReviewerContentLimits | undefined;
  if (!isRecord(input.limits) || !hasOnlyKeys(input.limits, ["trustedTranscriptChars", "untrustedToolDataChars", "reviewerOutputChars"])) {
    issues.push({ path: "$.limits", message: "must contain all reviewer content limits" });
  } else if (
    !isIntegerInRange(input.limits.trustedTranscriptChars, MIN_CONTENT_CHARS, MAX_CONTENT_CHARS) ||
    !isIntegerInRange(input.limits.untrustedToolDataChars, MIN_CONTENT_CHARS, MAX_CONTENT_CHARS) ||
    !isIntegerInRange(input.limits.reviewerOutputChars, MIN_CONTENT_CHARS, MAX_CONTENT_CHARS)
  ) {
    issues.push({ path: "$.limits", message: "content limits must be bounded positive integers" });
  } else {
    limits = {
      trustedTranscriptChars: input.limits.trustedTranscriptChars,
      untrustedToolDataChars: input.limits.untrustedToolDataChars,
      reviewerOutputChars: input.limits.reviewerOutputChars,
    };
  }

  if (
    issues.length > 0 ||
    limits === undefined ||
    (input.mode !== "rules-only" && input.mode !== "rules-and-llm")
  ) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    settings: {
      version: 1,
      mode: input.mode,
      rules: { commandPrefixes: parsedRules, reviewerInstructions },
      ...(reviewer === undefined ? {} : { reviewer }),
      limits,
    },
  };
}

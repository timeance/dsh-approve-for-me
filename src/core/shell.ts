/** Supported shell tools for deterministic approval rules. */
export type ShellToolName = "shell" | "pwsh";

/** Host tool names that can emit sandbox-widening approvals. */
export type HostShellToolName = "bash" | "pwsh";

/** A shell command split into independently checked command segments. */
export interface ParsedShellCommand {
  /** Shell syntax used while tokenizing the command. */
  dialect: ShellToolName;
  /** Tokenized commands separated by control operators. */
  segments: readonly (readonly string[])[];
}

/** Failure categories that require native human approval. */
export type ShellParseFailure =
  | "empty-command"
  | "empty-segment"
  | "unterminated-quote"
  | "trailing-escape"
  | "substitution-or-expansion"
  | "redirection"
  | "wildcard"
  | "grouping-or-background"
  | "comment"
  | "multiline-command"
  | "environment-assignment";

/** Result of parsing an untrusted shell command. */
export type ShellParseResult =
  | { readonly ok: true; readonly command: ParsedShellCommand }
  | { readonly ok: false; readonly reason: ShellParseFailure };

/** One deterministic command-prefix rule. */
export interface CommandPrefixRule {
  /** Shell tool to which the prefix applies. */
  tool: ShellToolName;
  /** Literal token prefix. Shell syntax and wildcards are not supported. */
  prefix: string;
}

/** Result of evaluating every command segment against configured prefixes. */
export type RuleEvaluation =
  | {
      readonly status: "matched";
      readonly segmentCount: number;
      readonly matchedPrefixes: readonly string[];
    }
  | {
      readonly status: "manual";
      readonly reason: "unparseable-command" | "invalid-rule" | "no-matching-prefix";
      readonly detail?: ShellParseFailure;
    };

/** Context captured when a shell tool asks to widen its sandbox. */
export interface ShellExecutionContext {
  /** Exact Harness agent object attached to the tool execution. */
  agent: unknown;
  /** Opaque tool-call identifier. */
  callId: string;
  /** Shell tool being executed. */
  toolName: string;
  /** Original lossless-JSON tool arguments. */
  args: unknown;
}

/** Approval event fields used to correlate a sandbox-widening request. */
export interface ShellApprovalRequest {
  /** Exact Harness agent object attached to the approval event. */
  agent: unknown;
  /** Opaque tool-call identifier associated with the event. */
  callId?: string;
  /** Tool name associated with the event. */
  toolName: string;
  /** Human-facing reason emitted by the sandbox escalation helper. */
  reason?: string;
}

/** A strictly associated sandbox escalation. */
export interface AssociatedShellEscalation {
  /** Exact Harness agent object shared by both events. */
  agent: object;
  /** Opaque tool-call identifier. */
  callId: string;
  /** Supported shell tool. */
  toolName: ShellToolName;
  /** Command whose escalation is under review. */
  command: string;
  /** Exact tool-provided justification. */
  justification: string;
  /** Requested sandbox permission validated by the Host. */
  requestedPermission: "workspace-write" | "danger-full-access";
}

/** Result of correlating an approval event with a shell execution. */
export type EscalationAssociation =
  | { readonly status: "associated"; readonly escalation: AssociatedShellEscalation }
  | {
      readonly status: "manual";
      readonly reason:
        | "invalid-context"
        | "unsupported-tool"
        | "identity-mismatch"
        | "not-verified-widening"
        | "invalid-justification"
        | "reason-mismatch";
    };

const CONTROL_OPERATORS = new Set([";", "&&", "||", "|"]);
const MAX_JUSTIFICATION_CHARS = 4_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAgentReference(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

function isNonEmptyIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isHostShellToolName(value: string): value is HostShellToolName {
  return value === "bash" || value === "pwsh";
}

function toRuleToolName(value: HostShellToolName): ShellToolName {
  return value === "bash" ? "shell" : "pwsh";
}

function tokensMatch(expected: string, actual: string, dialect: ShellToolName, index: number): boolean {
  if (dialect !== "pwsh") return expected === actual;
  const parameter = /^-{1,2}[A-Za-z][A-Za-z0-9-]*$/u;
  if (index !== 0 && (!parameter.test(expected) || !parameter.test(actual))) {
    return expected === actual;
  }
  return expected.toLocaleLowerCase("en-US") === actual.toLocaleLowerCase("en-US");
}

function flushToken(token: string, segment: string[]): void {
  if (token.length > 0) segment.push(token);
}

/**
 * Parses only the shell subset that can be matched without executing or expanding it.
 *
 * @param source Untrusted command string.
 * @param dialect Shell syntax to recognize.
 * @returns Parsed command segments, or a reason requiring human approval.
 */
export function parseShellCommand(source: string, dialect: ShellToolName): ShellParseResult {
  if (source.length === 0 || source.trim().length === 0) return { ok: false, reason: "empty-command" };
  if (source.includes("\n") || source.includes("\r") || source.includes("\0")) {
    return { ok: false, reason: "multiline-command" };
  }

  const segments: string[][] = [];
  let segment: string[] = [];
  let token = "";
  let quote: "single" | "double" | undefined;

  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;

    if (quote === "single") {
      if (character === "'") quote = undefined;
      else token += character;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "$") return { ok: false, reason: "substitution-or-expansion" };
      if (dialect === "shell" && character === "`") {
        return { ok: false, reason: "substitution-or-expansion" };
      }
      if ((dialect === "shell" && character === "\\") || (dialect === "pwsh" && character === "`")) {
        const escaped = source[index + 1];
        if (escaped === undefined) return { ok: false, reason: "trailing-escape" };
        token += escaped;
        index += 1;
        continue;
      }
      token += character;
      continue;
    }

    if (character === "'") {
      quote = "single";
      continue;
    }
    if (character === '"') {
      quote = "double";
      continue;
    }
    if (character === "$") return { ok: false, reason: "substitution-or-expansion" };
    if (dialect === "pwsh" && character === "@" && token.length === 0) {
      return { ok: false, reason: "substitution-or-expansion" };
    }
    if (dialect === "shell" && character === "`") {
      return { ok: false, reason: "substitution-or-expansion" };
    }
    if ((dialect === "shell" && character === "\\") || (dialect === "pwsh" && character === "`")) {
      const escaped = source[index + 1];
      if (escaped === undefined) return { ok: false, reason: "trailing-escape" };
      token += escaped;
      index += 1;
      continue;
    }
    if (character === ">" || character === "<") return { ok: false, reason: "redirection" };
    if (character === "*" || character === "?" || character === "[") {
      return { ok: false, reason: "wildcard" };
    }
    if (character === "(" || character === ")" || character === "{" || character === "}" || character === "!") {
      return { ok: false, reason: "grouping-or-background" };
    }
    if (character === "#") return { ok: false, reason: "comment" };

    const pair = source.slice(index, index + 2);
    const operator = pair === "&&" || pair === "||" ? pair : CONTROL_OPERATORS.has(character) ? character : undefined;
    if (operator !== undefined) {
      flushToken(token, segment);
      token = "";
      if (segment.length === 0) return { ok: false, reason: "empty-segment" };
      segments.push(segment);
      segment = [];
      if (operator.length === 2) index += 1;
      continue;
    }
    if (character === "&") return { ok: false, reason: "grouping-or-background" };

    if (/\s/u.test(character)) {
      flushToken(token, segment);
      token = "";
      continue;
    }
    token += character;
  }

  if (quote !== undefined) return { ok: false, reason: "unterminated-quote" };
  flushToken(token, segment);
  if (segment.length === 0) return { ok: false, reason: "empty-segment" };
  segments.push(segment);

  for (const parsedSegment of segments) {
    if (/^[A-Za-z_][A-Za-z0-9_]*(?:\+)?=/u.test(parsedSegment[0]!)) {
      return { ok: false, reason: "environment-assignment" };
    }
  }

  return { ok: true, command: { dialect, segments } };
}

/**
 * Checks whether a configured prefix is a single literal command prefix.
 *
 * @param rule Rule supplied by settings.
 * @returns Parsed tokens, or a reason that makes the settings invalid.
 */
export function validateCommandPrefix(
  rule: CommandPrefixRule,
): { readonly ok: true; readonly tokens: readonly string[] } | { readonly ok: false; readonly reason: ShellParseFailure | "multiple-segments" } {
  const parsed = parseShellCommand(rule.prefix, rule.tool);
  if (!parsed.ok) return parsed;
  if (parsed.command.segments.length !== 1) return { ok: false, reason: "multiple-segments" };
  return { ok: true, tokens: parsed.command.segments[0]! };
}

/**
 * Requires every command segment to match a literal token prefix for its shell.
 *
 * @param command Untrusted command under review.
 * @param tool Shell tool that will execute the command.
 * @param rules Configured positive allowlist.
 * @returns A match only when every segment is covered by a valid rule.
 */
export function evaluateCommandRules(
  command: string,
  tool: ShellToolName,
  rules: readonly CommandPrefixRule[],
): RuleEvaluation {
  const parsed = parseShellCommand(command, tool);
  if (!parsed.ok) return { status: "manual", reason: "unparseable-command", detail: parsed.reason };

  const compiled = rules
    .filter((rule) => rule.tool === tool)
    .map((rule) => ({ rule, parsed: validateCommandPrefix(rule) }));
  if (compiled.some((entry) => !entry.parsed.ok)) return { status: "manual", reason: "invalid-rule" };

  const matchedPrefixes: string[] = [];
  for (const segment of parsed.command.segments) {
    const match = compiled.find((entry) => {
      if (!entry.parsed.ok || entry.parsed.tokens.length > segment.length) return false;
      return entry.parsed.tokens.every((expected, index) =>
        tokensMatch(expected, segment[index]!, tool, index));
    });
    if (match === undefined) return { status: "manual", reason: "no-matching-prefix" };
    matchedPrefixes.push(match.rule.prefix);
  }

  return { status: "matched", segmentCount: parsed.command.segments.length, matchedPrefixes };
}

/**
 * Correlates an approval request with the exact shell call that requested host access.
 *
 * @param execution Captured tool execution.
 * @param approval Approval event emitted for that execution.
 * @param verifiedWidening Whether the Host proved the requested mode widens the resolved sandbox policy.
 * @returns An associated escalation only for an exact, Host-verified widening.
 */
export function associateShellEscalation(
  execution: ShellExecutionContext,
  approval: ShellApprovalRequest,
  verifiedWidening: boolean,
): EscalationAssociation {
  if (
    !isAgentReference(execution.agent) ||
    !isAgentReference(approval.agent) ||
    !isNonEmptyIdentifier(execution.callId) ||
    !isNonEmptyIdentifier(approval.callId) ||
    !isRecord(execution.args)
  ) {
    return { status: "manual", reason: "invalid-context" };
  }
  if (!isHostShellToolName(execution.toolName) || !isHostShellToolName(approval.toolName)) {
    return { status: "manual", reason: "unsupported-tool" };
  }
  if (
    execution.agent !== approval.agent ||
    execution.callId !== approval.callId ||
    execution.toolName !== approval.toolName
  ) {
    return { status: "manual", reason: "identity-mismatch" };
  }

  const command = execution.args.command;
  const requestedPermission = execution.args.sandbox_permissions;
  const justification = execution.args.justification;
  if (
    (requestedPermission !== "workspace-write" && requestedPermission !== "danger-full-access") ||
    verifiedWidening !== true
  ) {
    return { status: "manual", reason: "not-verified-widening" };
  }
  if (
    typeof command !== "string" ||
    command.trim().length === 0 ||
    typeof justification !== "string" ||
    justification.trim().length === 0 ||
    justification.trim() !== justification ||
    justification.length > MAX_JUSTIFICATION_CHARS
  ) {
    return { status: "manual", reason: "invalid-justification" };
  }

  const expectedReason = `escalate sandbox to ${requestedPermission}: ${justification}`;
  if (approval.reason !== expectedReason) return { status: "manual", reason: "reason-mismatch" };

  return {
    status: "associated",
    escalation: {
      agent: execution.agent,
      callId: execution.callId,
      toolName: toRuleToolName(execution.toolName),
      command,
      justification,
      requestedPermission,
    },
  };
}

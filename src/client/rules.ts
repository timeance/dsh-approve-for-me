import {
  validateCommandPrefix,
  type ShellParseFailure,
} from '../core/shell.ts'
import type { ApprovalRuleTool } from './settings-types.ts'

export interface ParsedCommandPrefix {
  readonly line: number
  readonly prefix: string
}

export type CommandPrefixRuleError =
  | { readonly code: 'control-character'; readonly line: number }
  | { readonly code: 'too-long'; readonly line: number }
  | { readonly code: 'duplicate'; readonly line: number; readonly firstLine: number }
  | {
      readonly code: 'invalid-prefix'
      readonly line: number
      readonly reason: ShellParseFailure | 'multiple-segments'
    }

export interface CommandPrefixParseResult {
  readonly prefixes: readonly string[]
  readonly rules: readonly ParsedCommandPrefix[]
  readonly errors: readonly CommandPrefixRuleError[]
}

const MAX_PREFIX_CHARS = 1_000
const UNSUPPORTED_CONTROL_CHARACTER =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u

/**
 * Parses one command prefix per line for one shell family.
 *
 * Blank lines and lines whose first non-space character is '#' are ignored.
 * Persisted rows use the same literal-prefix validator as the Host.
 */
export function parseCommandPrefixRules(
  source: string,
  tool: ApprovalRuleTool,
): CommandPrefixParseResult {
  const rules: ParsedCommandPrefix[] = []
  const errors: CommandPrefixRuleError[] = []
  const firstLineByPrefix = new Map<string, number>()

  for (const [index, rawLine] of source.split(/\r?\n/u).entries()) {
    const line = index + 1
    const prefix = rawLine.trim()
    if (prefix === '' || prefix.startsWith('#')) continue

    if (UNSUPPORTED_CONTROL_CHARACTER.test(prefix)) {
      errors.push({ code: 'control-character', line })
      continue
    }
    if (prefix.length > MAX_PREFIX_CHARS) {
      errors.push({ code: 'too-long', line })
      continue
    }

    const firstLine = firstLineByPrefix.get(prefix)
    if (firstLine !== undefined) {
      errors.push({ code: 'duplicate', line, firstLine })
      continue
    }

    const validation = validateCommandPrefix({ tool, prefix })
    if (!validation.ok) {
      errors.push({ code: 'invalid-prefix', line, reason: validation.reason })
      continue
    }

    firstLineByPrefix.set(prefix, line)
    rules.push({ line, prefix })
  }

  return {
    prefixes: rules.map(rule => rule.prefix),
    rules,
    errors,
  }
}

/** Creates canonical editor text from persisted prefixes. */
export function serializeCommandPrefixRules(
  prefixes: readonly string[],
): string {
  return prefixes.join('\n')
}

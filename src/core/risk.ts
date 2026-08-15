import { parseShellCommand, type ShellToolName } from "./shell.ts";

/** Fixed signals that always require native human approval. */
export type HighRiskSignal =
  | "ambiguous-shell"
  | "file-or-permission-change"
  | "privilege-or-system-change"
  | "destructive-version-control"
  | "dynamic-command-execution"
  | "credential-access"
  | "external-write";

/** Result of applying non-configurable high-risk checks. */
export type HighRiskAssessment =
  | { readonly status: "safe" }
  | { readonly status: "manual"; readonly signal: HighRiskSignal };

const FILE_MUTATION_COMMANDS = new Set([
  "add-content",
  "clear-content",
  "copy",
  "copy-item",
  "cp",
  "del",
  "erase",
  "install",
  "mkdir",
  "move",
  "move-item",
  "mv",
  "new-item",
  "out-file",
  "rd",
  "remove-item",
  "ren",
  "rename",
  "rename-item",
  "rmdir",
  "rm",
  "set-content",
  "tee",
  "touch",
]);

const PERMISSION_COMMANDS = new Set([
  "chgrp",
  "chmod",
  "chown",
  "icacls",
  "set-acl",
  "takeown",
]);

const SYSTEM_COMMANDS = new Set([
  "bcdedit",
  "choco",
  "diskpart",
  "dnf",
  "doas",
  "format",
  "launchctl",
  "netsh",
  "reboot",
  "reg",
  "restart-computer",
  "runas",
  "sc",
  "schtasks",
  "service",
  "set-executionpolicy",
  "shutdown",
  "stop-computer",
  "sudo",
  "systemctl",
  "winget",
  "yum",
]);

const DYNAMIC_COMMANDS = new Set([
  ".",
  "awk",
  "command",
  "eval",
  "gawk",
  "iex",
  "invoke-expression",
  "mawk",
  "nice",
  "nohup",
  "npx",
  "parallel",
  "sed",
  "setsid",
  "source",
  "start-process",
  "stdbuf",
  "time",
  "timeout",
  "xargs",
]);

const SCRIPT_INTERPRETERS = new Set([
  "bash",
  "cmd",
  "node",
  "perl",
  "powershell",
  "pwsh",
  "python",
  "python3",
  "ruby",
  "sh",
  "zsh",
]);

const READ_ONLY_GIT_COMMANDS = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "grep",
  "help",
  "log",
  "ls-files",
  "ls-remote",
  "ls-tree",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "status",
  "version",
]);

const READ_ONLY_GH_ACTIONS = new Map<string, ReadonlySet<string>>([
  ["auth", new Set(["status"])],
  ["gist", new Set(["list", "view"])],
  ["issue", new Set(["list", "status", "view"])],
  ["pr", new Set(["checks", "diff", "list", "status", "view"])],
  ["release", new Set(["list", "view"])],
  ["repo", new Set(["list", "view"])],
  ["run", new Set(["list", "view", "watch"])],
  ["workflow", new Set(["list", "view"])],
]);

const CREDENTIAL_COMMANDS = new Set([
  "cmdkey",
  "env",
  "get-credential",
  "printenv",
  "security",
]);

function basename(command: string): string {
  return command.replace(/\\/gu, "/").split("/").at(-1)!.replace(/\.exe$/iu, "").toLocaleLowerCase("en-US");
}

function lowerTokens(tokens: readonly string[]): string[] {
  return tokens.map((token) => token.toLocaleLowerCase("en-US"));
}

function hasAny(tokens: readonly string[], values: readonly string[]): boolean {
  const normalized = new Set(tokens);
  return values.some((value) => normalized.has(value));
}

function isPackageMutation(command: string, tokens: readonly string[]): boolean {
  if (!["apt", "apt-get", "brew", "npm", "pip", "pip3", "pnpm", "scoop", "yarn"].includes(command)) {
    return false;
  }
  return tokens.some((token) =>
    [
      "add",
      "ci",
      "i",
      "install",
      "link",
      "pack",
      "publish",
      "remove",
      "rm",
      "un",
      "uninstall",
      "up",
      "update",
      "upgrade",
    ].includes(token),
  );
}

function isGitMutation(tokens: readonly string[]): boolean {
  if (tokens.length === 1) return false;
  if (tokens.some((token) =>
    token === "--ext-diff" ||
    token === "--textconv" ||
    token === "--output" ||
    token.startsWith("--output=") ||
    token === "--open-files-in-pager" ||
    token.startsWith("--open-files-in-pager="))) {
    return true;
  }
  const subcommand = tokens[1]!;
  if (subcommand === "--help" || subcommand === "--version" || subcommand === "-h") return false;
  return !READ_ONLY_GIT_COMMANDS.has(subcommand);
}

function ghCommandIndex(tokens: readonly string[]): number | undefined {
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (["-r", "--repo", "--hostname"].includes(token)) {
      if (tokens[index + 1] === undefined) return undefined;
      index += 1;
      continue;
    }
    if (/^--(?:repo|hostname)=/u.test(token)) continue;
    if (token.startsWith("-")) continue;
    return index;
  }
  return undefined;
}

function isGhMutation(tokens: readonly string[]): boolean {
  const commandIndex = ghCommandIndex(tokens);
  if (commandIndex === undefined) return false;
  const area = tokens[commandIndex];
  const action = tokens[commandIndex + 1];
  if (area === "api") {
    const apiTokens = tokens.slice(commandIndex + 1);
    if (apiTokens.some((token) =>
      token === "-f" || token === "--field" || token === "--raw-field" || token === "--input" ||
      /^-f.+/u.test(token) || /^--(?:field|raw-field|input)=/u.test(token))) {
      return true;
    }
    return apiTokens.some((token, index) => {
      if (token === "-x" || token === "--method") {
        const method = apiTokens[index + 1];
        return method === undefined || (method !== "get" && method !== "head");
      }
      const method = token.match(/^(?:-x|--method=)(.+)$/u)?.[1];
      return method !== undefined && method !== "get" && method !== "head";
    });
  }
  if (area !== undefined && ["help", "search", "status", "version"].includes(area)) return false;
  return area === undefined || action === undefined || READ_ONLY_GH_ACTIONS.get(area)?.has(action) !== true;
}

function isGhCredentialAccess(tokens: readonly string[]): boolean {
  const commandIndex = ghCommandIndex(tokens);
  if (commandIndex === undefined || tokens[commandIndex] !== "auth") return false;
  const action = tokens[commandIndex + 1];
  if (action === "token") return true;
  return action === "status" && tokens.slice(commandIndex + 2).some((token) =>
    token === "--show-token" || token === "-t");
}

function isCurlMutation(tokens: readonly string[]): boolean {
  const switches = new Set([
    "--compressed",
    "--fail",
    "--fail-with-body",
    "--get",
    "--head",
    "--help",
    "--include",
    "--location",
    "--no-progress-meter",
    "--show-error",
    "--silent",
    "--version",
    "-G",
    "-I",
    "-L",
    "-S",
    "-V",
    "-f",
    "-g",
    "-h",
    "-i",
    "-s",
    "-v",
  ]);
  const optionsWithValues = new Set([
    "--connect-timeout",
    "--header",
    "--max-time",
    "--resolve",
    "--retry",
    "--retry-delay",
    "--retry-max-time",
    "--url",
    "--user-agent",
    "-A",
    "-H",
    "-m",
  ]);

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const normalized = token.startsWith("--") ? token.toLocaleLowerCase("en-US") : token;
    if (token === "-X" || normalized === "--request") {
      const method = tokens[index + 1]?.toLocaleLowerCase("en-US");
      if (method === undefined || (method !== "get" && method !== "head")) return true;
      index += 1;
      continue;
    }
    const inlineMethod = (
      token.match(/^-X(.+)$/u)?.[1] ??
      normalized.match(/^--request=(.+)$/u)?.[1]
    )?.toLocaleLowerCase("en-US");
    if (inlineMethod !== undefined) {
      if (inlineMethod !== "get" && inlineMethod !== "head") return true;
      continue;
    }
    if (switches.has(normalized)) continue;
    if (optionsWithValues.has(normalized)) {
      if (tokens[index + 1] === undefined) return true;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return true;
  }
  return false;
}

function isPowerShellWebMutation(command: string, tokens: readonly string[]): boolean {
  if (!["invoke-restmethod", "invoke-webrequest", "irm", "iwr"].includes(command)) return false;
  const switches = new Set([
    "-debug",
    "-disablekeepalive",
    "-skipcertificatecheck",
    "-skipheadervalidation",
    "-usebasicparsing",
    "-verbose",
  ]);
  const parametersWithValues = new Set([
    "-erroraction",
    "-headers",
    "-httpversion",
    "-maximumredirection",
    "-maximumretrycount",
    "-retryintervalsec",
    "-sslprotocol",
    "-timeoutsec",
    "-uri",
    "-useragent",
  ]);

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.length >= 2 && "-method".startsWith(token)) {
      const method = tokens[index + 1];
      if (method === undefined || (method !== "get" && method !== "head")) return true;
      index += 1;
      continue;
    }
    const inlineMethod = token.match(/^-method:(.+)$/u)?.[1];
    if (inlineMethod !== undefined) {
      if (inlineMethod !== "get" && inlineMethod !== "head") return true;
      continue;
    }
    if (switches.has(token)) continue;
    if (parametersWithValues.has(token)) {
      if (tokens[index + 1] === undefined) return true;
      index += 1;
      continue;
    }
    if (token.startsWith("-")) return true;
  }
  return false;
}

function isScriptInterpreter(command: string): boolean {
  return SCRIPT_INTERPRETERS.has(command) ||
    command === "py" ||
    /^nodejs(?:\d+(?:\.\d+)*)?$/u.test(command) ||
    /^perl(?:\d+(?:\.\d+)*)?$/u.test(command) ||
    /^python(?:\d+(?:\.\d+)*)?$/u.test(command) ||
    /^ruby(?:\d+(?:\.\d+)*)?$/u.test(command);
}

function isDynamicInterpreter(command: string, tokens: readonly string[]): boolean {
  if (!isScriptInterpreter(command)) return false;
  if (tokens.length !== 2) return true;
  return !["--help", "--version", "/?"].includes(tokens[1]!);
}

function referencesCredential(tokens: readonly string[]): boolean {
  return tokens.some((token) =>
    /(^|[\\/])(?:\.env(?:\.|$)|\.netrc$|\.npmrc$|\.pypirc$|credentials?$|config\.json$|id_rsa$|id_ed25519$|known_hosts$|kubeconfig$|[^\\/]+\.pem$)|^env:/iu.test(
      token,
    ),
  );
}

/**
 * Applies fixed safety signals after conservative shell parsing.
 *
 * @param source Untrusted command under review.
 * @param dialect Shell syntax used by the tool.
 * @returns A manual decision for ambiguous or fixed high-risk commands.
 */
export function detectFixedHighRisk(source: string, dialect: ShellToolName): HighRiskAssessment {
  const parsed = parseShellCommand(source, dialect);
  if (!parsed.ok) return { status: "manual", signal: "ambiguous-shell" };

  for (const originalTokens of parsed.command.segments) {
    const command = basename(originalTokens[0]!);
    const tokens = lowerTokens(originalTokens);

    if (FILE_MUTATION_COMMANDS.has(command) || PERMISSION_COMMANDS.has(command)) {
      return { status: "manual", signal: "file-or-permission-change" };
    }
    if (SYSTEM_COMMANDS.has(command) || isPackageMutation(command, tokens)) {
      return { status: "manual", signal: "privilege-or-system-change" };
    }
    if (command === "git" && isGitMutation(tokens)) {
      return { status: "manual", signal: "destructive-version-control" };
    }
    if (
      DYNAMIC_COMMANDS.has(command) ||
      isDynamicInterpreter(command, originalTokens) ||
      ((command === "npm" || command === "pnpm" || command === "yarn") &&
        hasAny(tokens, ["dlx", "exec", "run", "run-script", "start"])) ||
      (command === "find" && hasAny(tokens, ["-exec", "-execdir"]))
    ) {
      return { status: "manual", signal: "dynamic-command-execution" };
    }
    if (
      CREDENTIAL_COMMANDS.has(command) ||
      (command === "gh" && isGhCredentialAccess(tokens)) ||
      referencesCredential(tokens)
    ) {
      return { status: "manual", signal: "credential-access" };
    }
    if (
      (command === "gh" && isGhMutation(tokens)) ||
      (command === "curl" && isCurlMutation(originalTokens)) ||
      isPowerShellWebMutation(command, tokens) ||
      ["rsync", "scp", "sftp", "ssh"].includes(command)
    ) {
      return { status: "manual", signal: "external-write" };
    }
  }

  return { status: "safe" };
}

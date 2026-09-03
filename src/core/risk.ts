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
  "clear-item",
  "clear-itemproperty",
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
  "set-item",
  "set-itemproperty",
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
  "stop-process",
  "sudo",
  "systemctl",
  "winget",
  "yum",
]);

const DYNAMIC_COMMANDS = new Set([
  ".",
  "awk",
  "builtin",
  "bunx",
  "busybox",
  "command",
  "corepack",
  "eval",
  "exec",
  "gawk",
  "iex",
  "import-module",
  "invoke-command",
  "invoke-expression",
  "mawk",
  "new-alias",
  "nice",
  "nohup",
  "npx",
  "parallel",
  "pnpx",
  "sed",
  "set-alias",
  "setsid",
  "source",
  "start-job",
  "start-process",
  "start-threadjob",
  "stdbuf",
  "time",
  "timeout",
  "trap",
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

const WINDOWS_SHIM_COMMANDS = new Set([
  "bun",
  "bunx",
  "corepack",
  "gh",
  "git",
  "npm",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "yarnpkg",
]);

const POWERSHELL_COMMAND_ALIASES = new Map<string, string>([
  ["ac", "add-content"],
  ["clc", "clear-content"],
  ["cli", "clear-item"],
  ["clp", "clear-itemproperty"],
  ["cpi", "copy-item"],
  ["icm", "invoke-command"],
  ["ipmo", "import-module"],
  ["kill", "stop-process"],
  ["md", "new-item"],
  ["mi", "move-item"],
  ["nal", "new-alias"],
  ["ni", "new-item"],
  ["ri", "remove-item"],
  ["rni", "rename-item"],
  ["sajb", "start-job"],
  ["sal", "set-alias"],
  ["saps", "start-process"],
  ["si", "set-item"],
  ["sp", "set-itemproperty"],
  ["start", "start-process"],
  ["spps", "stop-process"],
]);

const DIRECT_SCRIPT_EXTENSION = /\.(?:bash|bat|cjs|cmd|fish|js|jse|mjs|pl|ps1|psd1|psm1|py|pyw|rb|sh|vbe|vbs|wsf|wsh|zsh)$/iu;

interface CommandIdentity {
  readonly command: string;
  readonly forcedSignal?: HighRiskSignal;
}

function normalizeCommandIdentity(token: string, dialect: ShellToolName): CommandIdentity {
  const normalized = token.replace(/\\/gu, "/");
  const leaf = normalized.split("/").at(-1)!.toLocaleLowerCase("en-US");
  if (normalized.includes("/")) {
    return {
      command: leaf.replace(/\.exe$/iu, ""),
      forcedSignal: "dynamic-command-execution",
    };
  }

  const shim = leaf.match(/^(.*)\.(?:bat|cmd|ps1)$/u)?.[1];
  if (shim !== undefined) {
    if (!WINDOWS_SHIM_COMMANDS.has(shim)) {
      return { command: shim, forcedSignal: "dynamic-command-execution" };
    }
    return {
      command: dialect === "pwsh" ? POWERSHELL_COMMAND_ALIASES.get(shim) ?? shim : shim,
    };
  }

  if (DIRECT_SCRIPT_EXTENSION.test(leaf)) {
    return { command: leaf, forcedSignal: "dynamic-command-execution" };
  }

  const command = leaf.replace(/\.exe$/iu, "");
  return {
    command: dialect === "pwsh" ? POWERSHELL_COMMAND_ALIASES.get(command) ?? command : command,
  };
}

function lowerTokens(tokens: readonly string[]): string[] {
  return tokens.map((token) => token.toLocaleLowerCase("en-US"));
}

function hasAny(tokens: readonly string[], values: readonly string[]): boolean {
  const normalized = new Set(tokens);
  return values.some((value) => normalized.has(value));
}

const JAVASCRIPT_PACKAGE_MANAGERS = new Set(["bun", "npm", "pnpm", "yarn", "yarnpkg"]);
const PACKAGE_EXECUTORS = new Set(["bunx", "npx", "pnpx"]);
const PACKAGE_HELP_FLAGS = new Set(["--help", "--version", "-h", "-v"]);
const PACKAGE_READ_ONLY_ACTIONS = new Set([
  "explain",
  "help",
  "info",
  "list",
  "ls",
  "outdated",
  "ping",
  "prefix",
  "query",
  "root",
  "search",
  "show",
  "view",
  "whoami",
  "why",
]);
const PACKAGE_LIFECYCLE_ACTIONS = new Set([
  "dlx",
  "exec",
  "restart",
  "run",
  "run-script",
  "start",
  "stop",
  "t",
  "test",
  "x",
]);
const PACKAGE_MUTATION_ACTIONS = new Set([
  "add",
  "ci",
  "create",
  "dedupe",
  "i",
  "init",
  "install",
  "link",
  "pack",
  "prune",
  "rebuild",
  "remove",
  "rm",
  "un",
  "uninstall",
  "unlink",
  "up",
  "update",
  "upgrade",
  "version",
]);
const PACKAGE_EXTERNAL_WRITE_ACTIONS = new Set([
  "access",
  "deprecate",
  "dist-tag",
  "owner",
  "publish",
  "team",
  "unpublish",
]);

const SYSTEM_PACKAGE_READ_ONLY_ACTIONS = new Map<string, ReadonlySet<string>>([
  ["apt", new Set(["help", "list", "search", "show"])],
  ["apt-get", new Set(["check", "help"])],
  ["brew", new Set([
    "commands",
    "config",
    "deps",
    "doctor",
    "help",
    "info",
    "leaves",
    "list",
    "outdated",
    "search",
    "uses",
  ])],
  ["pip", new Set(["check", "debug", "freeze", "help", "index", "inspect", "list", "show"])],
  ["pip3", new Set(["check", "debug", "freeze", "help", "index", "inspect", "list", "show"])],
  ["scoop", new Set(["help", "info", "list", "prefix", "search", "status", "which"])],
]);

function systemPackageRisk(command: string, tokens: readonly string[]): HighRiskSignal | undefined {
  const readOnlyActions = SYSTEM_PACKAGE_READ_ONLY_ACTIONS.get(command);
  if (readOnlyActions === undefined) return undefined;

  const args = tokens.slice(1);
  if (args.length === 0 || args.every((token) => PACKAGE_HELP_FLAGS.has(token))) return undefined;
  const action = args[0];
  if (action === undefined || action.startsWith("-")) return "privilege-or-system-change";
  return readOnlyActions.has(action) ? undefined : "privilege-or-system-change";
}

function packageManagerRisk(command: string, tokens: readonly string[]): HighRiskSignal | undefined {
  if (PACKAGE_EXECUTORS.has(command)) return "dynamic-command-execution";
  if (!JAVASCRIPT_PACKAGE_MANAGERS.has(command)) return undefined;

  const args = tokens.slice(1);
  if (args.length > 0 && args.every((token) => PACKAGE_HELP_FLAGS.has(token))) return undefined;
  const action = args[0];
  if (action === undefined || action.startsWith("-")) return "dynamic-command-execution";
  if (PACKAGE_EXTERNAL_WRITE_ACTIONS.has(action)) return "external-write";
  if (PACKAGE_MUTATION_ACTIONS.has(action)) return "privilege-or-system-change";
  if (PACKAGE_LIFECYCLE_ACTIONS.has(action)) return "dynamic-command-execution";

  if (action === "audit") {
    return args.slice(1).some((token) => token === "fix" || token === "--fix")
      ? "privilege-or-system-change"
      : "external-write";
  }
  if (action === "config") {
    return args[1] === "set" || args[1] === "delete" || args[1] === "edit"
      ? "privilege-or-system-change"
      : "credential-access";
  }
  if (action === "pkg") {
    return args[1] === "get" ? undefined : "privilege-or-system-change";
  }
  if (action === "token") return "credential-access";
  if (command === "bun" && action === "pm") {
    return args[1] === "ls" || args[1] === "bin" ? undefined : "dynamic-command-execution";
  }
  return PACKAGE_READ_ONLY_ACTIONS.has(action) ? undefined : "dynamic-command-execution";
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

function hasNumericVersionSuffix(command: string, name: string): boolean {
  if (!command.startsWith(name)) return false;
  const suffix = command.slice(name.length);
  return suffix.length === 0 || suffix.split(".").every((part) => /^[0-9]+$/u.test(part));
}

function isScriptInterpreter(command: string): boolean {
  return SCRIPT_INTERPRETERS.has(command) ||
    command === "py" ||
    hasNumericVersionSuffix(command, "nodejs") ||
    hasNumericVersionSuffix(command, "perl") ||
    hasNumericVersionSuffix(command, "python") ||
    hasNumericVersionSuffix(command, "ruby");
}

function isDynamicInterpreter(command: string, tokens: readonly string[]): boolean {
  if (!isScriptInterpreter(command)) return false;
  if (tokens.length !== 2) return true;
  return !["--help", "--version", "/?"].includes(tokens[1]!);
}

const CREDENTIAL_OPTION = /^-{1,2}(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)(?:[=:].*)?$/iu;
const CREDENTIAL_FIELD = /^(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|password|passwd)[=:].+$/iu;
const CREDENTIAL_PATH_PATTERNS = [
  /(^|[\\/])\.env(?:\.[^\\/]+)?$/iu,
  /(^|[\\/])(?:\.netrc|\.npmrc|\.pypirc|authorized_keys|config\.json|credentials?|hosts\.yml|id_(?:dsa|ecdsa|ed25519|rsa)|known_hosts|kubeconfig|[^\\/]+\.pem)$/iu,
  /(^|[\\/])\.aws[\\/]credentials$/iu,
  /(^|[\\/])\.azure[\\/](?:accessTokens\.json|azureProfile\.json|msal_token_cache\.json)$/iu,
  /(^|[\\/])\.config[\\/]gcloud[\\/](?:application_default_credentials\.json|credentials\.db)$/iu,
  /(^|[\\/])\.config[\\/]gh[\\/]hosts\.yml$/iu,
  /(^|[\\/])\.kube[\\/]config$/iu,
  /(^|[\\/])\.ssh[\\/](?:authorized_keys|config|id_(?:dsa|ecdsa|ed25519|rsa)|known_hosts)$/iu,
] as const;

function credentialTokenViews(token: string, dialect: ShellToolName): readonly string[] {
  if (dialect !== "pwsh") return [token];
  const inlineValue = token.match(/^-{1,2}[A-Za-z][A-Za-z0-9-]*:(.*)$/u)?.[1];
  return inlineValue === undefined || inlineValue.length === 0 ? [token] : [token, inlineValue];
}

function referencesCredential(tokens: readonly string[], dialect: ShellToolName): boolean {
  return tokens.some((token) => credentialTokenViews(token, dialect).some((view) =>
    /^env:/iu.test(view) ||
    CREDENTIAL_OPTION.test(view) ||
    CREDENTIAL_FIELD.test(view) ||
    /authorization\s*:/iu.test(view) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/u.test(view) ||
    CREDENTIAL_PATH_PATTERNS.some((pattern) => pattern.test(view)),
  ));
}

function findRisk(tokens: readonly string[]): HighRiskSignal | undefined {
  if (hasAny(tokens, ["-delete", "-fls", "-fprint", "-fprint0", "-fprintf"])) {
    return "file-or-permission-change";
  }
  if (hasAny(tokens, ["-exec", "-execdir", "-ok", "-okdir"])) {
    return "dynamic-command-execution";
  }
  return undefined;
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
    const identity = normalizeCommandIdentity(originalTokens[0]!, dialect);
    if (identity.forcedSignal !== undefined) {
      return { status: "manual", signal: identity.forcedSignal };
    }
    const command = identity.command;
    const tokens = lowerTokens(originalTokens);

    if (FILE_MUTATION_COMMANDS.has(command) || PERMISSION_COMMANDS.has(command)) {
      return { status: "manual", signal: "file-or-permission-change" };
    }
    if (SYSTEM_COMMANDS.has(command)) {
      return { status: "manual", signal: "privilege-or-system-change" };
    }
    const systemRisk = systemPackageRisk(command, tokens);
    if (systemRisk !== undefined) {
      return { status: "manual", signal: systemRisk };
    }
    const packageRisk = packageManagerRisk(command, tokens);
    if (packageRisk !== undefined) return { status: "manual", signal: packageRisk };
    if (command === "git" && isGitMutation(tokens)) {
      return { status: "manual", signal: "destructive-version-control" };
    }
    const commandFindRisk = command === "find" ? findRisk(tokens) : undefined;
    if (commandFindRisk !== undefined) return { status: "manual", signal: commandFindRisk };
    if (
      DYNAMIC_COMMANDS.has(command) ||
      isDynamicInterpreter(command, originalTokens)
    ) {
      return { status: "manual", signal: "dynamic-command-execution" };
    }
    if (
      CREDENTIAL_COMMANDS.has(command) ||
      (command === "gh" && isGhCredentialAccess(tokens)) ||
      referencesCredential(tokens, dialect)
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

import { describe, expect, it } from "vitest";

import {
  buildReviewerPrompt,
  detectFixedHighRisk,
  evaluateCommandRules,
  parseShellCommand,
  sanitizeUntrustedText,
} from "../../src/core/index.ts";

describe("beta.2 shell parser regressions", () => {
  it.each([
    "FOO+=bar rm -rf x",
    "_VALUE+=suffix git status",
  ])("routes leading append assignment %s to manual", (command) => {
    expect(parseShellCommand(command, "shell")).toEqual({
      ok: false,
      reason: "environment-assignment",
    });
  });

  it("does not reject assignment-like text after the command token", () => {
    expect(parseShellCommand("echo NAME+=value", "shell")).toMatchObject({ ok: true });
  });
});

describe("beta.2 fixed-risk regressions", () => {
  it.each([
    ["npm.cmd install package", "shell", "privilege-or-system-change"],
    ["git.cmd push", "shell", "destructive-version-control"],
    ["npx.cmd package", "shell", "dynamic-command-execution"],
    [".\\evil.ps1 arg", "pwsh", "dynamic-command-execution"],
    ["script.bat", "pwsh", "dynamic-command-execution"],
    ["/usr/bin/git status", "shell", "dynamic-command-execution"],
    ["exec rm -rf x", "shell", "dynamic-command-execution"],
    ["builtin eval rm", "shell", "dynamic-command-execution"],
    ["busybox sh -c rm", "shell", "dynamic-command-execution"],
    ["Invoke-Command -FilePath .\\evil.ps1", "pwsh", "dynamic-command-execution"],
    ["Start-Job -FilePath .\\evil.ps1", "pwsh", "dynamic-command-execution"],
    ["ni secret.txt", "pwsh", "file-or-permission-change"],
    ["ri secret.txt", "pwsh", "file-or-permission-change"],
    ["sp target Name value", "pwsh", "file-or-permission-change"],
    ["Stop-Process -Name dsh", "pwsh", "privilege-or-system-change"],
    ["kill 1234", "pwsh", "privilege-or-system-change"],
    ["spps -Id 1234", "pwsh", "privilege-or-system-change"],
    ["md newdir", "pwsh", "file-or-permission-change"],
  ] as const)("normalizes or rejects executable identity in %s", (command, dialect, signal) => {
    expect(detectFixedHighRisk(command, dialect)).toEqual({ status: "manual", signal });
  });

  it.each([
    ["npm test", "dynamic-command-execution"],
    ["pnpm test --run core", "dynamic-command-execution"],
    ["pnpm build", "dynamic-command-execution"],
    ["yarn start", "dynamic-command-execution"],
    ["bun test", "dynamic-command-execution"],
    ["npm init -y", "privilege-or-system-change"],
    ["npm version patch", "privilege-or-system-change"],
    ["npm audit fix", "privilege-or-system-change"],
    ["npm audit --fix", "privilege-or-system-change"],
    ["npm publish", "external-write"],
    ["npm audit", "external-write"],
    ["pnpm audit", "external-write"],
    ["apt purge package", "privilege-or-system-change"],
    ["apt-get autoremove", "privilege-or-system-change"],
    ["pip config set global.index-url https://example.test", "privilege-or-system-change"],
    ["pip cache purge", "privilege-or-system-change"],
    ["brew tap owner/repo", "privilege-or-system-change"],
  ] as const)("routes package-manager action %s to manual", (command, signal) => {
    expect(detectFixedHighRisk(command, "shell")).toEqual({ status: "manual", signal });
  });

  it.each([
    "git.cmd status --short",
    "npm.cmd --version",
    "npm view package-name",
    "pnpm list",
    "yarn info package-name",
    "bun pm ls",
    "apt list --upgradable",
    "apt-get check",
    "brew list",
    "pip list",
    "scoop status",
  ])("retains an explicit package or shim read-only case %s", (command) => {
    expect(detectFixedHighRisk(command, "shell")).toEqual({ status: "safe" });
  });

  it.each([
    ["find . -delete", "file-or-permission-change"],
    ["find . -fprint output.txt", "file-or-permission-change"],
    ["find . -exec echo value +", "dynamic-command-execution"],
    ["find . -ok echo value +", "dynamic-command-execution"],
  ] as const)("routes find action %s to manual", (command, signal) => {
    expect(detectFixedHighRisk(command, "shell")).toEqual({ status: "manual", signal });
  });

  it("retains a read-only find expression", () => {
    expect(detectFixedHighRisk("find . -type f -print", "shell")).toEqual({ status: "safe" });
  });

  it.each([
    ["Get-Content -Path:Env:DEEPSEEK_API_KEY", "pwsh"],
    ["Get-Content -LiteralPath:Env:DEEPSEEK_API_KEY", "pwsh"],
    ["Get-ChildItem -Path:Env:", "pwsh"],
    ["Get-Content -Path:C:\\Users\\me\\.ssh\\id_rsa", "pwsh"],
    ["cat ~/.ssh/id_ecdsa", "shell"],
    ["cat ~/.kube/config", "shell"],
    ["cat ~/.config/gh/hosts.yml", "shell"],
    ["cat ~/.aws/credentials", "shell"],
    ["mysql --password hunter2", "shell"],
    ["tool --token secret-value", "shell"],
    ["Invoke-X -Token secret-value", "pwsh"],
  ] as const)("routes credential input %s to manual", (command, dialect) => {
    expect(detectFixedHighRisk(command, dialect)).toEqual({
      status: "manual",
      signal: "credential-access",
    });
  });

  it.each([
    ["Get-Content -Path:README.md", "pwsh"],
    ["Get-ChildItem -Path:.", "pwsh"],
  ] as const)("does not confuse ordinary inline paths with credentials in %s", (command, dialect) => {
    expect(detectFixedHighRisk(command, dialect)).toEqual({ status: "safe" });
  });

  it("keeps fixed risk ahead of a matching literal prefix", () => {
    const rules = [{ tool: "shell" as const, prefix: "find ." }];
    expect(evaluateCommandRules("find . -delete", "shell", rules)).toMatchObject({ status: "matched" });
    expect(detectFixedHighRisk("find . -delete", "shell")).toEqual({
      status: "manual",
      signal: "file-or-permission-change",
    });
  });
});

describe("beta.2 reviewer redaction regressions", () => {
  it("redacts an unclosed private-key block created by the truncation boundary", () => {
    const source = [
      "x".repeat(430),
      "-----BEGIN OPENSSH PRIVATE KEY-----\n",
      "A".repeat(3_000),
      "\n-----END OPENSSH PRIVATE KEY-----",
    ].join("");
    const sanitized = sanitizeUntrustedText(source, 500);

    expect(sanitized.truncated).toBe(true);
    expect(sanitized.text).toContain("[REDACTED]");
    expect(sanitized.text).toContain("[TRUNCATED]");
    expect(sanitized.text).not.toContain("BEGIN OPENSSH PRIVATE KEY");
    expect(sanitized.text).not.toContain("AAAA");
    expect(sanitized.text.length).toBeLessThanOrEqual(500);
  });

  it("redacts generic PKCS8 private keys without consuming following text", () => {
    expect(sanitizeUntrustedText(
      "-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY----- tail",
      500,
    ).text).toBe("[REDACTED] tail");
  });

  it("redacts quoted and unquoted CLI credential values", () => {
    const sanitized = sanitizeUntrustedText(
      "mysql --password hunter2 tool --token \"abc def\" Invoke-X -Token 'secret value'",
      500,
    ).text;

    expect(sanitized).toContain("--password [REDACTED]");
    expect(sanitized).toContain('--token "[REDACTED]"');
    expect(sanitized).toContain("-Token '[REDACTED]'");
    expect(sanitized).not.toContain("hunter2");
    expect(sanitized).not.toContain("abc def");
    expect(sanitized).not.toContain("secret value");
  });

  it("redacts assignment-style quoted credential values", () => {
    const sanitized = sanitizeUntrustedText(
      [
        'tool --token="alpha beta"',
        "Invoke-X -Secret:'gamma delta'",
        'api_key="epsilon zeta"',
        "app --password='unterminated value",
      ].join(" "),
      500,
    ).text;

    expect(sanitized).not.toContain("alpha beta");
    expect(sanitized).not.toContain("gamma delta");
    expect(sanitized).not.toContain("epsilon zeta");
    expect(sanitized).not.toContain("unterminated value");
  });

  it("redacts request fields before JSON serialization", () => {
    const result = buildReviewerPrompt({
      reviewerInstructions: "",
      trustedTranscript: [],
      untrustedRequest: {
        toolName: "bash",
        command: 'tool --token "alpha beta gamma"',
        justification: 'mysql --password "hunter two"',
        reason: "api --secret 'unfinished value",
      },
      limits: {
        trustedTranscriptChars: 2_000,
        untrustedToolDataChars: 2_000,
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const requestMessage = result.messages[1]?.content ?? "";
    expect(requestMessage).not.toContain("alpha beta gamma");
    expect(requestMessage).not.toContain("hunter two");
    expect(requestMessage).not.toContain("unfinished value");
    expect(requestMessage).toContain("[REDACTED]");
  });
});

# dsh-approve-for-me - Automatic sandbox approval for DeepSeek Harness

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-approve-for-me)](https://www.npmjs.com/package/dsh-approve-for-me)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Rules define the boundary. An optional LLM reviews matching requests. Everything uncertain returns to native human approval.**

`dsh-approve-for-me` is a DeepSeek Harness plugin for rule-gated automatic approval of Shell and PowerShell sandbox escalations. It applies fixed high-risk checks, literal command-prefix rules, and an optional tool-free LLM reviewer. Every successful decision grants one `allowed-once`; it never grants permanent access.

Version `0.2.5` declares compatibility with DeepSeek Harness `0.1.1-rc.2`, `0.1.2-alpha.1`, `0.1.2-alpha.4`, and `0.1.2-rc.1`. These versions use the keyed third-party settings-card slot and shared client settings schema service.

> [!WARNING]
> This is an unofficial plugin. It has not received an independent security audit and comes without warranty. Built-in checks cannot cover every command, argument, wrapper, or environment. Keep allowlists narrow and retain Harness's native human approval for important operations.

## Quick start

```powershell
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add dsh-approve-for-me@latest
dsh web --host 127.0.0.1 --port 3080
```

Then:

1. Open `Settings -> Plugins -> Plugin configuration -> Approve for me`.
2. Add only command prefixes you are willing to review automatically.
3. Select the `Approve for me` Access preset for the target agent or session.

> [!IMPORTANT]
> `commandPrefixes` is empty by default. Installing the plugin alone does not automatically approve any command.

`@latest` is an npm dist-tag, not a fixed version. Use `@beta` only when you explicitly want the beta channel. Use `@<version>` for reproducible installation or rollback. Do not use the bare package name as the recommended upgrade command: an existing Profile can remain pinned while pnpm reports `Already up to date`.

## Why use it

| Access option | Sandbox escalation behavior |
| --- | --- |
| Native Harness approval | Ask the user for every escalation |
| `Approve for me` | Evaluate fixed checks and user rules, optionally ask an LLM, then return uncertain requests to the user |
| `Full access` | Remove the sandbox approval boundary |

Rules establish the largest possible auto-approval set. The reviewer may narrow that set, but cannot bypass rules or fixed high-risk checks.

## Web configuration

Add narrow, literal prefixes such as:

```text
Shell:      git status
Shell:      git diff
PowerShell: Get-Location
PowerShell: Get-Content -LiteralPath README.md
```

A prefix is a parsed token prefix, not exact string equality. Additional arguments can follow, so include the subcommand and path whenever possible. Every segment of a compound command must match independently.

Known package lifecycle actions, path-qualified executables, direct scripts, wrappers, mutating PowerShell aliases, ambiguous parsing, and fixed high-risk patterns return to human approval even when a prefix appears to match.

The Web card is optional. The client registers the keyed `settings.plugin.item` slot with key `approve-for-me` and consumes Harness's shared settings schema service. The card uses the plugin RPC registered on Harness's authenticated Connection, inheriting Connection authentication and Host/Origin protections; PR1 does not claim an additional plugin-owned loopback-only boundary. Persistence, schema validation, revision conflicts, redaction, and hot reload remain owned by Harness's Settings service. The card does not make approval decisions and does not depend on `llm-pi-ai`.

Check the package actually installed in the Profile:

```powershell
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

Confirm that a matching read-only escalation can receive one-time approval, while an unmatched or high-risk request still opens native human approval. Switching away from the `Approve for me` preset disables the plugin for that session.

## Install and update

Plugins and settings are Profile-specific. Install the plugin separately for `web`, `headless`, `tui`, or a custom Profile.

```powershell
# Web settings card and Host approval core
dsh plugin --profile web add dsh-approve-for-me@latest

# Host approval core without the Web settings card
dsh plugin --profile headless add dsh-approve-for-me@latest

# Inspect effective wiring
dsh --profile web --dump-config
dsh --profile headless --dump-config

# Remove from one Profile
dsh plugin --profile web remove dsh-approve-for-me
```

The config dump should contain the `approve-for-me` permission preset and Host plugin entry.

### Upgrade a running Web Profile

1. Stop the terminal running `dsh web` with `Ctrl+C`.
2. Request the current `latest` dist-tag.
3. Verify the installed version.
4. Restart the Host.
5. Refresh the browser after the Host is running again.

```powershell
dsh plugin --profile web add dsh-approve-for-me@latest
dsh plugin --profile web list dsh-approve-for-me --depth 0
dsh web --host 127.0.0.1 --port 3080
```

A browser refresh does not reload the Host process or update the Profile lockfile.

If `@latest` does not update the Profile, request the exact published version:

```powershell
$version = '<published-version>'
dsh plugin --profile web add "dsh-approve-for-me@$version"
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

If it remains pinned, keep the Host stopped, remove the dependency, and add it again:

```powershell
dsh plugin --profile web remove dsh-approve-for-me
dsh plugin --profile web add dsh-approve-for-me@latest
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

Use `dsh plugin --profile web add dsh-approve-for-me@beta` for beta testing. Update `headless` and other Profiles separately.

## YAML configuration

The Web page and `$DSH_HOME\settings.yaml` edit the same `approve-for-me` settings. Web configuration is optional.

### Recommended: rules and the current session model

Omit `reviewer.provider` and `reviewer.model`. Each review inherits the provider and model of the session that requested approval.

```yaml
approve-for-me:
  version: 1
  mode: rules-and-llm
  rules:
    commandPrefixes:
      - tool: shell
        prefix: git status
      - tool: shell
        prefix: git diff
      - tool: pwsh
        prefix: Get-Content -LiteralPath README.md
    reviewerInstructions: >-
      Only allow read-only repository inspection.
  reviewer:
    timeoutMs: 30000
  limits:
    trustedTranscriptChars: 12000
    untrustedToolDataChars: 8000
    reviewerOutputChars: 2000
```

If the request session has no complete provider/model route, the reviewer cannot allow the request and it returns to human approval.

To pin a route, set both identifiers:

```yaml
reviewer:
  provider: your-provider-id
  model: your-model-id
  timeoutMs: 30000
```

Harness continues to own provider credentials. The plugin stores only provider/model identifiers.

To avoid model calls, set `mode: rules-only`. Correlation checks, parsing, fixed high-risk checks, and command rules still apply.

### Limits

| Field | Default | Constraint |
| --- | --- | --- |
| `mode` | `rules-and-llm` | `rules-only` or `rules-and-llm` |
| `rules.commandPrefixes` | `[]` | At most 200 entries; tool is `shell` or `pwsh` |
| One `prefix` | None | One non-empty literal command segment, up to 1,000 characters |
| `rules.reviewerInstructions` | `''` | Up to 8,000 characters |
| `reviewer.timeoutMs` | `30000` | 1,000 to 120,000 milliseconds |
| Reviewer content limits | `12000 / 8000 / 2000` | Each value is 256 to 100,000 characters |
| `reviewer.provider/model` | Current session | Set both or omit both |

An in-progress review keeps the settings snapshot captured at its start. Hot reload affects later requests.

## Safety model

Default behavior:

- Mode is `rules-and-llm`.
- Reviewer provider/model comes from the requesting session.
- Positive command rules are empty.
- Fixed high-risk checks run before user rules and the reviewer.
- Every review uses a fresh agent with no tools.
- Failure, timeout, invalid output, ambiguity, or mismatch returns to human approval.

Decision order:

1. The active Access preset is `approve-for-me`.
2. The request is a supported Shell or PowerShell escalation strictly correlated with the active tool call.
3. The command passes fixed high-risk checks.
4. Every command segment matches a literal prefix rule for its tool.
5. `rules-only` returns one `allowed-once`; `rules-and-llm` also requires an explicit schema-valid `allow`.

Built-in checks cover a finite set of common risks, including parsing failures, file or permission mutation, system and package changes, mutating Git/GitHub actions, package lifecycle scripts, path-qualified executables, dynamic command execution, credential access, and external writes. They are conservative classifiers, not proof that an unflagged command is safe.

A high-risk result stops automatic approval and returns the request to Harness. It is not a direct denial.

### Permissions and data

| Area | Behavior |
| --- | --- |
| Approval context | Reads the current escalation, correlated tool call, and a length-bounded transcript |
| Reviewer input | Separates trusted guidance from untrusted tool data, limits content, and redacts common credential formats |
| Reviewer capability | Fresh agent with no tools |
| Network | Uses the provider route already configured in Harness |
| Web writes | Authenticated Connection RPC delegates persistence to the Settings service |
| Approval scope | One `allowed-once` for the current request |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Approve for me` is missing from Access | Install in the active Profile, restart it, and inspect `--dump-config` |
| The settings card is missing | Use the `web` Profile through its authenticated Connection URL |
| A matching command still asks | Check every compound segment, high-risk signals, tool type, and reviewer result |
| The reviewer did not run | Confirm `rules-and-llm`, a complete rule match, and a valid session model route |
| Provider/model validation fails | Set both identifiers or clear both |
| Saving reports a revision conflict | Reload the card, edit the latest value, and save again |
| Installation reports peer warnings | Confirm Harness `0.1.1-rc.2`, `0.1.2-alpha.1`, `0.1.2-alpha.4`, or `0.1.2-rc.1` compatibility and run `pnpm check` |
| Another Profile does not work | Install and configure the plugin in that Profile |

## FAQ

### How do I automatically approve DeepSeek Harness sandbox escalations?

Install the plugin, add narrow command prefixes, and select the `Approve for me` Access preset. Only strictly correlated requests that pass fixed checks and configured review are approved once.

### Does it replace `Full access`?

No. It keeps the sandbox boundary and returns uncertain requests to Harness's native approval.

### Are there built-in rules?

There are fixed high-risk checks, but no built-in positive allowlist. Your allowlist must reflect the project and threat model.

### Does it directly reject high-risk commands?

No. Version `0.2.4` stops automatic approval and hands the decision back to the user.

### Can the reviewer expand the allowlist?

No. Rules define the maximum candidate set. The reviewer can only allow a matching candidate or return it to the user.

### Does it work headlessly?

Yes. Install it in the `headless` Profile and configure YAML. The approval core does not require the Web card.

## Compatibility

| Component | Baseline |
| --- | --- |
| DeepSeek Harness compatibility | `0.1.1-rc.2`, `0.1.2-alpha.1`, `0.1.2-alpha.4`, `0.1.2-rc.1` |
| Node.js | `^22.19.0 || >=24.0.0` |
| Cordis | `^4.0.1` |
| npm channel | `@latest` for stable releases; `@beta` for beta testing |

Version `0.2.5` keeps the keyed settings-card integration, adapts the Settings, Session event, and permission-preset API differences, and preserves the existing approval and native fallback behavior on Harness `0.1.2-rc.1`. The Settings RPC is registered through Connection and uses Connection's authentication and Host/Origin protections; it is not documented as having a separate plugin-owned loopback-only restriction.

## Development and verification

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm typecheck:harness  # after setting DSH_HARNESS_ROOT
pnpm test:coverage
npm pack --dry-run --json --ignore-scripts
```

To run source-level client tests against a specific Harness checkout:

```powershell
$env:DSH_HARNESS_ROOT = 'H:\path\to\deepseek-harness'
$env:DSH_HARNESS_TSCONFIG = 'H:\path\to\deepseek-harness\tsconfig.base.json'
pnpm test
```

The generated Harness typecheck tsconfig is temporary and ignored by Git. Use a fresh `DSH_HOME` for runtime verification.

### Local tarball

```powershell
npm pack --json
$package = Get-ChildItem '.\dsh-approve-for-me-*.tgz' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
dsh plugin --profile web add $package.FullName
```

### Publishing tags

Stable releases use `publishConfig.tag: latest`, so `npm publish` updates `latest`. Publish prereleases with `npm publish --tag beta`; this updates `beta` without moving `latest`.

## Security and license

Report vulnerabilities privately through GitHub Security Advisories. Do not submit API keys, credentials, complete prompts, private paths, or unredacted tool arguments. See [SECURITY.md](SECURITY.md).

Thanks to the [LINUX DO](https://linux.do/) community for its help and feedback.

Licensed under the [MIT License](LICENSE).

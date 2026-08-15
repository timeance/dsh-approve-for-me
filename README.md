# dsh-approve-for-me

English | [中文](README.zh.md)

[![npm](https://img.shields.io/npm/v/dsh-approve-for-me)](https://www.npmjs.com/package/dsh-approve-for-me)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**Rules set the boundary. The current session model reviews candidates. Anything uncertain goes back to you.**

`dsh-approve-for-me` is a sandbox escalation approval plugin built and verified against DeepSeek Harness `0.1.0-rc.6`; newer Harness releases will be tracked after validation. It reduces repeated confirmations for predictable commands while retaining Harness's native human approval as the fallback.

Literal prefix allowlist | fixed high-risk checks | tool-free LLM reviewer | native human fallback

> [!WARNING]
> This is an unofficial beta plugin. It has not received an independent security audit and comes without warranty. Built-in checks cannot cover every command, argument, or environment. Keep rules narrow and retain Harness's native human approval as the final decision for important operations.

## Why use it

| Access option | Sandbox escalation requests | Best suited for |
| --- | --- | --- |
| Native Harness approval | Ask the user every time | Varied commands that require direct judgment |
| `Approve for me` | Apply rules, optionally ask a model, and return uncertain cases to the user | Repeated workflows with clear boundaries |
| `Full access` | Remove the sandbox approval boundary | Environments where full-access risk is already accepted |

Rules determine which requests are eligible for automatic review. The LLM reviewer can narrow that set but cannot bypass rules or fixed high-risk checks. A successful decision grants only one `allowed-once`, never permanent access.

## Quick start

### 1. Install

Install DeepSeek Harness, then add the plugin to the Profile where it will run:

```powershell
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add dsh-approve-for-me
```

The current release is `0.1.0-beta.2`. npm's `latest` tag points to this release, so the install command does not need `@beta`; use `dsh-approve-for-me@beta` only when you want to follow the beta tag explicitly.

### 2. Configure

Start the loopback Web Profile:

```powershell
dsh --profile web --host 127.0.0.1 --port 3080
```

Open `Settings -> Plugins -> Plugin configuration -> Approve for me` and add only the command prefixes you are willing to review automatically, for example:

```text
Shell:      git status
Shell:      git diff
PowerShell: Get-Location
PowerShell: Get-Content
```

Select the `Approve for me` Access preset for the target agent or session.

> [!IMPORTANT]
> `commandPrefixes` is empty by default. Installing the plugin alone does not automatically approve any command; the user must define positive rules first.

### 3. Verify

Trigger a read-only command that would normally request sandbox escalation and matches a configured prefix. Confirm that:

1. A matching request approved by the reviewer receives one-time approval.
2. An unmatched or high-risk request still shows native human approval.
3. Switching to another Access preset disables the plugin for that session.

The plugin does not participate when no sandbox escalation occurs.

## Default safety baseline

The installed defaults are:

- Mode: `rules-and-llm`.
- Reviewer provider/model: inherited from the session that made the current approval request.
- Reviewer timeout: 30 seconds.
- Positive command rules: empty, so no command is automatically approved by default.
- Fixed high-risk checks: always run before user rules and the reviewer.
- Reviewer: a fresh, tool-free agent for every request.

Built-in high-risk checks cover conservative shell parsing failures and common file or permission mutations, system or package changes, mutating Git/GitHub operations, dynamic command execution, credential access, and external writes.

A high-risk result means **do not auto-approve and ask the user**. It is not a direct denial. This prevents a generic policy from making irreversible decisions on the user's behalf.

## How decisions are made

Each request passes through these steps:

1. The active Access preset must be `approve-for-me`.
2. The request must be a supported Shell or PowerShell sandbox escalation strictly correlated with the active tool call.
3. The command must pass fixed high-risk checks.
4. Every command segment must match a literal prefix rule for its tool.
5. `rules-only` stops here; `rules-and-llm` also requires an explicit, schema-valid `allow` from the reviewer.

| Result | Plugin action |
| --- | --- |
| High-risk signal, ambiguous parsing, or correlation failure | Fall through to native human approval |
| Any command segment is unmatched | Fall through to native human approval |
| Complete match in `rules-only` | Return one `allowed-once` |
| Reviewer explicitly allows | Return one `allowed-once` |
| Reviewer denies, escalates, times out, fails, or returns invalid output | Fall through to native human approval |

Prefixes are parsed and validated literal command prefixes, not regular expressions. Every segment of a compound command must satisfy a rule independently.

## Installation and Profiles

Plugins are installed per Profile. `web`, `headless`, `tui`, and custom Profiles do not inherit each other's installation or settings.

```powershell
# Web settings page and Host approval core
dsh plugin --profile web add dsh-approve-for-me

# Host approval core without a Web page
dsh plugin --profile headless add dsh-approve-for-me

# Update the version installed in this Profile
dsh plugin --profile web add dsh-approve-for-me

# Remove
dsh plugin --profile web remove dsh-approve-for-me
```

After installation or update, restart the corresponding Profile and inspect its effective configuration:

```powershell
dsh --profile web --dump-config
dsh --profile headless --dump-config
```

The dump should include the `approve-for-me` permission preset and plugin Host entry.

### Install a local tarball

```powershell
pnpm install --frozen-lockfile
npm pack --json

$package = (Resolve-Path '.\dsh-approve-for-me-0.1.0-beta.2.tgz').Path
dsh plugin --profile web add $package
```

When running from a Harness source checkout, build Harness first and use that repository's `pnpm dsh ...` command.

## Configuration

The Web settings page and `$DSH_HOME\settings.yaml` edit the same `approve-for-me` settings. Web is optional; a headless environment can use YAML only.

### Recommended: rules + current session model

Omit `reviewer.provider` and `reviewer.model`. Each review inherits the session provider/model attached to that approval request:

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
        prefix: Get-Content
    reviewerInstructions: >-
      Only allow read-only repository inspection.
  reviewer:
    timeoutMs: 30000
```

If the requesting session has no complete provider/model route, the reviewer cannot allow the request and it falls through to human approval.

### Pin a reviewer route

Set both fields under `reviewer`:

```yaml
reviewer:
  provider: your-provider-id
  model: your-model-id
  timeoutMs: 30000
```

`provider` and `model` must be set together or omitted together. The plugin stores identifiers only; Harness continues to own model credentials.

### Use rules only

```yaml
approve-for-me:
  version: 1
  mode: rules-only
  rules:
    commandPrefixes:
      - tool: shell
        prefix: git status
      - tool: pwsh
        prefix: Get-Location
    reviewerInstructions: ''
```

`rules-only` does not call a model. Correlation checks, conservative parsing, and fixed high-risk checks still apply.

### Field limits

| Field | Default | Constraint |
| --- | --- | --- |
| `mode` | `rules-and-llm` | `rules-only` or `rules-and-llm` |
| `rules.commandPrefixes` | `[]` | At most 200 entries; tool must be `shell` or `pwsh` |
| One `prefix` | None | Non-empty literal command segment, up to 1,000 characters |
| `rules.reviewerInstructions` | `''` | Up to 8,000 characters |
| `reviewer.timeoutMs` | `30000` | 1,000 to 120,000 milliseconds |
| `reviewer.provider/model` | Current session | Set both or omit both |

Optional content-bound defaults:

```yaml
approve-for-me:
  limits:
    trustedTranscriptChars: 12000
    untrustedToolDataChars: 8000
    reviewerOutputChars: 2000
```

A review already in progress uses the settings snapshot captured at its start. Hot reload affects later requests only.

## Web settings

On rc.6, the client registers a `settings.plugin.item` card under the real plugin id `approve-for-me`. The card appears only on loopback connections and reads or writes through the plugin's loopback-only RPC.

The Host delegates persistence, schema validation, revision conflict handling, redaction, and hot reload to the official Harness Settings service. The Web card makes no approval decisions and neither depends on nor impersonates `llm-pi-ai`.

## Permissions and data

| Area | Behavior |
| --- | --- |
| Approval context | Reads the current escalation, correlated tool call, and a length-bounded transcript |
| Reviewer input | Separates trusted guidance from untrusted tool data, bounds content, and redacts common credential formats |
| Reviewer capability | Uses a fresh agent with no tools |
| Model route | Inherits the current session or uses explicit provider/model identifiers; Harness owns credentials |
| Web writes | A loopback-only RPC delegates persistence to the official Settings service |
| Network | Model requests use the provider route configured in Harness; plugin Web RPC is unavailable to non-loopback clients |
| Approval scope | Returns one `allowed-once` for the current request only |

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `Approve for me` is missing from Access | Confirm the plugin is installed in the active Profile, restart it, and inspect `--dump-config` |
| The Web settings card is missing | Use the `web` Profile through `127.0.0.1` or another loopback address |
| A matching command still asks | Check every compound-command segment, high-risk signals, tool type, and reviewer outcome |
| The reviewer did not run | Confirm mode is not `rules-only`, rules matched, and the request session has a complete model route |
| provider/model validation fails | Set both fields; clear both to inherit the current session |
| Saving reports a revision conflict | Reload the card, edit the latest value, and save again |
| Installation reports peer warnings | Check the current Harness version against the plugin compatibility baseline, currently `0.1.0-rc.6`. Then run `pnpm peers check` as prompted; do not ignore real version conflicts |
| Web works but another Profile does not | Install and configure the plugin separately in every Profile |

## FAQ

### How does DeepSeek Harness automatically review sandbox escalations?

Install the plugin, define command prefixes, and select the `Approve for me` Access preset. The plugin grants one-time approval only to strictly correlated requests that pass fixed checks, positive rules, and the configured review mode. Everything else remains a human decision.

### Are there built-in rules that work out of the box?

There are non-configurable high-risk checks, but no built-in positive allowlist. The former prevents common high-risk requests from being auto-approved. The latter must reflect the user's project and threat model.

### Does the plugin directly deny high-risk commands?

No. The current implementation stops automatic approval and falls through to Harness's native human approval. It does not make the final denial on the user's behalf.

### Can the LLM reviewer expand the rule boundary?

No. Rules establish the maximum candidate set first. The reviewer can allow a candidate or return it to the user, but cannot admit an unmatched request.

### What does "inherit the current session model" mean?

When `reviewer.provider` and `reviewer.model` are omitted, the plugin reads the provider/model of the session associated with the current approval. Different sessions can therefore use different reviewer routes.

### Does it work in both Web and headless Profiles?

Yes, after separate installation. The Web card is an optional configuration surface; the Host approval core does not require a browser.

### Do I need `llm-pi-ai`?

No. The plugin owns its namespace, Web card, and RPC and uses Harness's subagent/provider services for model calls.

## Compatibility

| Component | Status |
| --- | --- |
| DeepSeek Harness | Development and verification baseline: `0.1.0-rc.6`; newer releases are tracked after validation |
| Node.js | `^22.19.0 || >=24.0.0` |
| Cordis | `^4.0.1` |
| npm channel | Current release: `0.1.0-beta.2` |

The permission patch preserves Harness's `Read Only`, `Workspace Write`, and `Full access` presets and appends `Approve for me`.

## Development and verification

```powershell
pnpm install --frozen-lockfile
pnpm peers check
pnpm typecheck
pnpm test
pnpm test:coverage
pnpm build
pnpm check
npm pack --dry-run --json
npm pack --json
```

Use a fresh, isolated `DSH_HOME` for runtime verification. Check the Web card, persistence, YAML hot reload, session-model inheritance, and non-Web Host activation separately.

## Security and license

Report vulnerabilities privately through GitHub Security Advisories. Do not submit API keys, credentials, complete prompts, private paths, or unredacted tool arguments. See [SECURITY.md](SECURITY.md).

This project is licensed under the [MIT License](LICENSE).

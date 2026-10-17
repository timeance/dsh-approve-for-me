# dsh-approve-for-me

[中文](README.md) | English

[![npm](https://img.shields.io/npm/v/dsh-approve-for-me)](https://www.npmjs.com/package/dsh-approve-for-me)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

Provides automatic approval for DeepSeek Harness, with a conservative approach to safety. The plugin checks risks and command rules, then optionally calls a model for review. A successful decision grants one `allowed-once` for the current request. Unmatched, risky, or uncertain requests return to Harness's native human approval.

> [!IMPORTANT]
> Command rules are empty by default. After installation, add rules and select the `Approve for me` Access preset for the plugin to participate in approval.

> [!WARNING]
> This is an unofficial DeepSeek plugin. It has not received an independent security audit and comes without warranty. Built-in checks cannot cover every command, argument, or environment. Keep allowlists narrow and retain human approval for important operations.

## Quick start

```powershell
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add dsh-approve-for-me@latest
dsh web --host 127.0.0.1 --port 3080
```

1. Open configuration: on DSH 0.2, select `dsh-approve-for-me` in `Plugins`; on older versions, use `Settings -> Plugins -> Plugin configuration -> Approve for me`.
2. Add command prefixes eligible for automatic review, such as `git status` or `git diff`.
3. Select the `Approve for me` Access preset for the target agent or session.

<img width="560" alt="Approve for me settings page" src="https://github.com/user-attachments/assets/ba3df97b-3d35-47b7-a8a4-cd7772c48eb6" />

## Configure command rules

Example rules:

```text
Shell:      git status
Shell:      git diff
PowerShell: Get-Location
PowerShell: Get-Content -LiteralPath README.md
```

Matching uses parsed command token prefixes, so additional arguments can follow. Include subcommands and paths where possible; avoid broad prefixes such as `git` or `npm`. Every segment of a compound command must match a rule for its tool.

Even when a prefix matches, package lifecycle actions, path-qualified executables, direct scripts, command wrappers, mutating PowerShell aliases, ambiguous parsing, and fixed high-risk patterns return to human approval.

### Review modes

| `mode` | Behavior |
| --- | --- |
| `rules-and-llm` (default) | Requires an explicit model response of `allow` after passing fixed checks and command rules |
| `rules-only` | Approves the current request once after passing fixed checks and command rules, without calling a model |

The model can only narrow the allowed set. It cannot bypass command rules or fixed risk checks.

Omit both `reviewer.provider` and `reviewer.model` to use the model of the session requesting approval. To pin a model, set both fields. Harness continues to manage credentials; the plugin stores only provider/model identifiers. An incomplete session model route, review timeout, invalid output, or failed call returns to human approval.

Saved settings apply to subsequent requests. An in-progress review keeps the settings snapshot captured at its start.

## Install, update, and uninstall

Plugins are installed per Profile. Install and configure the plugin separately for `web`, `headless`, `tui`, or a custom Profile.

```powershell
# Web settings page and Host approval core
dsh plugin --profile web add dsh-approve-for-me@latest

# Host approval core only
dsh plugin --profile headless add dsh-approve-for-me@latest

# Check for the approve-for-me preset and plugin entry
dsh --profile web --dump-config
dsh --profile headless --dump-config

# Remove from a specific Profile
dsh plugin --profile web remove dsh-approve-for-me
```

### Upgrade a running Web Profile

First press `Ctrl+C` in the terminal running `dsh web` to stop the Host, then run:

```powershell
dsh plugin --profile web add dsh-approve-for-me@latest
dsh plugin --profile web list dsh-approve-for-me --depth 0
dsh web --host 127.0.0.1 --port 3080
```

Confirm the installed version, restart the Host, then refresh the browser. Refreshing the browser alone does not reload the Host or update the Profile lockfile.

`@latest` is an npm dist-tag. Use `@<version>` to pin a version or roll back. Specify a tag or version explicitly: a bare package name can keep the old version locked in the Profile.

If `@latest` does not update the Profile, request the exact published version:

```powershell
$version = '0.3.2'
dsh plugin --profile web add "dsh-approve-for-me@$version"
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

If it remains pinned, keep the Host stopped, remove the plugin, and install it again:

```powershell
dsh plugin --profile web remove dsh-approve-for-me
dsh plugin --profile web add dsh-approve-for-me@latest
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

Use `@beta` only when explicitly testing the beta channel. Update other Profiles separately.

## YAML configuration

On DSH 0.2, the Web page edits the `approve-for-me` entry in the current Profile. For manual edits, use `$DSH_HOME\profiles\<profile>\cordis.patch.yml` and merge configuration into the existing entry without overwriting other entries.

On DSH 0.1, place the same fields under `approve-for-me:` in `$DSH_HOME\settings.yaml`. The Host approval core does not depend on the Web page; `headless` can use YAML configuration directly.

The following example is for DSH 0.2 and omits model identifiers to inherit the session model:

```yaml
- id: approve-for-me
  config:
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

To pin a model, set both provider and model within the `config` above:

```yaml
reviewer:
  provider: your-provider-id
  model: your-model-id
  timeoutMs: 30000
```

### Fields and limits

| Field | Default | Constraint |
| --- | --- | --- |
| `mode` | `rules-and-llm` | `rules-only` or `rules-and-llm` |
| `rules.commandPrefixes` | `[]` | At most 200 entries; `tool` is `shell` or `pwsh` |
| One `prefix` | None | One non-empty literal command segment, up to 1,000 characters |
| `rules.reviewerInstructions` | `''` | Up to 8,000 characters |
| `reviewer.provider` / `reviewer.model` | Current session | Set both or omit both |
| `reviewer.timeoutMs` | `30000` | 1,000 to 120,000 milliseconds |
| `limits.trustedTranscriptChars` | `12000` | 256 to 100,000 characters |
| `limits.untrustedToolDataChars` | `8000` | 256 to 100,000 characters |
| `limits.reviewerOutputChars` | `2000` | 256 to 100,000 characters |

## Approval and safety boundaries

The plugin processes requests in this order:

1. Confirm that the active Access preset is `approve-for-me`.
2. Strictly correlate the Shell or PowerShell escalation request with the current tool call.
3. Run fixed high-risk checks; return uncertain risks or failed checks to human approval.
4. Check that every command segment matches a prefix rule for its tool.
5. Call the model for review if required by `mode`; return one `allowed-once` on success.

High-risk checks cover common cases such as parsing failures, file or permission changes, system and package changes, Git/GitHub writes, credential access, dynamic execution, and external writes. These checks cannot prove that an unflagged command is safe. They do not directly deny high-risk commands; the final decision remains with the user.

| Access option | Sandbox escalation behavior |
| --- | --- |
| Native Harness approval | Ask the user for every escalation |
| `Approve for me` | Apply fixed checks and rules, optionally call a model, and ask the user when uncertain |
| `Full access` | Remove the sandbox approval boundary |

### Models, data, and settings permissions

- Review input includes the current escalation request, the correlated tool call, and a length-bounded transcript. Trusted guidance and untrusted tool data are handled separately, with common credential formats redacted.
- The reviewer has no tools. DSH `0.2.1-rc.1` uses a single LLM call; versions providing the legacy API use a fresh reviewer agent to avoid inheriting the parent agent's context.
- Model requests use the provider route configured in Harness. Invalid configuration, review failure, timeout, or cancellation returns to human approval.
- The Web page only reads and writes configuration; it does not make approval decisions. Harness's Settings service owns persistence, schema validation, revision conflicts, redaction, and hot reload.
- Settings RPC runs through Harness's authenticated Connection and inherits its authentication and Host/Origin protections. The plugin has no additional independent loopback-only authorization boundary and does not depend on `llm-pi-ai`.
- DSH 0.2 uses the `plugins.bundle.config` slot with key `dsh-approve-for-me`; older versions use `settings.plugin.item` with key `approve-for-me`. The client uses the shared settings schema service without bundling another schema rehydrator. Exported settings controller helpers require the Host's schema validator explicitly.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `Approve for me` is missing from Access | Check installation in the active Profile, restart the Host, and inspect `--dump-config` |
| The Web settings page is missing | Use the `web` Profile's authenticated Connection URL and find the configuration entry for your DSH version |
| A matching command still needs human approval | Check all compound command segments, risk signals, tool type, and model review results |
| Model review does not run | Confirm `mode` is `rules-and-llm`, all command segments match, and the session model route is valid |
| Provider/model validation fails | Set both fields or clear both |
| Saving reports a revision conflict | Reload configuration, edit the latest values, and save again |
| Installation reports peer warnings | Check the compatibility range below; in a development environment, run `pnpm peers check` and `pnpm check` |
| Another Profile does not work | Install and configure the plugin in that Profile separately |

## Compatibility

Version `0.3.2` supports the following verified DSH versions. Compatibility with earlier alpha versions is not promised:

| Component | Supported range |
| --- | --- |
| DeepSeek Harness | `0.1.1-rc.2`, `0.1.2-rc.1`, `0.1.5-rc.2`, `0.2.0-rc.2`, `0.2.1-rc.1` |
| Node.js | `^22.19.0 || >=24.0.0` |
| Cordis | `^4.0.1` |
| npm channel | `@latest` for stable releases; `@beta` for beta testing |

All five DSH versions passed typecheck, tests, and the build with their actual dependencies. Each 0.2 version passed 272 tests with one skipped; each 0.1 version passed 271 tests with two skipped. Skipped tests cover transport or Loader integrations that do not apply to the corresponding version.

Integration checks cover real Connection routes, the published LlmRuntime with a local adapter, and live configuration updates through the newer Loader. Full authenticated Web/Headless Profile smoke tests and visual acceptance have not been performed.

## Development and verification

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
npm pack --dry-run --json --ignore-scripts
```

To run client tests against a specific Harness source checkout:

```powershell
$env:DSH_HARNESS_ROOT = 'H:\path\to\deepseek-harness'
$env:DSH_HARNESS_TSCONFIG = 'H:\path\to\deepseek-harness\tsconfig.base.json'
pnpm test
```

After setting `DSH_HARNESS_ROOT`, run `pnpm typecheck:harness` for typechecking against Harness source. The generated temporary tsconfig is ignored by Git. Use a fresh, isolated `DSH_HOME` for runtime verification.

### Local tarball

```powershell
npm pack --json
$package = Get-ChildItem '.\dsh-approve-for-me-*.tgz' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
dsh plugin --profile web add $package.FullName
```

## Security and license

Report vulnerabilities privately through GitHub Security Advisories. Do not submit API keys, credentials, complete prompts, private paths, or unredacted tool arguments. See [SECURITY.md](SECURITY.md).

Licensed under the [MIT License](LICENSE).

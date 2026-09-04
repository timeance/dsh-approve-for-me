# dsh-approve-for-me：DeepSeek Harness 自动沙箱审批

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-approve-for-me)](https://www.npmjs.com/package/dsh-approve-for-me)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**规则限定范围，可选大模型复核；拿不准时交回 Harness 原生人工审批。**

`dsh-approve-for-me` 是 DeepSeek Harness 的自动沙箱审批（automatic sandbox approval）插件，用于 Shell 和 PowerShell 的沙箱扩权（sandbox escalation）。它依次执行固定高风险检查、字面命令前缀规则和可选的无工具大模型复核器（LLM reviewer）。成功时只授予当前请求一次 `allowed-once`，不会永久授权。

`0.3.0` 声明兼容 DeepSeek Harness `0.1.1-rc.2`、`0.1.2-alpha.1`、`0.1.2-alpha.4` 和 `0.1.2-rc.1`。这些版本都使用 keyed 第三方设置卡片和共享客户端 settings schema service。

> [!WARNING]
> 本项目不是 DeepSeek 官方插件，未经独立安全审计且不提供担保。内置检查无法覆盖所有命令、参数、wrapper 和环境差异。请使用尽可能窄的正向允许列表（allowlist），并为重要操作保留 Harness 原生人工审批。

## 快速使用

```powershell
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add dsh-approve-for-me@latest
dsh web --host 127.0.0.1 --port 3080
```

然后：

1. 打开 `Settings -> Plugins -> Plugin configuration -> Approve for me`。
2. 只添加你愿意自动复核的命令前缀。
3. 为目标 agent 或 session 选择 `Approve for me` Access preset。

> [!IMPORTANT]
> `commandPrefixes` 默认为空。只安装插件不会自动批准任何命令。

`@latest` 是 npm dist-tag，不是固定版本号。只有明确测试 beta 通道时才使用 `@beta`；需要可复现安装或回滚时使用 `@<version>`。不建议把无后缀包名作为升级命令：Profile 可能已经锁定具体版本，此时 pnpm 会显示 `Already up to date`，但不会改写版本。

## 为什么使用它

| Access 方式 | 沙箱扩权行为 |
| --- | --- |
| Harness 原生审批 | 每次扩权都询问用户 |
| `Approve for me` | 执行固定检查和用户规则，可选调用模型，不确定时询问用户 |
| `Full access` | 关闭沙箱审批边界 |

规则决定自动审批的最大候选范围。reviewer 只能收紧范围，不能绕过规则或固定高风险检查。

## Web 配置

添加范围明确的字面前缀，例如：

<img width="560" alt="Approve for me Web settings" src="https://github.com/user-attachments/assets/ba3df97b-3d35-47b7-a8a4-cd7772c48eb6" />

```text
Shell:      git status
Shell:      git diff
PowerShell: Get-Location
PowerShell: Get-Content -LiteralPath README.md
```

规则匹配经过解析的 token 前缀，不是整条命令完全相等。后面仍可追加参数，因此应尽量写明子命令和路径。复合命令中的每个分段都必须分别匹配。

即使前缀看似匹配，已知的包管理器生命周期动作、带路径的可执行文件、直接脚本、wrapper、会写入的 PowerShell alias、解析歧义和固定高风险形态仍会转人工审批。

Web 卡片是可选配置入口。客户端以 key `approve-for-me` 注册 keyed `settings.plugin.item` slot，并使用 Harness 共享的 settings schema service。卡片通过 Harness 已认证的 Connection 调用插件 RPC，并继承 Connection 的认证与 Host/Origin 防护；插件不声称另有独立的 loopback-only 边界。持久化、schema 校验、revision conflict、脱敏和热加载由 Harness Settings service 负责。卡片不做审批决策，也不依赖 `llm-pi-ai`。导出的 settings controller 辅助函数现在必须显式接收 Host 提供的 schema validator，浏览器 bundle 不再携带第二份本地 schema rehydrator。

检查 Profile 实际安装的版本：

```powershell
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

测试时应确认：匹配的只读扩权可以获得一次性批准；未匹配或高风险请求仍显示原生人工审批；切换到其他 Access preset 后插件不再参与当前 session 的审批。

## 安装与升级

插件和设置按 Profile 隔离。`web`、`headless`、`tui` 和自定义 Profile 需要分别安装。

```powershell
# Web 设置卡片 + Host 审批核心
dsh plugin --profile web add dsh-approve-for-me@latest

# 不使用 Web 设置卡片的 Host 审批核心
dsh plugin --profile headless add dsh-approve-for-me@latest

# 检查有效接线
dsh --profile web --dump-config
dsh --profile headless --dump-config

# 从一个 Profile 卸载
dsh plugin --profile web remove dsh-approve-for-me
```

配置转储应包含 `approve-for-me` permission preset 和 Host 插件条目。

### 升级正在运行的 Web Profile

1. 在运行 `dsh web` 的终端按 `Ctrl+C` 停止 Host。
2. 请求 npm 当前的 `latest` dist-tag。
3. 检查实际安装版本。
4. 重启 Host。
5. Host 启动后再刷新浏览器。

```powershell
dsh plugin --profile web add dsh-approve-for-me@latest
dsh plugin --profile web list dsh-approve-for-me --depth 0
dsh web --host 127.0.0.1 --port 3080
```

单独刷新浏览器不会重载 Host 进程，也不会更新 Profile lockfile。

如果 `@latest` 没有更新，先指定具体已发布版本：

```powershell
$version = '<published-version>'
dsh plugin --profile web add "dsh-approve-for-me@$version"
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

如果仍锁定旧版本，保持 Host 停止，先 remove 再重新 add：

```powershell
dsh plugin --profile web remove dsh-approve-for-me
dsh plugin --profile web add dsh-approve-for-me@latest
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

测试 beta 时使用 `dsh plugin --profile web add dsh-approve-for-me@beta`。其他 Profile 需要单独升级。

## YAML 配置

Web 页面和 `$DSH_HOME\settings.yaml` 修改同一份 `approve-for-me` 设置。Web 只是可选写入方式。

### 推荐：规则 + 当前会话模型

省略 `reviewer.provider` 和 `reviewer.model`，每次复核继承发起审批请求的 session provider/model：

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

如果请求 session 没有完整的 provider/model 路由，reviewer 不会自动允许，请求转人工审批。

需要固定路由时，同时填写两个标识：

```yaml
reviewer:
  provider: your-provider-id
  model: your-model-id
  timeoutMs: 30000
```

模型凭据仍由 Harness 管理，插件只保存 provider/model 标识。

不需要模型复核时设置 `mode: rules-only`。关联检查、命令解析、固定高风险检查和规则匹配仍会执行。

### 字段限制

| 字段 | 默认值 | 限制 |
| --- | --- | --- |
| `mode` | `rules-and-llm` | `rules-only` 或 `rules-and-llm` |
| `rules.commandPrefixes` | `[]` | 最多 200 条；tool 为 `shell` 或 `pwsh` |
| 单条 `prefix` | 无 | 一个非空字面命令分段，最多 1000 字符 |
| `rules.reviewerInstructions` | `''` | 最多 8000 字符 |
| `reviewer.timeoutMs` | `30000` | 1000 到 120000 毫秒 |
| reviewer 内容边界 | `12000 / 8000 / 2000` | 每项 256 到 100000 字符 |
| `reviewer.provider/model` | 当前 session | 同时填写或同时省略 |

已开始的复核使用启动时取得的配置快照；热加载只影响之后的请求。

## 安全模型

默认行为：

- 模式为 `rules-and-llm`。
- reviewer provider/model 继承发起请求的 session。
- 正向命令规则为空。
- 固定高风险检查先于用户规则和 reviewer。
- 每次复核使用全新的无工具 agent。
- 失败、超时、无效输出、歧义或不匹配都会转人工审批。

决策顺序：

1. 当前 Access preset 必须是 `approve-for-me`。
2. 请求必须是受支持的 Shell 或 PowerShell 扩权，并能严格关联到当前工具调用。
3. 命令必须通过固定高风险检查。
4. 每个命令分段都必须匹配对应工具的字面前缀。
5. `rules-only` 返回一次 `allowed-once`；`rules-and-llm` 还要求 reviewer 返回结构正确的明确 `allow`。

内置检查覆盖一组有限的常见风险，包括解析失败、文件或权限修改、系统和包管理变更、Git/GitHub 写操作、包管理器生命周期脚本、带路径的可执行文件、动态命令执行、凭据访问和外部写入。它们是保守分类器，不能证明未命中的命令一定安全。

高风险结果会停止自动审批并把请求交回 Harness，不会直接拒绝命令。

### 权限与数据

| 项目 | 行为 |
| --- | --- |
| 审批上下文 | 读取当前 escalation、关联工具调用和有长度上限的 transcript |
| reviewer 输入 | 区分可信说明与不可信工具数据，限制长度并清理常见凭据格式 |
| reviewer 权限 | 使用全新 agent，不提供工具 |
| 网络 | 使用 Harness 已配置的 provider 路由 |
| Web 写入 | 已认证的 Connection RPC 委托 Settings service 持久化 |
| 批准范围 | 只为当前请求返回一次 `allowed-once` |

## 故障排查

| 现象 | 检查 |
| --- | --- |
| Access 中没有 `Approve for me` | 安装到当前 Profile，重启，并检查 `--dump-config` |
| Web 设置卡片不显示 | 使用 `web` Profile 的已认证 Connection URL |
| 命令匹配但仍询问 | 检查复合命令各分段、高风险信号、工具类型和 reviewer 结果 |
| reviewer 没有运行 | 确认使用 `rules-and-llm`、规则完整匹配且 session 模型路由有效 |
| provider/model 校验失败 | 同时填写两项，或同时清空 |
| 保存提示 revision conflict | 重新加载卡片，基于最新值编辑并保存 |
| 安装出现 peer warning | 确认 Harness `0.1.1-rc.2`、`0.1.2-alpha.1`、`0.1.2-alpha.4` 或 `0.1.2-rc.1` 兼容性，并运行 `pnpm check` |
| 另一个 Profile 不生效 | 在该 Profile 中单独安装和配置 |

## 常见问题

### 如何自动审批 DeepSeek Harness sandbox escalation？

安装插件、添加范围明确的命令前缀，然后选择 `Approve for me` Access preset。只有严格关联、通过固定检查并满足当前复核模式的请求才会获得一次性批准。

### 它会替代 `Full access` 吗？

不会。插件保留沙箱边界，并把不确定请求交回 Harness 原生审批。

### 是否有内置规则？

有固定高风险检查，但没有内置正向 allowlist。正向规则必须符合当前项目和威胁模型。

### 高风险命令会被直接拒绝吗？

不会。`0.3.0` 会停止自动审批，把决定交回用户。

### reviewer 能扩大 allowlist 吗？

不能。规则先确定最大候选范围，reviewer 只能允许匹配请求或交回人工。

### headless 能使用吗？

能。在 `headless` Profile 中单独安装并配置 YAML。Host 审批核心不依赖 Web 卡片。

## 兼容性

| 项目 | 基线 |
| --- | --- |
| DeepSeek Harness 兼容范围 | `0.1.1-rc.2`、`0.1.2-alpha.1`、`0.1.2-alpha.4`、`0.1.2-rc.1` |
| Node.js | `^22.19.0 || >=24.0.0` |
| Cordis | `^4.0.1` |
| npm 通道 | 稳定版使用 `@latest`；beta 测试使用 `@beta` |

`0.3.0` 保留 keyed 设置卡片集成，适配 Settings、Session 事件和权限预设 API 差异，并保留现有审批与 Harness 原生回退行为；已针对 Harness `0.1.2-rc.1` 验证。Settings RPC 通过 Connection 注册并使用 Connection 的认证与 Host/Origin 防护；文档不将其描述为插件另有独立的 loopback-only 限制。客户端 settings 辅助函数改为接收 Host 的共享 schema validator，不再打包本地 rehydrator。

## 开发与验证

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
npm pack --dry-run --json --ignore-scripts
```

需要对指定 Harness 源码 checkout 运行客户端测试时：

```powershell
$env:DSH_HARNESS_ROOT = 'H:\path\to\deepseek-harness'
$env:DSH_HARNESS_TSCONFIG = 'H:\path\to\deepseek-harness\tsconfig.base.json'
pnpm test
```

Harness 类型检查生成的临时 tsconfig 会被 Git 忽略。运行时验证应使用新的隔离 `DSH_HOME`。运行 Harness 源码类型检查前，先设置 `DSH_HARNESS_ROOT` 并执行 `pnpm typecheck:harness`。

### 本地 tarball

```powershell
npm pack --json
$package = Get-ChildItem '.\dsh-approve-for-me-*.tgz' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
dsh plugin --profile web add $package.FullName
```


## 安全与许可证

请通过 GitHub Security Advisories 私下报告漏洞。不要提交 API key、凭据、完整 prompt、私有路径或未脱敏的工具参数。详见 [SECURITY.md](SECURITY.md)。

本项目使用 [MIT License](LICENSE)。

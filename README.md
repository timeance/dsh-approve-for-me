# dsh-approve-for-me

中文 | [English](README.en.md)

[![npm](https://img.shields.io/npm/v/dsh-approve-for-me)](https://www.npmjs.com/package/dsh-approve-for-me)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

为 DeepSeek Harness 提供自动审批功能，采用偏保守的安全策略。插件先检查风险和命令规则，再按配置调用模型复核。通过时只授予当前请求一次 `allowed-once`；未匹配、存在风险或无法判断时，交回 Harness 原生人工审批。

> [!IMPORTANT]
> 默认命令规则为空。安装后，需要添加规则并选择 `Approve for me` Access preset，插件才会参与审批。

> [!WARNING]
> 本项目不是 DeepSeek 官方插件，未经独立安全审计，也不提供担保。内置检查无法覆盖所有命令、参数和运行环境。请限制允许列表的范围，并为重要操作保留人工审批。

## 快速开始

```powershell
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add dsh-approve-for-me@latest
dsh web --host 127.0.0.1 --port 3080
```

1. 打开配置：DSH 0.2 在 `Plugins` 中选择 `dsh-approve-for-me`；旧版使用 `Settings -> Plugins -> Plugin configuration -> Approve for me`。
2. 添加允许自动复核的命令前缀，例如 `git status` 或 `git diff`。
3. 为目标代理或会话选择 `Approve for me` Access preset。

<img width="560" alt="Approve for me 设置页面" src="https://github.com/user-attachments/assets/ba3df97b-3d35-47b7-a8a4-cd7772c48eb6" />

## 配置命令规则

规则示例：

```text
Shell:      git status
Shell:      git diff
PowerShell: Get-Location
PowerShell: Get-Content -LiteralPath README.md
```

匹配按解析后的命令 token 前缀进行，后面仍可追加参数。请尽量写明子命令和路径，避免只允许 `git`、`npm` 等宽泛前缀。复合命令中的每个分段都必须匹配对应工具的规则。

即使前缀匹配，包管理器生命周期动作、带路径的可执行文件、直接脚本、命令包装器、会写入的 PowerShell 别名、解析歧义和固定高风险形态仍会转人工审批。

### 复核模式

| `mode` | 行为 |
| --- | --- |
| `rules-and-llm`（默认） | 通过固定检查和规则匹配后，还需模型明确返回 `allow` |
| `rules-only` | 通过固定检查和规则匹配后，批准当前请求一次，不调用模型 |

模型只能收紧允许范围，不能绕过命令规则或固定风险检查。

省略 `reviewer.provider` 和 `reviewer.model` 时，复核使用发起请求的会话模型。需要固定模型时同时填写两项；凭据仍由 Harness 管理，插件只保存 provider/model 标识。会话没有完整模型路由、复核超时、输出无效或调用失败时，均转人工审批。

保存配置后，新配置用于后续请求；已开始的复核继续使用启动时的配置快照。

## 安装、升级与卸载

插件按 Profile 安装。使用 `web`、`headless`、`tui` 或自定义 Profile 时，需要分别安装和配置。

```powershell
# Web 设置页面和 Host 审批核心
dsh plugin --profile web add dsh-approve-for-me@latest

# 仅使用 Host 审批核心
dsh plugin --profile headless add dsh-approve-for-me@latest

# 检查配置是否包含 approve-for-me 预设和插件条目
dsh --profile web --dump-config
dsh --profile headless --dump-config

# 从指定 Profile 卸载
dsh plugin --profile web remove dsh-approve-for-me
```

### 升级正在运行的 Web Profile

先在运行 `dsh web` 的终端按 `Ctrl+C` 停止 Host，再执行：

```powershell
dsh plugin --profile web add dsh-approve-for-me@latest
dsh plugin --profile web list dsh-approve-for-me --depth 0
dsh web --host 127.0.0.1 --port 3080
```

确认实际安装版本后重启 Host，再刷新浏览器。单独刷新浏览器不会重载 Host，也不会更新 Profile lockfile。

`@latest` 是 npm 发布标签；需要固定版本或回滚时使用 `@<version>`。请显式指定标签或版本，无后缀包名可能继续使用 Profile 中锁定的旧版本。

如果 `@latest` 没有更新，先指定已发布版本：

```powershell
$version = '0.3.2'
dsh plugin --profile web add "dsh-approve-for-me@$version"
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

若仍锁定旧版本，保持 Host 停止，卸载后重新安装：

```powershell
dsh plugin --profile web remove dsh-approve-for-me
dsh plugin --profile web add dsh-approve-for-me@latest
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

仅在明确测试 beta 通道时使用 `@beta`。其他 Profile 需要单独升级。

## YAML 配置

DSH 0.2 的 Web 页面修改当前 Profile 的 `approve-for-me` 配置条目。手动编辑时使用 `$DSH_HOME\profiles\<profile>\cordis.patch.yml`，将配置合并到已有条目中，勿覆盖其他条目。

DSH 0.1 将相同字段放在 `$DSH_HOME\settings.yaml` 的 `approve-for-me:` 下。Host 审批核心不依赖 Web 页面，`headless` 可以直接使用 YAML 配置。

以下示例适用于 DSH 0.2，省略模型标识以继承会话模型：

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

需要固定模型时，在上述 `config` 内同时设置 provider 和 model：

```yaml
reviewer:
  provider: your-provider-id
  model: your-model-id
  timeoutMs: 30000
```

### 字段与限制

| 字段 | 默认值 | 限制 |
| --- | --- | --- |
| `mode` | `rules-and-llm` | `rules-only` 或 `rules-and-llm` |
| `rules.commandPrefixes` | `[]` | 最多 200 条；`tool` 为 `shell` 或 `pwsh` |
| 单条 `prefix` | 无 | 一个非空字面命令分段，最多 1000 字符 |
| `rules.reviewerInstructions` | `''` | 最多 8000 字符 |
| `reviewer.provider` / `reviewer.model` | 当前会话 | 同时填写或同时省略 |
| `reviewer.timeoutMs` | `30000` | 1000 到 120000 毫秒 |
| `limits.trustedTranscriptChars` | `12000` | 256 到 100000 字符 |
| `limits.untrustedToolDataChars` | `8000` | 256 到 100000 字符 |
| `limits.reviewerOutputChars` | `2000` | 256 到 100000 字符 |

## 审批与安全边界

插件按以下顺序处理请求：

1. 确认当前 Access preset 为 `approve-for-me`。
2. 将 Shell 或 PowerShell 扩权请求严格关联到当前工具调用。
3. 执行固定高风险检查；风险不明或检查不通过时转人工审批。
4. 检查每个命令分段是否匹配对应工具的前缀规则。
5. 按 `mode` 决定是否调用模型复核；通过时只返回一次 `allowed-once`。

高风险检查覆盖解析失败、文件或权限修改、系统和包管理变更、Git/GitHub 写操作、凭据访问、动态执行和外部写入等常见情况。这些检查不能证明未命中的命令一定安全，也不会直接拒绝高风险命令；最终决定仍交给用户。

| Access 方式 | 沙箱扩权行为 |
| --- | --- |
| Harness 原生审批 | 每次扩权都询问用户 |
| `Approve for me` | 执行固定检查和规则，可选调用模型；不确定时询问用户 |
| `Full access` | 关闭沙箱审批边界 |

### 模型、数据与设置权限

- 复核输入包含当前扩权请求、关联工具调用和有长度上限的会话记录。可信说明与不可信工具数据分开处理，并清理常见凭据格式。
- 复核不提供工具。DSH `0.2.1-rc.1` 使用单次 LLM 调用；提供旧 API 的版本使用新的复核代理，避免继承父代理上下文。
- 模型请求使用 Harness 配置的 provider 路由。配置无效、复核失败、超时或取消时，均转人工审批。
- Web 页面只读写配置，不参与审批。持久化、schema 校验、修订冲突、脱敏和热加载由 Harness Settings service 负责。
- 设置 RPC 通过 Harness 已认证的 Connection 提供，继承其认证与 Host/Origin 防护。插件没有额外的独立 loopback-only 授权边界，也不依赖 `llm-pi-ai`。
- DSH 0.2 使用 `plugins.bundle.config` slot，key 为 `dsh-approve-for-me`；旧版使用 `settings.plugin.item`，key 为 `approve-for-me`。客户端使用共享 settings schema service，不另行打包 schema rehydrator；导出的 settings controller 辅助函数需显式接收 Host 的 schema validator。

## 故障排查

| 现象 | 处理方式 |
| --- | --- |
| Access 中没有 `Approve for me` | 检查是否安装到当前 Profile，重启 Host，并查看 `--dump-config` |
| Web 设置页面不显示 | 确认使用 `web` Profile 的已认证 Connection URL，并按对应 DSH 版本查找配置入口 |
| 命令匹配但仍需人工审批 | 检查复合命令的所有分段、风险信号、工具类型和模型复核结果 |
| 模型复核没有运行 | 确认 `mode` 为 `rules-and-llm`、命令完整匹配，且会话模型路由有效 |
| provider/model 校验失败 | 同时填写两项，或同时清空 |
| 保存提示修订冲突（revision conflict） | 重新加载配置，基于最新值编辑后保存 |
| 安装出现 peer warning | 核对下方兼容范围；开发环境可运行 `pnpm peers check` 和 `pnpm check` |
| 另一个 Profile 不生效 | 在该 Profile 中单独安装和配置 |

## 兼容性

`0.3.2` 支持以下已验证的 DSH 版本，不承诺兼容早期 alpha 版本：

| 项目 | 支持范围 |
| --- | --- |
| DeepSeek Harness | `0.1.1-rc.2`、`0.1.2-rc.1`、`0.1.5-rc.2`、`0.2.0-rc.2`、`0.2.1-rc.1` |
| Node.js | `^22.19.0 || >=24.0.0` |
| Cordis | `^4.0.1` |
| npm 通道 | `@latest` 用于正式版本，`@beta` 用于 beta 测试 |

五个 DSH 版本均使用各自实际依赖完成类型检查、测试和构建。0.2 系列各通过 272 项测试、跳过 1 项；0.1 系列各通过 271 项测试、跳过 2 项。跳过项为对应版本不适用的通道或 Loader 集成测试。

集成检查覆盖真实 Connection 路由、发布版 LlmRuntime 配合本地适配器，以及新版 Loader 配置热更新。完整认证 Web/Headless Profile 冒烟测试和界面目视验收尚未执行。

## 开发与验证

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test:coverage
npm pack --dry-run --json --ignore-scripts
```

需要针对指定 Harness 源码检出目录运行客户端测试时：

```powershell
$env:DSH_HARNESS_ROOT = 'H:\path\to\deepseek-harness'
$env:DSH_HARNESS_TSCONFIG = 'H:\path\to\deepseek-harness\tsconfig.base.json'
pnpm test
```

设置 `DSH_HARNESS_ROOT` 后，可执行 `pnpm typecheck:harness` 进行 Harness 源码类型检查。生成的临时 tsconfig 已被 Git 忽略。运行时验证应使用新的隔离 `DSH_HOME`。

### 本地安装包

```powershell
npm pack --json
$package = Get-ChildItem '.\dsh-approve-for-me-*.tgz' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
dsh plugin --profile web add $package.FullName
```

## 安全与许可证

请通过 GitHub Security Advisories 私下报告漏洞。不要提交 API key、凭据、完整提示词、私有路径或未脱敏的工具参数。详见 [SECURITY.md](SECURITY.md)。

本项目使用 [MIT License](LICENSE)。

# dsh-approve-for-me：DeepSeek Harness 自动沙箱审批

[English](README.md) | 中文

[![npm](https://img.shields.io/npm/v/dsh-approve-for-me)](https://www.npmjs.com/package/dsh-approve-for-me)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

**规则限定范围 + LLM复核，拿不准就交回人工。**

`dsh-approve-for-me` 是 DeepSeek Harness 的自动沙箱审批（automatic sandbox approval）插件，用于严格 allowlist 的 Shell/PowerShell sandbox escalation。它先执行固定高风险检查和命令前缀规则，再可选调用无工具 LLM reviewer；高危、未匹配、歧义或复核失败的请求交回 Harness 原生人工审批。每次成功只授予一次 `allowed-once`，不会永久授权。当前基于 DeepSeek Harness `0.1.0-rc.6` 验证，新版本会在验证后跟进。

字面前缀 allowlist · 固定高风险检查 · 无工具 LLM reviewer · 原生人工兜底

> [!WARNING]
> 本项目不是 DeepSeek 官方插件，当前版本仍为 beta，未经独立安全审计且不提供担保。内置检查不能覆盖所有命令、参数和环境差异。请使用尽可能窄的规则，并把 Harness 原生人工审批保留为重要操作的最终判断。

## 为什么使用它

| Access 方式 | 沙箱扩权请求 | 适合场景 |
| --- | --- | --- |
| Harness 原生审批 | 每次询问用户 | 命令变化大，必须逐次判断 |
| `Approve for me` | 规则筛选、可选模型复核，不确定时询问用户 | 重复且边界明确的工作流 |
| `Full access` | 关闭沙箱审批边界 | 已明确接受完整权限风险的环境 |

规则决定哪些请求有资格进入自动审核。LLM reviewer 只能进一步收紧范围，不能绕过规则或固定高风险检查。成功时也只返回一次 `allowed-once`，不会永久授权。

## 快速使用

先安装 DeepSeek Harness 和本插件到 Web Profile，再启动 Host：

```powershell
npm install -g @deepseek-ai/dsh
dsh plugin --profile web add dsh-approve-for-me@latest
dsh web --host 127.0.0.1 --port 3080
```

`@latest` 是 npm dist-tag，不是固定版本号。需要明确跟随 beta 通道时使用 `@beta`。只有在需要可复现安装或回滚时，才使用类似 `@<version>` 的具体已发布版本。升级不要使用无后缀包名：Profile manifest 可能已经记录了具体版本，pnpm 会显示 `Already up to date`，但不会改写它。

## Web 配置

进入 `设置 -> 插件 -> 插件配置 -> 帮我批准`。只添加你愿意自动审核的命令前缀，例如：
<img width="514" height="517" alt="web_setting_1" src="https://github.com/user-attachments/assets/ba3df97b-3d35-47b7-a8a4-cd7772c48eb6" />


```text
Shell:      git status
Shell:      git diff
PowerShell: Get-Location
PowerShell: Get-Content -LiteralPath README.md
```

然后为目标 agent 或 session 选择 `Approve for me` Access preset。

> [!IMPORTANT]
> `commandPrefixes` 默认为空。只安装插件不会自动批准任何命令，必须先定义正向规则。

规则匹配的是 token 前缀，不是整条命令完全相等，因此后面仍可追加参数。请明确写出子命令和路径。即使前缀匹配，`npm test`、`pnpm test` 等包管理器生命周期脚本、带路径的可执行文件、直接脚本、wrapper、已知的 PowerShell 写入 alias，以及未知包管理器动作也会交回原生人工审批。

Web 卡片只是可选编辑器。Host 审批核心也能在 headless Profile 中运行，并且可以只使用 YAML 配置。

在 rc.6 中，客户端以真实插件 id `approve-for-me` 注册 `settings.plugin.item` 卡片。卡片只在 loopback 连接中显示，并通过插件自己的 loopback-only RPC 读写配置。持久化、schema 校验、冲突处理、脱敏和热加载由 Harness 官方 Settings service 负责。卡片不做审批决策，也不依赖或伪装成 `llm-pi-ai`。

### 验证

触发一次原本会请求 sandbox escalation、且与已配置前缀匹配的只读命令，然后确认：

1. 符合规则并通过 reviewer 的请求得到单次批准。
2. 未匹配规则或命中高风险检查的请求仍显示原生人工审批。
3. 切回其他 Access preset 后，插件不参与审批。

没有发生 sandbox escalation 时，插件不会介入普通工具调用。

检查 Profile 中实际安装的版本：

```powershell
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

`list` 输出的是该 Profile 实际加载的版本。其 package manifest 和 lockfile 位于 `$DSH_HOME\profiles\web`；本机路径是 `C:\Users\zariba\.dsh\profiles\web`。

<img width="530" height="280" alt="test_01" src="https://github.com/user-attachments/assets/30041b07-ec0d-42c9-aabf-67f619ac50af" />
（互动的测试集，等完善了规则之后更新出来）


## 完整安装

插件按 Profile 安装。`web`、`headless`、`tui` 和自定义 Profile 互不继承安装状态或设置。

```powershell
# Web 设置页 + Host 审批核心
dsh plugin --profile web add dsh-approve-for-me@latest

# 无 Web 页面的 Host 审批核心
dsh plugin --profile headless add dsh-approve-for-me@latest

# 更新当前 Profile 中的版本
dsh plugin --profile web add dsh-approve-for-me@latest

# 卸载
dsh plugin --profile web remove dsh-approve-for-me
```

安装或更新后，建议重启对应 Profile，并检查有效配置：

```powershell
dsh --profile web --dump-config
dsh --profile headless --dump-config
```

配置转储应包含 `approve-for-me` permission preset 和插件 Host 条目。

### 升级正在运行的 Web Profile

升级期间必须先停止 Host。在运行 `dsh web` 的终端按 `Ctrl+C`，再按以下顺序执行：

```powershell
# 请求 npm 当前 latest dist-tag
dsh plugin --profile web add dsh-approve-for-me@latest

# 重启 Host 前确认实际安装版本
dsh plugin --profile web list dsh-approve-for-me --depth 0

# 重启 Web Host
dsh web --host 127.0.0.1 --port 3080
```

Host 重启后才能刷新浏览器。单独刷新浏览器不会重载 Host 进程，也不会改变 Profile lockfile。

如果 `@latest` 仍然没有更新，先指定具体已发布版本：

```powershell
$version = '<published-version>'
dsh plugin --profile web add "dsh-approve-for-me@$version"
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

如果 Profile 仍显示旧版本，保持 Host 停止，先 remove 再重新 add：

```powershell
dsh plugin --profile web remove dsh-approve-for-me
dsh plugin --profile web add dsh-approve-for-me@latest
dsh plugin --profile web list dsh-approve-for-me --depth 0
```

`headless` 也遵循同样规则，需要单独执行 `dsh plugin --profile headless add dsh-approve-for-me@latest`。

### 从本地 tarball 安装

```powershell
pnpm install --frozen-lockfile
npm pack --json

$package = Get-ChildItem '.\dsh-approve-for-me-*.tgz' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
dsh plugin --profile web add $package.FullName
```

从 Harness 源码 checkout 运行时，先构建 Harness，再使用该仓库提供的 `pnpm dsh ...` 命令。

### 发布标签维护

`@latest` 是 dist-tag，不是版本锁定。当前包使用 `publishConfig.tag: beta` 发布 beta 版本。发布 `<published-version>` 时，beta 标签会更新；如果文档要跟随最新 beta，还必须同步移动 `latest`，否则 `@latest` 仍会指向旧版本。例如：

```powershell
npm publish --tag beta
$version = '<published-version>'
npm dist-tag add "dsh-approve-for-me@$version" latest
```

## YAML 配置

Web 设置页和 `$DSH_HOME\settings.yaml` 修改的是同一份 `approve-for-me` 配置。Web 是可选编辑器；headless 环境可以只使用 YAML。

### 推荐配置：规则 + 当前会话模型

省略 `reviewer.provider` 和 `reviewer.model`，每次审批会继承发起请求的 session provider/model：

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
```

如果请求会话没有完整的 provider/model 路由，reviewer 不会自动允许，请求转人工审批。

### 固定 reviewer 路由

只需在 `reviewer` 中同时填写两个字段：

```yaml
reviewer:
  provider: your-provider-id
  model: your-model-id
  timeoutMs: 30000
```

`provider` 和 `model` 必须同时存在或同时省略。插件只保存标识，不保存模型凭据。

### 仅使用规则

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

`rules-only` 不调用模型，但仍执行关联检查、保守解析和固定高风险检查。

### 字段限制

| 字段 | 默认值 | 限制 |
| --- | --- | --- |
| `mode` | `rules-and-llm` | `rules-only` 或 `rules-and-llm` |
| `rules.commandPrefixes` | `[]` | 最多 200 条；工具只能是 `shell` 或 `pwsh` |
| 单条 `prefix` | 无 | 非空字面命令分段，最多 1000 字符 |
| `rules.reviewerInstructions` | `''` | 最多 8000 字符 |
| `reviewer.timeoutMs` | `30000` | 1000 到 120000 毫秒 |
| `reviewer.provider/model` | 当前会话 | 同时填写或同时省略 |

可选内容边界的默认值：

```yaml
approve-for-me:
  limits:
    trustedTranscriptChars: 12000
    untrustedToolDataChars: 8000
    reviewerOutputChars: 2000
```

已开始的审批使用启动时取得的配置快照；热加载只影响之后的请求。

## 默认安全基线

安装后的默认配置是：

- 模式为 `rules-and-llm`。
- reviewer 的 provider/model 继承发起当前审批请求的会话路由。
- reviewer timeout 为 30 秒。
- 正向命令规则为空，因此默认不会自动批准命令。
- 固定高风险检查始终先于用户规则和 reviewer 执行。
- reviewer 每次使用全新、无工具的 agent。

内置高风险检查是有限、保守的分类器，不能证明未命中的命令一定安全。它会识别 shell 解析失败、常见文件或权限修改、系统和包管理变更、Git/GitHub 写操作、包管理器生命周期脚本、带路径的可执行文件、动态命令执行、凭据访问和外部写入。

这里的“高风险”结果是**禁止插件自动批准并转人工**，不是直接拒绝命令。这样可以避免插件用一份通用规则替用户做不可逆决定。

## 它如何决策

一次请求按以下顺序处理：

1. 当前 Access preset 必须是 `approve-for-me`。
2. 请求必须是受支持的 Shell 或 PowerShell sandbox escalation，并能严格关联到当前工具调用。
3. 命令必须通过固定高风险检查。
4. 每个命令分段都必须匹配对应工具的字面前缀规则。
5. `rules-only` 到此通过；`rules-and-llm` 还需要 reviewer 返回结构正确的明确 `allow`。

| 结果 | 插件动作 |
| --- | --- |
| 固定高风险、解析歧义或关联失败 | 转原生人工审批 |
| 任一命令分段未匹配 | 转原生人工审批 |
| `rules-only` 完整匹配 | 返回一次 `allowed-once` |
| reviewer 明确允许 | 返回一次 `allowed-once` |
| reviewer 拒绝、升级、超时、报错或输出无效 | 转原生人工审批 |

前缀是经过解析和校验的字面命令前缀，不是正则表达式。复合命令中的每个分段都要单独满足规则。

## 权限与数据

| 项目 | 行为 |
| --- | --- |
| 审批上下文 | 读取当前 escalation、关联的工具调用和有长度上限的 transcript |
| reviewer 输入 | 区分可信说明与不可信工具数据，并在发送前限制长度和清理常见凭据格式 |
| reviewer 权限 | 使用全新 agent；不提供任何工具 |
| 模型路由 | 继承当前会话或使用显式 provider/model；凭据由 Harness 管理 |
| Web 写入 | loopback-only RPC 委托官方 Settings service 持久化 |
| 网络 | 模型请求通过 Harness 已配置的 provider 路由；插件 Web RPC 不对非 loopback 客户端开放 |
| 批准范围 | 只返回当前请求的一次性 `allowed-once` |

## 故障排查

| 现象 | 检查 |
| --- | --- |
| Access 菜单没有 `Approve for me` | 确认插件安装在当前 Profile，重启 Profile，并检查 `--dump-config` |
| Web 设置卡片不显示 | 使用 `web` Profile，并通过 `127.0.0.1` 或其他 loopback 地址访问 |
| 命令匹配前缀但仍询问 | 检查复合命令的每个分段、高风险信号、工具类型和 reviewer 结果 |
| reviewer 没有运行 | 确认模式不是 `rules-only`，规则已匹配，且请求会话有完整模型路由 |
| provider/model 校验失败 | 两者必须同时填写；要继承当前会话时同时清空 |
| 保存提示 revision 冲突 | 刷新设置卡片，基于最新值重新编辑和保存 |
| 安装出现 peer warning | 核对当前 Harness 版本与插件兼容性；当前验证基线为 `0.1.0-rc.6`。再按提示运行 `pnpm peers check`，不要忽略实际版本冲突 |
| `@latest` 仍显示旧版本 | 停止 Host，执行具体版本 fallback，检查 `list`；仍旧锁定时 remove 后重新 add |
| Web 可以配置但另一个 Profile 不生效 | 插件与设置按 Profile 隔离，需要分别安装和配置 |

## 常见问题

### 如何在 DeepSeek Harness 中自动审批 sandbox escalation？

安装插件，定义命令前缀，并选择 `Approve for me` Access preset。插件只为严格关联、通过固定检查且满足正向规则的请求返回一次性批准，其余请求继续由用户处理。

### 它会替代 `Full access` 吗？

不会。插件保留沙箱边界，每次最多只为当前请求授予一次 `allowed-once`；高危、未匹配、歧义或复核失败的请求仍交给 Harness 原生人工审批。

### 是否有开箱即用的内置规则？

有不可配置的高风险检查，但没有内置正向 allowlist。前者筛查一组有限且保守的已知高风险形态，并不是完整的命令语义分析；后者必须由用户按自己的项目和威胁模型设置。

### 高风险命令会被插件直接拒绝吗？

不会。当前实现会停止自动审批并转交 Harness 原生人工审批。它不会替用户对重要操作做最终拒绝决定。

### LLM reviewer 能扩大规则范围吗？

不能。规则先确定最大候选范围，reviewer 只能允许其中的请求或把它交回人工。

### “继承当前会话模型”是什么意思？

省略 `reviewer.provider` 和 `reviewer.model` 后，插件会读取本次审批所属 session 的 provider/model。不同会话可以使用不同 reviewer 路由。

### Web 和 headless Profile 都能用吗？

能，但必须分别安装。Web 卡片只是可选配置入口，Host 审批核心不依赖浏览器。

### 需要 `llm-pi-ai` 吗？

不需要。插件使用自己的 namespace、Web 卡片和 RPC，并通过 Harness 的 subagent/provider 服务调用模型。

## 兼容性

| 项目 | 说明 |
| --- | --- |
| DeepSeek Harness | 开发与验证基线为 `0.1.0-rc.6`；新版本在验证后跟进 |
| Node.js | `^22.19.0 || >=24.0.0` |
| Cordis | `^4.0.1` |
| npm 通道 | 默认使用 `@latest`；需要跟随 beta 发布时使用 `@beta` |

权限 patch 保留 Harness 的 `Read Only`、`Workspace Write` 和 `Full access`，并追加 `Approve for me`。permission preset 图标由 Harness UI 渲染，本插件不自定义图标。

## 开发与验证

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

运行验证应使用新的隔离 `DSH_HOME`，分别检查 Web 卡片、配置持久化、YAML 热加载、会话模型继承和非 Web Host 激活。

### 运行证据

以下 smoke test 于 2026-08-15 执行，使用 DeepSeek Harness `0.1.0-rc.6`，以及由源码提交 `e8c3bdb` 构建的 `0.1.0-beta.2` tarball：

- Headless：隔离测试 patch 显式选择 `approve-for-me` preset、`rules-only` 和一个字面 `pwsh` 前缀。仅绑定 loopback 的 mock LLM 返回预设的 `pwsh Get-Location` 扩权请求；session 日志记录了 `approval/asked`、结果为 `allowed-once` 的 `approval/decided`、实际命令输出和成功退出（`0`）。
- Web：独立 Web Profile 安装同一个 tarball。`dsh --profile web --host 127.0.0.1 --port 0` 成功启动；根页面返回 HTTP `200`，并包含已安装插件的 bundle 标记。

这只是加载和 smoke test，不是安全审计。它没有覆盖真实 provider 凭据、浏览器交互、LLM reviewer 路径或 Web 设置/YAML 持久化。

## 安全与许可证

请通过 GitHub Security Advisories 私下报告漏洞，不要提交 API key、凭据、完整 prompt、私有路径或未脱敏的工具参数。详见 [SECURITY.md](SECURITY.md)。

本项目使用 [MIT License](LICENSE)。

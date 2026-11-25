# modelpace

**for T3 Code**

> **非官方社区工具（Unofficial）** — 与 T3 Tools Inc. 无隶属或官方背书关系。

面向 **T3 Code** 的零运行时依赖（Node.js >= 22 ESM）多模型派发、Even Pace 均匀用量门控、重置卡计算与贝叶斯验收评分引擎。

[English README](./README.md)

## 它做什么

Agent 调用 `delegate_task` 之前，modelpace 回答一个问题：*现在这个任务该交给哪个供应商实例和模型？* 它读取你 T3 Code 的实时额度（Even Pace、重置卡），优先选在你历史验收里真正通过的模型，并打印可直接使用的目标。它只给建议，真正开工的还是你的 Agent。

## 交给你的 Agent

把下面这段粘给 Claude Code、Codex、T3 Code 或任何 coding agent：

```text
帮我装好 modelpace。先读 https://github.com/jieyuexing/modelpace 的 AGENTS.md（或克隆后的本地副本），克隆仓库并用 AGENTS.md 里的离线回放确认能跑（在临时目录里跑，演示记录不要写进我真正的账本），把它的 MCP Server 注册到当前客户端；之后每次 delegate_task 前调用 dispatch_plan，我验收通过后调用 dispatch_record。用 --t3-auto 之前先问我。
```

Agent 也可以直接从 [AGENTS.md](./AGENTS.md)（安装、命令、MCP 工具、隐私、排错，英文）、[llms.txt](./llms.txt)（索引）和 [skills/modelpace/SKILL.md](./skills/modelpace/SKILL.md) 开始。

## 安装

需要 Node.js 22 及以上，无需构建，也没有依赖要装。

```bash
git clone https://github.com/jieyuexing/modelpace.git
cd modelpace
node ./bin/modelpace.mjs --version

npx github:jieyuexing/modelpace --version
npx modelpace --version
```

下文示例都用检出目录的写法 `node ./bin/modelpace.mjs`；从 npm 安装时换成 `npx modelpace`。

## 快速开始

<!-- docs-test expect: 建议动作: run -->
```bash
# 用固定时刻回放一份已保存的快照（--now 让示例可复现）
node ./bin/modelpace.mjs plan \
  --snapshot examples/sample-snapshot.json \
  --now 2026-11-23T07:05:00Z \
  --task slice \
  --lang zh
```

快照超过 15 分钟会得到 `refresh`，所以保存的文件只有在 `--now` 接近其 `observedAt` 时才有意义。连实时的 T3 Code 则无需固定时间：

```bash
# 零配置：自动发现本机 T3 Code（见下文「连接 T3 Code」）
node ./bin/modelpace.mjs plan --t3-auto --task slice

# 或显式指定 T3 服务
node ./bin/modelpace.mjs plan --t3-origin http://127.0.0.1:3773 --t3-token "$T3_TOKEN" --task long
```

### 策略

不传 `--config`（也没有 `MODELPACE_CONFIG`）时使用内置默认策略，`plan` 的文本输出会明确提示。它面向官方 T3 Code 的默认实例 id `codex`、`claudeAgent`、`antigravity`（一种 driver 一个实例），有 `worker`、`heavy`、`review` 三个槽位；快照里没有的实例对应的候选会被跳过。

要调整模型、优先级、阈值，或加入多个账号（多个 Codex / Antigravity 订阅、自定义实例 id），从内置策略或示例出发：

<!-- docs-test expect: Valid dispatch policy -->
```bash
node ./bin/modelpace.mjs init --out dispatch.config.json
node ./bin/modelpace.mjs validate --config dispatch.config.json
```

`examples/multi-account.config.json`（配 `examples/multi-account.snapshot.json`）演示了双 Antigravity 订阅加 Codex、Claude 的组合。全部字段见 [docs/SCHEMA.md](./docs/SCHEMA.md)（英文）。

### 记录验收结果

`plan` 只给建议，真正派发的是调用 `delegate_task` 的 Agent。独立验证结果之后再记录，之后的 `plan` 才会偏向真正通过的模型：

<!-- docs-test expect: Recorded codex/gpt-5.3-codex/high/default/local -->
```bash
node ./bin/modelpace.mjs plan --snapshot examples/sample-snapshot.json --now 2026-11-23T07:05:00Z --task slice --format json
# 把 decision.recommended.executor 抄进记录并补上 "site"；examples/record.example.json 是完整模板
node ./bin/modelpace.mjs record --json examples/record.example.json --scores demo-scores.jsonl
node ./bin/modelpace.mjs scores --scores demo-scores.jsonl
```

示例记录是假的，`demo-scores.jsonl` 只是演示用账本，用完请删除；不带 `--scores` 时记录会写进你真正的账本（见下）。

账本默认在 `$XDG_DATA_HOME/modelpace/scores.jsonl`（`~/.local/share/modelpace/scores.jsonl`；Windows 为 `%LOCALAPPDATA%\modelpace\scores.jsonl`），可用 `--scores FILE` 或 `MODELPACE_SCORES` 改。`record` 新建缺失目录时权限为 0700、账本文件 0600，不改已存在目录的权限。Agent 可参照 [skills/modelpace/SKILL.md](./skills/modelpace/SKILL.md)。同一执行身份、同一任务有 5 条成功记录后，候选变为 `qualified`；记录字段与身份规则见 [docs/SCHEMA.md](./docs/SCHEMA.md)。

### 连接 T3 Code

`--t3-auto` 会运行本机 T3 CLI（`t3 auth session issue --scope orchestration:read --ttl 2m --label modelpace`），用该令牌读取 `server.getConfig`，并在 `finally` 中吊销会话。会话最长 2 分钟，只能读取编排状态，不能开终端或写文件。它按命令显式开启（`--t3-auto` 或 `MODELPACE_AUTO=1`）；不想用就改用 `--snapshot`，或 `--t3-origin` 加自己的令牌。每次 `plan --t3-auto` 签发一次会话；`dashboard` 还会扫描本机会话日志算 Speed；`serve` 在页面打开期间每 15 秒重跑一遍完整加载，所以 `serve --t3-auto` 每 15 秒签发并吊销一次会话。

令牌建议走 `MODELPACE_TOKEN` 或 `--t3-token-cmd`，不要用命令行参数 `--t3-token`（进程列表可见）。

## 核心特性

- **零外部运行时依赖**：纯 Node.js ESM（`>= 22.0.0`），仅使用内置 `node:*`、全局 `fetch` 与 `WebSocket`，无需 `node_modules`。
- **直连 T3 WebSocket RPC**：通过 `/api/auth/websocket-ticket` 与 `/ws?orchestrationProtocol=2` 实时拉取 `server.getConfig`（`usageLimits` 与 `usageLimitSources`），支持显式 `bearer` 或外部 `tokenCommand`，绝不直接读取任何凭据缓存文件。
- **统一快照 `UsageSnapshot v2`**：规整 Codex、Claude、Gemini / Antigravity（多实例及 `gemini`/`carbon`/`argon`/`3p` 池隔离）、Grok、OpenCode 与按量付费 API 预算。
- **Even Pace 与重置卡门控**：
  - 长周期窗口对比 `effectiveRemainingPercent` 与 `remainingTimePercent`。
  - 支持短窗突发上限（`shortWindowMaxUsedPercent`）与副号泄洪阈值（`maxShortUsedPercent`）。
  - 支持 Codex（`codexRateLimits`）与 Claude（`claudeSession`、`claudeWeekly`、`claudeFable`、`claudeFull`）重置卡覆盖、持卡节奏与临近自然重置跳过逻辑。
- **质量 × 速度融合排序**：
  - 精确 Beta(1, 1) 后验通过率与 90% 置信区间（Lanczos log-Gamma + 续分数）。
  - 区分 `qualified`、`trial`（冷启动不拦截）与 `below_threshold`（支持 `demote` / `strict` / `advisory`）。
  - 达标模型按成功任务耗时中位数升序，在容差范围内按 Speed `longRate`（tok/s）与 Even Pace 富余度决胜。
- **本机 Speed 排行**：只读解析自己的会话日志（Claude Code、Codex、OpenCode，以及 Antigravity / Gemini 的通用事件格式）测出真实输出速度；稀疏对数直方图（桶比 1.02，中位数误差 ≤ 1%）、增量缓存，并作为 `plan` 的决胜因子。
- **零配置连接 T3**（`--t3-auto`）：自动发现本机 T3 Code，经官方 `auth session issue` 签发 2 分钟、仅含 `orchestration:read` 的会话，读取 `server.getConfig` 后必定吊销；不读取任何凭据文件。
- **自包含仪表盘**：单文件 HTML（无 CDN、明暗主题、EN/ZH 切换），含额度与 Even Pace、速度排行及一键分享图（1200px @2x PNG）、验收评分与派发审计。
- **CLI 与零依赖 MCP Server**：
  - `modelpace`（`plan`、`record`、`scores`、`speed`、`dashboard`、`serve`、`validate`、`init`，支持 `--lang en|zh` 与 `--format`）
  - `modelpace-mcp`（标准 stdio JSON-RPC 2.0 MCP Server，提供 `dispatch_plan`、`dispatch_record`、`dispatch_scores`、`dispatch_speed`）
- **实验性 T3 插件**（`plugin/`，仅在仓库内）：见下文「T3 插件」。

## Speed 与仪表盘

```bash
# 本机速度排行（text | json | html）
node ./bin/modelpace.mjs speed --days 30
node ./bin/modelpace.mjs speed --format html --out speed.html

# 零配置：连本机 T3 规划，并把实测速度并入决策
node ./bin/modelpace.mjs plan --t3-auto --speed-scan --task slice

# 自包含 HTML 仪表盘，或本机实时服务
node ./bin/modelpace.mjs dashboard --t3-auto --scores dispatch-scores.jsonl --out dashboard.html
node ./bin/modelpace.mjs serve --t3-auto --scores dispatch-scores.jsonl --port 8787
```

口径（单次请求）：输出 token ÷ 墙钟耗时，仅统计输出 ≥ 100 token 且 0.5 秒 < 耗时 < 900 秒的请求。主指标是输出 ≥ 1000 token 请求的 tok/s 中位数；长请求少于 20 次的行标「样本少」，不参与 `plan` 决胜。「派发通过」列与验收评分共用同一成功公式。

单请求 tok/s 与端到端 `delegate_task` 墙钟耗时不同：高频短切片委派的端到端中位耗时通常在 2–6 分钟，而重型长程交付跨越多次工具调用与核验可达 15–20 分钟以上；因此 `plan` 先按账本任务耗时中位数排序，只在耗时相近时用 Speed 决胜。当会话日志带有输入与缓存字段时（Claude Code、Codex 或通用事件），`speed` 还会额外聚合可选的 `cacheHitRate`（`cachedInputTokens / inputTokens`，范围 `0..1`，文本表在有样本时展示 `cache=` 列），仅作额度消耗效率观测，不改 `plan` 排序权重。

数据源（全部只读、路径均可覆盖）：`MODELPACE_CLAUDE_DIR`（默认 `~/.claude/projects`）、`MODELPACE_CODEX_DIR`（`~/.codex/sessions`）、`MODELPACE_OPENCODE_DB`（`~/.local/share/opencode/opencode.db`，需要 `node:sqlite`）、`MODELPACE_ANTIGRAVITY_PATHS`（默认 `~/.gemini/antigravity`，JSONL 文件或含 `speed_events` 表的 SQLite，每请求一条 `{ model, outputTokens, startedAt, endedAt }`）。`MODELPACE_SPEED_CACHE` 指定增量缓存位置（默认 `~/.cache/modelpace/speed-cache.json`）。

`--t3-auto` / `MODELPACE_AUTO=1` 依次找 `MODELPACE_T3_BIN`、`PATH` 中的 `t3`、macOS 上 bundle id 为 `com.t3tools.t3code` 的应用；服务 origin 取自 `T3CODE_HOME`（默认 `~/.t3`）下运行中服务的 `userdata/server-runtime.json`，或 `MODELPACE_ORIGIN`。

仪表盘是纯函数：`renderDashboardHtml({ decision, snapshot, scoresSummary, speedRanking, options })` 返回 HTML 字符串，也可直接用于 T3 Code 的 `html_render`。

## T3 插件（实验性）

`plugin/` 是 Agent Plugins 1.0 包，只适用于实现了它所声明的插件宿主扩展（扩展命名空间 `com.jieyuexing.t3code`）的 T3 Code 构建；官方 T3 Code 发行版没有插件宿主，装了也不起作用。它不在 npm 包里，需从检出目录使用（复用 `../src` 的引擎）：侧栏视图 `dashboard`、只读服务 `dispatch.plan`、`dispatch.scores`、`dispatch.speed`，以及本机 T3 连接、快照、配置、评分文件、速度窗口等设置项。

## MCP 集成

MCP Server 走 stdio。在你的 Agent 所用的客户端里注册，路径写检出目录的绝对路径（T3 Code 自己拉起 Claude 和 Codex，并且按其源码会加载它们的常规设置——Claude 的 user、project、local 三级设置与 Codex 的 `config.toml`，除非某个供应商实例单独指定了 home 目录——所以没有单独的 T3 Code MCP 设置；这是读源码得出的，没有实际运行）：

```bash
# Claude Code
claude mcp add modelpace -- node /absolute/path/to/modelpace/bin/modelpace-mcp.mjs
# Codex CLI
codex mcp add modelpace -- node /absolute/path/to/modelpace/bin/modelpace-mcp.mjs
```

以上默认不访问额度。要让服务读取本机 T3 Code 的额度（2 分钟、仅 `orchestration:read` 的会话，见「连接 T3 Code」），Claude Code 在名字后加 `-e MODELPACE_AUTO=1`，Codex 加 `--env MODELPACE_AUTO=1`。

Codex 的 `~/.codex/config.toml`（`env` 表即开启 `--t3-auto`，不想访问额度就删掉）：

```toml
[mcp_servers.modelpace]
command = "node"
args = ["/absolute/path/to/modelpace/bin/modelpace-mcp.mjs"]

[mcp_servers.modelpace.env]
MODELPACE_AUTO = "1"
```

其他 MCP 客户端（JSON；`MODELPACE_AUTO` 即开启 `--t3-auto`，不想访问额度就删掉）：

```json
{
  "mcpServers": {
    "modelpace": {
      "command": "node",
      "args": ["/absolute/path/to/modelpace/bin/modelpace-mcp.mjs"],
      "env": {
        "MODELPACE_CONFIG": "/path/to/dispatch.config.json",
        "MODELPACE_SCORES": "/path/to/dispatch-scores.jsonl",
        "MODELPACE_AUTO": "1"
      }
    }
  }
}
```

发布到 npm 后，把 `node /absolute/path/.../modelpace-mcp.mjs` 换成 `npx -y -p modelpace modelpace-mcp`：包名是 `modelpace`，`modelpace-mcp` 只是它的第二个可执行名，直接写 `npx -y modelpace-mcp` 会去找另一个包。配置与账本都可省略（用内置策略与默认账本）；去掉 `MODELPACE_AUTO` 即不访问额度。提供的工具：`dispatch_plan`、`dispatch_record`、`dispatch_scores`、`dispatch_speed`，入参与返回见 [AGENTS.md](./AGENTS.md)。

## 运行测试

```bash
node --test test/*.test.mjs
```

## 许可证

[MIT](./LICENSE)

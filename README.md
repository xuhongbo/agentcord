# agentcord

通过 Discord 在本地运行和管理 AI 编程助手会话。支持 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 和 OpenAI Codex。

每个会话对应一个 Discord 频道，会话按项目分类。本地用 `claude` 或 `codex` 启动的 CLI 会话也会自动同步到 Discord。

---

## 快速开始

```bash
npm install -g agentcord
agentcord setup              # 交互式配置向导（Discord Token、服务器 ID 等）
agentcord daemon install     # 安装为后台服务（可选，推荐）
agentcord                    # 启动 bot
```

挂载你的项目：

```bash
cd ~/Dev/my-api
agentcord project init --name my-api
```

挂载后，Discord 服务器里会自动出现 `my-api` 分类，之后在该目录的所有会话都会归到这个分类下。

---

## 整体架构

### 启动流程

```
agentcord (CLI)
  └── bot.ts
        ├── 注册 Discord 斜杠命令
        ├── 加载项目注册表 (projects.json)
        ├── 加载持久化会话 (sessions.json)
        ├── 确保每个项目的 Discord 分类存在
        ├── 启动本地会话同步（每 30 秒）
        └── 每 30 秒刷新 Bot 状态（空闲 / N 个会话运行中）
```

### 消息流转

```
用户在 Discord 频道发送消息
  │
  ├── message-handler.ts
  │     ├── 鉴权（allowedUsers / allowAllUsers）
  │     ├── 限速检查（rateLimitMs）
  │     ├── 解析附件（图片 base64 编码，文本文件直接读取）
  │     └── 若 agent 正在生成 → 先 abort 再重发
  │
  ├── session-executor.ts
  │     ├── 普通模式：直接调用 provider.sendPrompt()
  │     └── monitor 模式：Worker + Monitor 双 agent 循环（最多 6 轮）
  │
  ├── provider（claude-provider / codex-provider）
  │     └── AsyncGenerator<ProviderEvent> 流式事件
  │
  └── output-handler.ts
        ├── text_delta     → 实时编辑 Discord 消息（400ms 批量更新）
        ├── ask_user       → 渲染问题 embed + 按钮/下拉菜单
        ├── task           → 渲染任务看板 embed（带状态 emoji）
        ├── tool_start/result → verbose 模式下展示工具调用（可展开）
        ├── result         → 显示耗时/费用 + 模式切换按钮
        └── error          → 红色 embed 显示错误
```

### 模块职责

| 模块 | 职责 |
|------|------|
| `cli.ts` | CLI 入口，分发 config / project / daemon / start 命令 |
| `bot.ts` | Discord 客户端生命周期、事件监听、日志缓冲 |
| `session-manager.ts` | 会话 CRUD、AbortController、模式系统提示、持久化 |
| `session-executor.ts` | 执行会话（普通/monitor 循环）、watchdog 超时（45s） |
| `session-sync.ts` | 30s 轮询，同步本地 Claude/Codex 会话到 Discord |
| `output-handler.ts` | ProviderEvent → Discord embeds/buttons/消息 |
| `message-handler.ts` | 入站消息解析、鉴权、附件处理 |
| `button-handler.ts` | 按钮交互（ask_user 答题、模式切换、展开内容） |
| `project-manager.ts` | 项目 personality/skills/MCP 服务器管理 |
| `project-registry.ts` | `~/.agentcord/projects.json` CRUD |
| `global-config.ts` | Configstore 读写，敏感值脱敏 |
| `persistence.ts` | 通用 JSON Store，原子写入，数据目录 `~/.agentcord/` |
| `codex-session-discovery.ts` | 读取 Codex session index，提取 cwd，匹配已挂载项目 |

### Provider 抽象

所有 AI provider 实现统一接口（`src/providers/types.ts`）：

```
Provider.sendPrompt(prompt, options)  → AsyncGenerator<ProviderEvent>
Provider.continueSession(options)     → AsyncGenerator<ProviderEvent>
```

统一事件协议 `ProviderEvent`：`text_delta` / `tool_start` / `tool_result` / `ask_user` / `task` / `command_execution` / `file_change` / `reasoning` / `todo_list` / `session_init` / `result` / `error`

- **claude-provider** — 使用 `@anthropic-ai/claude-agent-sdk` 的 `query()`，系统提示通过 `systemPrompt.append` 注入
- **codex-provider** — 使用 `@openai/codex-sdk` 的 `Codex` + `Thread.runStreamed()`，系统提示通过临时 AGENTS.md 哨兵块注入

---

## Discord 上的项目呈现

### 频道结构

```
Discord 服务器
  ├── #bot-logs                    ← bot 运行日志（2s 批量写入）
  │
  ├── my-api（分类）               ← agentcord project init --name my-api
  │    ├── #claude-fix-auth        ← Discord 创建的会话（source: remote）
  │    ├── #claude-add-tests       ← 同项目另一个会话
  │    └── #codex-refactor-db      ← 本地 codex 会话自动同步（source: local-sync）
  │
  └── frontend（分类）             ← agentcord project init --name frontend
       ├── #claude-redesign
       └── #claude-new-components
```

- 每个已挂载项目对应一个 Discord **分类（Category）**，bot 启动时自动创建缺失的分类
- 每个 AI 会话对应分类下一个**文字频道**，频道名格式：`{provider}-{会话名}`
- 频道 Topic 记录 provider 类型、工作目录、provider 会话 ID（用于同步和恢复）

### 在 Discord 创建会话

在 Discord 任意频道输入：

```
/session new name:fix-auth project:my-api
/session new name:add-tests project:my-api provider:claude mode:plan
/session new name:refactor project:my-api provider:codex sandbox-mode:workspace-write
```

`project` 参数支持**自动补全**，列出所有已挂载项目。创建后自动在对应分类下建立频道，在该频道发消息即开始与 agent 对话。

### 在 Discord 恢复终端会话

如果你在终端用 `claude` 或 `codex` 启动了会话，可手动绑定到 Discord：

```
/session resume session-id:<provider-session-id> name:my-session project:my-api
```

或等待自动同步（30 秒内）。

### 会话频道内的交互

**发消息** — 直接在频道内发消息，agent 实时回复并持续编辑同一条消息（400ms 节拍）。

**打断** — 发送新消息自动 abort 当前生成，重新执行新指令。

**按钮交互** — agent 回复结束后出现：
- **模式切换按钮**：`Auto` / `Plan` / `Normal` / `Monitor`（当前模式高亮）
- **快捷回复按钮**：若回复包含编号列表，自动生成选项按钮；若以是/否问题结尾，生成 Yes/No 按钮

**ask_user 问题** — agent 主动提问时渲染为 embed，4 个以内选项显示为按钮，5 个以上显示为下拉菜单；多问题同时呈现时逐一作答后统一提交。

**任务看板** — agent 调用 Task 工具时渲染为 embed，含状态 emoji（待处理 / 进行中 / 完成）。

**工具调用（verbose 模式）** — 默认隐藏，`/session verbose` 开启后每次工具调用/结果都显示为 embed，超过 1KB 时折叠并提供"展开"按钮。

---

## 本地会话自动同步

本地启动的 CLI 会话（无需任何额外操作）会在 30 秒内自动出现在 Discord：

**条件**：会话的工作目录（`cwd`）在某个已挂载项目的路径下。

### Claude 会话同步

```bash
cd ~/Dev/my-api
claude                          # 正常使用 claude CLI
# → 30 秒内自动在 Discord my-api 分类下出现新频道
```

bot 调用 `@anthropic-ai/claude-agent-sdk` 的 `listSessions({ dir: projectPath })` 发现会话。

### Codex 会话同步

```bash
cd ~/Dev/my-api
codex                           # 正常使用 codex CLI
# → 30 秒内自动同步到 Discord
```

bot 读取 `~/.codex/session_index.jsonl`，定位会话文件，从第一条 `session_meta` 记录提取 `cwd`，匹配已挂载项目路径。

### 同步行为

- 同一个 provider 会话只创建一次频道（通过 topic 中的 session ID 做幂等校验）
- 同步创建的频道与手动创建的完全相同，均可在 Discord 内继续对话
- 频道 topic 标注 `(synced)` 以区分来源

### 在终端恢复 Discord 会话

反向操作：在 Discord 频道内执行 `/session attach`，获取终端恢复命令：

```bash
claude --resume <session-id>
codex --resume <session-id>
```

---

## 会话模式

| 模式 | 行为 |
|------|------|
| `auto` | 完全自主，agent 直接执行所有操作 |
| `plan` | 每个任务开始前必须用 `EnterPlanMode` 呈现计划，用户确认后再执行 |
| `normal` | 破坏性操作（删文件、大范围重构等）前用 `AskUserQuestion` 确认 |
| `monitor` | 双 agent 循环：Worker 执行 → Monitor 评估是否完成 → 最多循环 6 轮 |

**Monitor 模式详细流程：**

```
用户发送目标
  │
  ├── Iteration 1
  │     Worker Pass（执行任务，45s watchdog）
  │     ↓
  │     Monitor Review（评估完成度）
  │     ├── complete  → 输出完成摘要，结束
  │     ├── blocked   → 说明阻塞原因，结束
  │     └── continue  → 生成"下一步证明合约"，进入下一轮
  │
  ├── Iteration 2-6（同上，携带上轮 steering 指令）
  │
  └── 达到 6 轮上限 → 输出当前进度
```

在任意频道内可随时用 `/session mode <mode>` 切换，或点击回复底部的模式按钮。

---

## CLI 命令

### `agentcord config` — 全局配置

配置存储在全局 Configstore，不依赖 `.env` 文件。

```bash
agentcord setup                    # 交互式配置向导
agentcord config setup             # 同上
agentcord config list              # 列出所有配置项
agentcord config get <key>         # 读取某项配置
agentcord config set <key> <value> # 写入某项配置
agentcord config unset <key>       # 删除某项配置
agentcord config path              # 显示配置文件路径
```

| 配置项 | 说明 |
|--------|------|
| `DISCORD_TOKEN` | Discord bot token（必填） |
| `DISCORD_CLIENT_ID` | Discord 应用 ID（必填） |
| `DISCORD_GUILD_ID` | 服务器 ID，用于即时注册命令（可选） |
| `ALLOWED_USERS` | 允许使用的用户 ID，逗号分隔 |
| `ALLOW_ALL_USERS` | `true` / `false`，允许服务器所有用户 |
| `CODEX_SANDBOX_MODE` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `CODEX_APPROVAL_POLICY` | `never` \| `on-request` \| `on-failure` \| `untrusted` |
| `CODEX_NETWORK_ACCESS_ENABLED` | `true` / `false` |
| `MESSAGE_RETENTION_DAYS` | 消息保留天数 |
| `RATE_LIMIT_MS` | 限速间隔（毫秒） |
| `SHELL_ENABLED` | `true` / `false`，启用 shell 命令执行 |
| `SHELL_ALLOWED_USERS` | 允许执行 shell 命令的用户 ID，逗号分隔 |

### `agentcord project` — 项目挂载

在项目目录下执行：

```bash
agentcord project init [--name <名称>]  # 挂载当前目录
agentcord project list                  # 列出所有已挂载项目
agentcord project info                  # 显示当前目录项目信息
agentcord project rename <新名称>        # 重命名
agentcord project remove                # 取消挂载
```

### `agentcord daemon` — 后台服务

```bash
agentcord daemon install    # 安装并启动（macOS: LaunchAgent，Linux: systemd）
agentcord daemon uninstall  # 停止并移除
agentcord daemon status     # 查看状态
```

日志输出到 `~/.agentcord/agentcord.log`。

---

## Discord 命令

### `/session` — 会话管理

| 命令 | 说明 |
|------|------|
| `/session new <name> <project>` | 创建新会话，project 支持自动补全 |
| `/session resume <session-id> <name> <project>` | 将终端会话绑定到 Discord |
| `/session list` | 列出所有活跃会话 |
| `/session end` | 结束当前频道会话 |
| `/session continue` | 继续上一次对话 |
| `/session stop` | 中止当前生成 |
| `/session output [lines]` | 查看最近输出（默认 50 行，最多 500） |
| `/session attach` | 获取终端恢复命令 |
| `/session sync` | 重新连接孤立频道 |
| `/session model <model>` | 更改模型 |
| `/session id` | 显示 provider 会话 ID |
| `/session verbose` | 切换工具调用显示 |
| `/session mode <mode>` | 设置会话模式 |
| `/session goal [goal] [clear]` | 查看/更新 monitor 目标 |

创建 Codex 会话时额外支持：`sandbox-mode` / `approval-policy` / `network-access`

### `/shell` — Shell 执行（需 `SHELL_ENABLED=true`）

| 命令 | 说明 |
|------|------|
| `/shell run <command>` | 在会话目录执行命令 |
| `/shell processes` | 列出运行中进程 |
| `/shell kill <pid>` | 终止进程 |

### `/agent` — 人格切换

| 命令 | 说明 |
|------|------|
| `/agent use <persona>` | 切换人格 |
| `/agent list` | 列出可用人格 |
| `/agent clear` | 重置为默认 |

可用人格：`code-reviewer` / `architect` / `debugger` / `security` / `performance` / `devops` / `general`

### `/project` — 项目配置

| 命令 | 说明 |
|------|------|
| `/project personality <prompt>` | 设置项目系统提示词 |
| `/project personality-show` | 查看当前提示词 |
| `/project personality-clear` | 清除提示词 |
| `/project skill-add <name> <prompt>` | 添加 skill（支持 `{input}` 占位符） |
| `/project skill-run <name> [input]` | 执行 skill |
| `/project skill-list` | 列出所有 skill |
| `/project skill-remove <name>` | 删除 skill |
| `/project mcp-add <name> <command> [args]` | 注册 MCP 服务器（写入 `.mcp.json`） |
| `/project mcp-list` | 列出 MCP 服务器 |
| `/project mcp-remove <name>` | 移除 MCP 服务器 |
| `/project info` | 显示项目配置 |
| `/project list` | 列出所有已挂载项目及 Discord 状态 |

### `/plugin` — 插件管理

| 命令 | 说明 |
|------|------|
| `/plugin browse [search]` | 浏览可用插件 |
| `/plugin install <plugin> [scope]` | 安装插件（`user`/`project`/`local`） |
| `/plugin remove <plugin> [scope]` | 卸载插件 |
| `/plugin list` | 列出已安装插件 |
| `/plugin info <plugin>` | 查看插件详情 |
| `/plugin enable/disable <plugin>` | 启用/禁用插件 |
| `/plugin update <plugin>` | 更新插件 |
| `/plugin marketplace-add <source>` | 添加插件市场（GitHub repo 或 git URL） |
| `/plugin marketplace-remove <name>` | 移除插件市场 |
| `/plugin marketplace-list` | 列出已注册市场 |
| `/plugin marketplace-update [name]` | 更新市场目录 |

---

## 数据存储

```
~/.agentcord/
  ├── projects.json        # 已挂载项目注册表
  ├── sessions.json        # 持久化会话（含 providerSessionId、模式、费用等）
  ├── agentcord.log        # 运行日志
  └── agentcord.error.log  # 错误日志
```

内存中（不持久化）：工具调用的可展开内容（10 分钟 TTL）、待回答的 ask_user 问题、频道→会话映射（从 sessions.json 重建）。

---

## 环境要求

- **Node.js 22.6+**（原生 TypeScript 执行）
- **Claude Code**（`@anthropic-ai/claude-agent-sdk`）
- **OpenAI Codex SDK**（可选，`@openai/codex-sdk`）

---

## 开发

```bash
git clone https://github.com/xuhongbo/agentcord.git
cd agentcord
pnpm install
agentcord setup            # 配置 Discord 连接
pnpm dev                   # 构建 + 监听 + 自动重启
pnpm build                 # tsup 构建（ESM，Node 22）
pnpm typecheck             # tsc --noEmit
pnpm test                  # vitest run（全部测试）
pnpm test -- test/foo.test.ts  # 单个测试文件
```

## License

MIT

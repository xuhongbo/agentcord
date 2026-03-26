# agentcord

通过 Discord 在本地运行和管理 AI 编程助手会话。支持 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 和 OpenAI Codex。

每个会话对应一个 Discord 频道，会话按项目分类——同一代码库可创建多个会话，各自拥有独立频道。本地启动的 CLI 会话也会自动同步到 Discord。

## 快速开始

```bash
npm install -g agentcord
agentcord setup        # 交互式配置向导
agentcord daemon install  # 安装为后台服务（可选）
agentcord              # 启动 bot
```

在项目目录中挂载项目：

```bash
cd ~/Dev/my-api
agentcord project init --name my-api
```

配置向导会引导你创建 Discord 应用、配置 bot token，并将 bot 添加到服务器。

## 环境要求

- **Node.js 22.6+**（使用原生 TypeScript 执行）
- **Claude Code**（`@anthropic-ai/claude-agent-sdk`）
- **OpenAI Codex SDK**（可选，`@openai/codex-sdk`）

## 工作原理

```
Discord 消息 → SDK query() → 编程助手
                                  ↓
Discord 消息 ← 流式处理 ← 异步迭代器
```

```
Discord 服务器
  └── my-api（分类）
  │    ├── #claude-fix-auth        ← ~/Dev/my-api 中的会话
  │    ├── #claude-add-tests       ← 同项目另一个会话
  │    └── #project-logs
  └── frontend（分类）
       ├── #claude-redesign        ← ~/Dev/frontend 中的会话
       └── #project-logs
```

本地用 `claude` 或 `codex` 启动的会话，只要 `cwd` 在已挂载项目目录下，每 30 秒会自动同步到 Discord 对应频道。

---

## CLI 命令

### `agentcord config` — 全局配置管理

配置存储在全局 Configstore，不依赖 `.env` 文件。

```bash
agentcord setup                    # 交互式配置向导（等同于 config setup）
agentcord config setup             # 交互式配置向导
agentcord config list              # 列出所有配置项
agentcord config get <key>         # 读取某项配置
agentcord config set <key> <value> # 写入某项配置
agentcord config unset <key>       # 删除某项配置
agentcord config path              # 显示配置文件路径
```

**配置项说明：**

| 配置项 | 说明 |
|--------|------|
| `DISCORD_TOKEN` | Discord bot token（必填） |
| `DISCORD_CLIENT_ID` | Discord 应用 ID（必填） |
| `DISCORD_GUILD_ID` | 服务器 ID，用于即时注册命令（可选） |
| `ALLOWED_USERS` | 允许使用的用户 ID，逗号分隔 |
| `ALLOW_ALL_USERS` | `true` 或 `false`，允许服务器所有用户 |
| `CODEX_SANDBOX_MODE` | `read-only` \| `workspace-write` \| `danger-full-access` |
| `CODEX_APPROVAL_POLICY` | `never` \| `on-request` \| `on-failure` \| `untrusted` |
| `CODEX_NETWORK_ACCESS_ENABLED` | `true` 或 `false` |
| `MESSAGE_RETENTION_DAYS` | 消息保留天数 |
| `RATE_LIMIT_MS` | 限速间隔（毫秒） |
| `SHELL_ENABLED` | `true` 或 `false`，启用 shell 命令执行 |
| `SHELL_ALLOWED_USERS` | 允许执行 shell 命令的用户 ID，逗号分隔 |

---

### `agentcord project` — 项目挂载管理

在项目目录下执行：

```bash
agentcord project init [--name <名称>]  # 挂载当前目录为项目
agentcord project list                  # 列出所有已挂载项目
agentcord project info                  # 显示当前项目信息
agentcord project rename <新名称>        # 重命名当前项目
agentcord project remove                # 取消挂载当前项目
```

项目信息存储在 `~/.agentcord/projects.json`，Discord 分类在首次使用时自动创建。

---

### `agentcord daemon` — 后台服务管理

```bash
agentcord daemon install    # 安装并启动后台服务
agentcord daemon uninstall  # 停止并移除服务
agentcord daemon status     # 查看服务运行状态
```

- macOS：以 LaunchAgent 方式运行，开机自启
- Linux：以 systemd 服务运行，开机自启
- 日志：`~/.agentcord/agentcord.log`

---

## Discord 命令

### `/session` — 会话管理

| 命令 | 说明 |
|------|------|
| `/session new <name> <project> [provider] [mode]` | 创建新会话（project 支持自动补全） |
| `/session resume <session-id> <name> <project>` | 从终端恢复会话到 Discord |
| `/session list` | 列出所有活跃会话 |
| `/session end` | 结束当前频道的会话 |
| `/session continue` | 继续上一次对话 |
| `/session stop` | 中止当前生成 |
| `/session output [lines]` | 显示最近的对话输出（默认 50 行，最多 500） |
| `/session attach` | 显示在终端恢复会话的命令 |
| `/session sync` | 重新连接孤立的 provider 频道 |
| `/session model <model>` | 更改当前会话使用的模型 |
| `/session id` | 显示当前频道的 provider 会话 ID |
| `/session verbose` | 切换工具调用/结果的显示 |
| `/session mode <mode>` | 设置会话模式 |
| `/session goal [goal] [clear]` | 查看或更新监控目标（monitor 模式专用） |

**会话模式（`mode` 参数）：**

| 模式 | 说明 |
|------|------|
| `auto` | 完全自主，agent 自行决策 |
| `plan` | 执行前强制进入计划模式 |
| `normal` | 破坏性操作前询问用户 |
| `monitor` | 双 agent 循环，持续监控直到目标完成（最多 6 轮） |

创建 Codex 会话时支持额外参数：
- `sandbox-mode`: `read-only` \| `workspace-write` \| `danger-full-access`
- `approval-policy`: `never` \| `on-request` \| `on-failure` \| `untrusted`
- `network-access`: `true` / `false`

---

### `/shell` — Shell 命令执行

需要 `SHELL_ENABLED=true` 配置。

| 命令 | 说明 |
|------|------|
| `/shell run <command>` | 在会话目录中执行 shell 命令 |
| `/shell processes` | 列出运行中的后台进程 |
| `/shell kill <pid>` | 终止指定进程 |

---

### `/agent` — Agent 人格管理

| 命令 | 说明 |
|------|------|
| `/agent use <persona>` | 切换 agent 人格 |
| `/agent list` | 列出可用人格 |
| `/agent clear` | 重置为默认 |

**可用人格：** `code-reviewer` \| `architect` \| `debugger` \| `security` \| `performance` \| `devops` \| `general`

---

### `/project` — 项目配置

| 命令 | 说明 |
|------|------|
| `/project personality <prompt>` | 设置项目自定义系统提示词 |
| `/project personality-show` | 查看当前提示词 |
| `/project personality-clear` | 清除提示词 |
| `/project skill-add <name> <prompt>` | 添加可复用提示模板（支持 `{input}` 占位符） |
| `/project skill-run <name> [input]` | 执行某个 skill |
| `/project skill-list` | 列出所有 skill |
| `/project skill-remove <name>` | 删除某个 skill |
| `/project mcp-add <name> <command> [args]` | 注册 MCP 服务器（写入 `.mcp.json`） |
| `/project mcp-list` | 列出 MCP 服务器 |
| `/project mcp-remove <name>` | 移除 MCP 服务器 |
| `/project info` | 显示项目配置摘要 |
| `/project list` | 列出所有已挂载项目及 Discord 状态 |

---

### `/plugin` — 插件管理

| 命令 | 说明 |
|------|------|
| `/plugin browse [search]` | 浏览可用插件 |
| `/plugin install <plugin> [scope]` | 安装插件（scope: `user`/`project`/`local`） |
| `/plugin remove <plugin> [scope]` | 卸载插件 |
| `/plugin list` | 列出已安装插件 |
| `/plugin info <plugin>` | 查看插件详情 |
| `/plugin enable <plugin> [scope]` | 启用插件 |
| `/plugin disable <plugin> [scope]` | 禁用插件 |
| `/plugin update <plugin> [scope]` | 更新插件到最新版本 |
| `/plugin marketplace-add <source>` | 添加插件市场（GitHub repo 或 git URL） |
| `/plugin marketplace-remove <name>` | 移除插件市场 |
| `/plugin marketplace-list` | 列出已注册的插件市场 |
| `/plugin marketplace-update [name]` | 更新插件市场目录 |

---

## 功能特性

- **实时流式输出** — Agent 回复以流式方式更新到 Discord 消息
- **打字指示器** — Agent 工作时显示"正在输入..."
- **消息中断** — 发送新消息自动中断并重定向 agent
- **交互式提示** — 多选问题渲染为 Discord 按钮
- **任务看板** — Agent 任务列表以 embed 可视化展示
- **工具输出控制** — 默认隐藏，通过 `/session verbose` 切换
- **本地会话自动同步** — 本地 CLI 会话（Claude/Codex）每 30 秒自动同步到 Discord
- **项目级定制** — 系统提示词、skill 和 MCP 服务器均按项目隔离
- **Agent 人格** — 在不同编码角色间切换
- **会话持久化** — 会话在 bot 重启后仍然存在
- **终端互通** — 用 `claude --resume <session-id>` 或 `codex --resume <session-id>` 在终端继续任意会话

---

## 数据存储

所有数据存储在 `~/.agentcord/`：

```
~/.agentcord/
  ├── projects.json      # 已挂载项目注册表
  ├── sessions.json      # 会话数据
  ├── agentcord.log      # 运行日志
  └── agentcord.error.log
```

---

## 开发

```bash
git clone https://github.com/xuhongbo/agentcord.git
cd agentcord
pnpm install
agentcord setup        # 配置 Discord 连接
pnpm dev               # 构建 + 监听 + 自动重启
pnpm build             # 使用 tsup 构建（ESM，Node 22）
pnpm typecheck         # tsc --noEmit
pnpm test              # vitest run（全部测试）
pnpm test -- test/specific.test.ts  # 运行单个测试文件
```

## License

MIT

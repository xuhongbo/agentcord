# threadcord

通过 Discord 在本机运行和管理多代理编程会话。

## 核心模型

```text
Discord Server
└─ Category = Project
   ├─ #history (Forum) = Archived Sessions
   └─ #claude-fix-login = Main Agent Session
      └─ [sub:codex] benchmark = Subagent Thread
```

- `Category` 表示一个已挂载并绑定的本地项目
- `TextChannel` 表示一个主代理会话
- `Thread` 表示一个子代理
- `#history` Forum 用于归档历史会话

## 安装

```bash
pnpm install
pnpm build
pnpm link --global
```

安装后会得到全局命令：

```bash
threadcord
```

## 初始化

### 1. 配置全局凭据

```bash
threadcord config setup
```

或直接写入：

```bash
threadcord config set DISCORD_TOKEN <token>
threadcord config set DISCORD_CLIENT_ID <client-id>
threadcord config set DISCORD_GUILD_ID <guild-id>
threadcord config set ALLOW_ALL_USERS true
```

### 2. 显式挂载本地项目

在项目目录内执行：

```bash
threadcord project init --name my-project
```

### 3. 启动机器人

```bash
threadcord
```

### 4. 在 Discord 中绑定项目

在目标 Category 下任意文本频道执行：

```text
/project setup project:my-project
```

绑定成功后会自动创建或复用 `#history` Forum。

## 主要命令

### 本地 CLI

```bash
threadcord config setup
threadcord config get <key>
threadcord config set <key> <value>
threadcord config list
threadcord config path

threadcord project init [--name <name>]
threadcord project list
threadcord project info
threadcord project rename <new-name>
threadcord project remove

threadcord daemon install
threadcord daemon uninstall
threadcord daemon status
```

### Discord Slash Commands

- `/project setup`：把当前 Category 绑定到已挂载项目
- `/project info`：查看项目信息
- `/agent spawn`：创建主代理会话频道
- `/agent archive`：归档当前主会话到 `#history`
- `/agent mode` / `/agent goal` / `/agent persona` / `/agent model`
- `/subagent run`：在当前主会话下创建子代理线程
- `/subagent list`：查看当前会话的子代理
- `/shell run` / `/shell processes` / `/shell kill`

## 特性

- 全局配置：不依赖 `.env` 主运行路径
- 显式项目挂载：本地先 `threadcord project init`
- Discord 项目绑定：再用 `/project setup`
- 子代理线程模型
- `#history` Forum 归档
- 自动归档
- 支持 Claude 与 Codex
- 支持 `CODEX_PATH`、`CODEX_API_KEY`、`CODEX_BASE_URL`
- 支持 `ANTHROPIC_API_KEY`、`ANTHROPIC_BASE_URL`
- 支持后台守护进程安装

## 开发验证

```bash
pnpm typecheck
pnpm build
pnpm test
```

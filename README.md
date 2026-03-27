# threadcord

> Run and manage multi-agent coding sessions from Discord, backed by local projects on your machine.

[简体中文说明](./README.zh-CN.md)

> Repository name: `agentcord`  
> CLI/package name: `threadcord`

## Overview

`threadcord` maps Discord structures to local development workflows:

```text
Discord Server
└─ Category = Project
   ├─ #history (Forum) = Archived Sessions
   └─ #claude-fix-login = Main Agent Session
      └─ [sub:codex] benchmark = Subagent Thread
```

- A `Category` represents one mounted local project.
- A `TextChannel` represents a main agent session.
- A `Thread` represents a subagent.
- The `#history` forum stores archived sessions.

## Features

- Explicit local project mounting with `threadcord project init`
- Discord-side project binding with `/project setup`
- Main session channels and subagent threads
- Session archiving into `#history`
- Support for both Claude and Codex providers
- Global config storage without requiring a project-local `.env`
- Optional daemon install and background management

## Requirements

- `Node >= 22.6.0`
- `pnpm`
- A Discord application, bot token, client ID, and guild ID

## Installation

```bash
pnpm install
pnpm build
pnpm link --global
```

After linking, the global command is:

```bash
threadcord
```

## Quick Start

### 1. Configure global credentials

```bash
threadcord config setup
```

Or set values directly:

```bash
threadcord config set DISCORD_TOKEN <token>
threadcord config set DISCORD_CLIENT_ID <client-id>
threadcord config set DISCORD_GUILD_ID <guild-id>
threadcord config set ALLOW_ALL_USERS true
```

### 2. Mount a local project

Run inside your project directory:

```bash
threadcord project init --name my-project
```

### 3. Start the bot

```bash
threadcord
```

### 4. Bind the Discord category to the mounted project

Run this in any text channel under the target category:

```text
/project setup project:my-project
```

If successful, `threadcord` creates or reuses the `#history` forum automatically.

## Commands

### Local CLI

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

- `/project setup` — bind the current category to a mounted project
- `/project info` — inspect project binding details
- `/agent spawn` — create a main agent session channel
- `/agent archive` — archive the current session into `#history`
- `/agent mode` / `/agent goal` / `/agent persona` / `/agent model`
- `/subagent run` — create a subagent thread under the current session
- `/subagent list` — list subagents for the current session
- `/shell run` / `/shell processes` / `/shell kill`

## Development

Run the standard verification flow:

```bash
pnpm typecheck
pnpm build
pnpm test
```

Additional scripts:

```bash
pnpm test:integration:smoke
pnpm test:multi-session:smoke
pnpm test:session-sync:smoke
pnpm test:monitor:e2e
pnpm test:acceptance:local
```

See also: [`docs/ACCEPTANCE.md`](./docs/ACCEPTANCE.md)

## Contributing

Please read [`AGENTS.md`](./AGENTS.md) for repository-specific contributor guidelines.

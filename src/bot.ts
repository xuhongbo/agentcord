import {
  Client,
  GatewayIntentBits,
  ActivityType,
  InteractionType,
  ComponentType,
  ChannelType,
  type TextChannel,
} from 'discord.js';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.ts';
import { registerCommands } from './commands.ts';
import {
  handleProject,
  handleAgent,
  handleSubagent,
  handleShell,
  handleSpawnShortcut,
  handleStopShortcut,
  handleEndShortcut,
  handleRunShortcut,
  setLogger,
} from './command-handlers.ts';
import { handleMessage } from './message-handler.ts';
import { handleButton, handleSelectMenu } from './button-handler.ts';
import {
  loadSessions,
  getAllSessions,
  endSession,
  getSessionByChannel,
} from './thread-manager.ts';
import { loadProjects } from './project-manager.ts';
import { runSubagentWatchdog } from './subagent-manager.ts';
import { loadArchived, checkAutoArchive } from './archive-manager.ts';
import { startSync, stopSync } from './session-sync.ts';

let client: Client;
let logChannel: TextChannel | null = null;
let logBuffer: string[] = [];
let logTimer: ReturnType<typeof setTimeout> | null = null;

// ─── Process lock ─────────────────────────────────────────────────────────────

const LOCK_FILE = join(config.dataDir, 'bot.lock');

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(): boolean {
  if (existsSync(LOCK_FILE)) {
    try {
      const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      if (!Number.isNaN(pid) && isProcessRunning(pid)) {
        console.error(`[bot] Another instance is already running (PID ${pid}). Exiting.`);
        return false;
      }
    } catch { /* stale lock file */ }
    // Stale lock — remove it
    try { unlinkSync(LOCK_FILE); } catch { /* ignore */ }
  }
  writeFileSync(LOCK_FILE, process.pid.toString(), 'utf-8');
  return true;
}

function releaseLock(): void {
  try {
    if (existsSync(LOCK_FILE)) {
      const pid = parseInt(readFileSync(LOCK_FILE, 'utf-8').trim(), 10);
      // Only delete if it's our lock
      if (pid === process.pid) {
        unlinkSync(LOCK_FILE);
      }
    }
  } catch { /* ignore */ }
}

// ─── Logging ──────────────────────────────────────────────────────────────────

function botLog(msg: string): void {
  const timestamp = new Date().toISOString().slice(11, 19);
  const formatted = `\`[${timestamp}]\` ${msg}`;
  console.log(`[${timestamp}] ${msg}`);

  logBuffer.push(formatted);
  if (!logTimer) {
    logTimer = setTimeout(flushLogs, 2000);
  }
}

async function flushLogs(): Promise<void> {
  logTimer = null;
  if (!logChannel || logBuffer.length === 0) return;
  const batch = logBuffer.splice(0, logBuffer.length).join('\n');
  try {
    await logChannel.send(batch);
  } catch {
    // Log channel may have been deleted
  }
}

function updatePresence(): void {
  const all = getAllSessions();
  const generating = all.filter(s => s.isGenerating).length;

  if (all.length === 0) {
    client.user?.setPresence({
      status: 'idle',
      activities: [{ name: 'No active agents', type: ActivityType.Custom }],
    });
  } else {
    const label = generating > 0 ? `${generating} generating` : `${all.length} agents`;
    client.user?.setPresence({
      status: 'online',
      activities: [{ name: label, type: ActivityType.Watching }],
    });
  }
}

async function cleanupOldMessages(): Promise<void> {
  if (!config.messageRetentionDays) return;
  const cutoff = Date.now() - config.messageRetentionDays * 24 * 60 * 60 * 1000;

  for (const session of getAllSessions()) {
    if (session.type !== 'persistent') continue;
    try {
      const channel = client.channels.cache.get(session.channelId) as TextChannel | undefined;
      if (!channel) continue;

      const messages = await channel.messages.fetch({ limit: 100 });
      const old = messages.filter(m => m.createdTimestamp < cutoff);
      if (old.size > 0) {
        await channel.bulkDelete(old, true);
      }
    } catch { /* channel may not exist */ }
  }
}

export async function startBot(): Promise<void> {
  if (!acquireLock()) {
    process.exit(1);
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageTyping,
    ],
  });

  setLogger(botLog);

  // Slash command / button interactions
  client.on('interactionCreate', async interaction => {
    try {
      if (interaction.type === InteractionType.ApplicationCommand && interaction.isChatInputCommand()) {
        switch (interaction.commandName) {
          case 'project': return await handleProject(interaction);
          case 'agent': return await handleAgent(interaction);
          case 'subagent': return await handleSubagent(interaction);
          case 'shell': return await handleShell(interaction);
          // 快捷命令
          case 'spawn': return await handleSpawnShortcut(interaction);
          case 'stop': return await handleStopShortcut(interaction);
          case 'end': return await handleEndShortcut(interaction);
          case 'run': return await handleRunShortcut(interaction);
        }
      }

      if (interaction.isButton()) {
        return await handleButton(interaction);
      }

      if (interaction.isStringSelectMenu()) {
        return await handleSelectMenu(interaction);
      }
    } catch (err) {
      console.error('Interaction error:', err);
      try {
        if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'An error occurred.', ephemeral: true });
        }
      } catch { /* can't recover */ }
    }
  });

  // Messages in session channels (TextChannel) and subagent threads
  client.on('messageCreate', handleMessage);

  // Session channel deleted → end the persistent session
  client.on('channelDelete', channel => {
    const session = getSessionByChannel(channel.id);
    if (session && session.type === 'persistent') {
      endSession(session.id).catch(err =>
        console.error(`Failed to end session on channel delete: ${err.message}`),
      );
    }
  });

  // Subagent thread deleted → end the subagent session
  client.on('threadDelete', thread => {
    const session = getSessionByChannel(thread.id);
    if (session && session.type === 'subagent') {
      endSession(session.id).catch(err =>
        console.error(`Failed to end subagent session on thread delete: ${err.message}`),
      );
    }
  });

  // Bot ready
  client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    await registerCommands();
    await loadProjects();
    await loadSessions();
    await loadArchived();

    // Find or create #bot-logs channel at the server root (no category)
    const guild = client.guilds.cache.first();
    if (guild) {
      logChannel = guild.channels.cache.find(
        ch => ch.name === 'bot-logs' && ch.type === ChannelType.GuildText && !ch.parentId,
      ) as TextChannel | undefined ?? null;

      if (!logChannel) {
        try {
          logChannel = await guild.channels.create({
            name: 'bot-logs',
            type: ChannelType.GuildText,
            reason: 'Auto-created by threadcord for bot logs',
          });
        } catch {
          console.warn('Could not create #bot-logs channel');
        }
      }
    }

    botLog(`Bot online. ${getAllSessions().length} session(s) restored.`);
    updatePresence();
    startSync(client);

    // Presence update every 30s
    setInterval(updatePresence, 30_000);

    // Subagent watchdog every 5 minutes
    setInterval(() => {
      runSubagentWatchdog(threadId => {
        const ch = client.channels.cache.get(threadId);
        return ch?.isThread() ? ch : undefined;
      }).catch(err => console.error(`Subagent watchdog error: ${err.message}`));
    }, 5 * 60 * 1000);

    // Auto-archive check every hour
    if (config.autoArchiveDays || config.maxActiveSessionsPerProject) {
      const guild = client.guilds.cache.first();
      if (guild) {
        setInterval(() => {
          checkAutoArchive(guild).catch(err =>
            console.error(`Auto-archive check error: ${err.message}`),
          );
        }, 60 * 60 * 1000);
      }
    }

    // Message cleanup
    if (config.messageRetentionDays) {
      await cleanupOldMessages();
      setInterval(cleanupOldMessages, 60 * 60 * 1000);
    }
  });

  // Graceful shutdown
  const shutdown = () => {
    botLog('Shutting down...');
    flushLogs();
    stopSync();
    releaseLock();
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.login(config.token);
}

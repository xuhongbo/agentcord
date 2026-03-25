import {
  Client,
  GatewayIntentBits,
  ActivityType,
  InteractionType,
  ComponentType,
  ChannelType,
  type TextChannel,
} from 'discord.js';
import { config } from './config.ts';
import { registerCommands } from './commands.ts';
import {
  handleProject,
  handleAgent,
  handleSubagent,
  handleShell,
  setLogger,
} from './command-handlers.ts';
import { handleMessage } from './message-handler.ts';
import { handleButton, handleSelectMenu } from './button-handler.ts';
import { loadSessions, getAllSessions, endSession, getSessionByThread } from './thread-manager.ts';
import { loadProjects } from './project-manager.ts';
import { runSubagentWatchdog } from './subagent-manager.ts';

let client: Client;
let logChannel: TextChannel | null = null;
let logBuffer: string[] = [];
let logTimer: ReturnType<typeof setTimeout> | null = null;

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
    try {
      const thread = client.channels.cache.get(session.threadId);
      if (!thread?.isThread()) continue;

      const messages = await thread.messages.fetch({ limit: 100 });
      const old = messages.filter(m => m.createdTimestamp < cutoff);
      if (old.size > 0) {
        await thread.bulkDelete(old, true);
      }
    } catch { /* thread may not exist */ }
  }
}

export async function startBot(): Promise<void> {
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

  // Thread messages → route to agent sessions
  client.on('messageCreate', handleMessage);

  // Thread deleted → end the session
  client.on('threadDelete', thread => {
    const session = getSessionByThread(thread.id);
    if (session) {
      endSession(session.id).catch(err =>
        console.error(`Failed to end session on thread delete: ${err.message}`),
      );
    }
  });

  // Thread unarchived → session reactivation handled naturally (message arrives → session found)
  client.on('threadUpdate', (oldThread, newThread) => {
    if (oldThread.archived && !newThread.archived) {
      const session = getSessionByThread(newThread.id);
      if (session) {
        botLog(`Thread unarchived: <#${newThread.id}> (session ${session.id})`);
      }
    }
  });

  // Bot ready
  client.once('ready', async () => {
    console.log(`Logged in as ${client.user?.tag}`);

    await registerCommands();
    await loadProjects();
    await loadSessions();

    // Find or create #bot-logs channel
    const guild = client.guilds.cache.first();
    if (guild) {
      logChannel = guild.channels.cache.find(
        ch => ch.name === 'bot-logs' && ch.type === ChannelType.GuildText,
      ) as TextChannel | undefined ?? null;

      if (!logChannel) {
        try {
          logChannel = await guild.channels.create({
            name: 'bot-logs',
            type: ChannelType.GuildText,
          });
        } catch {
          console.warn('Could not create #bot-logs channel');
        }
      }
    }

    botLog(`Bot online. ${getAllSessions().length} session(s) restored.`);
    updatePresence();

    // Presence update every 30s
    setInterval(updatePresence, 30_000);

    // Subagent watchdog every 5 minutes
    setInterval(() => {
      runSubagentWatchdog(threadId => {
        const ch = client.channels.cache.get(threadId);
        return ch?.isThread() ? ch : undefined;
      }).catch(err => console.error(`Subagent watchdog error: ${err.message}`));
    }, 5 * 60 * 1000);

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
    client.destroy();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await client.login(config.token);
}

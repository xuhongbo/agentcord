import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type TextChannel,
  type CategoryChannel,
} from 'discord.js';
import { config } from '../src/config.ts';
import { handleAgent } from '../src/command-handlers.ts';
import { getProjectByName } from '../src/project-registry.ts';
import { loadRegistry } from '../src/project-registry.ts';
import { loadProjects } from '../src/project-manager.ts';
import { loadSessions, getSessionsByCategory } from '../src/thread-manager.ts';

function makeOptions(subcommand: string, values: Record<string, string | null | undefined>) {
  return {
    getSubcommand: () => subcommand,
    getString: (name: string, required = false) => {
      const value = values[name];
      if ((value === undefined || value === null) && required) {
        throw new Error(`Missing required option: ${name}`);
      }
      return value ?? null;
    },
  };
}

function makeInteraction(
  userId: string,
  guild: any,
  channel: any,
  subcommand: string,
  values: Record<string, string | null | undefined>,
) {
  let lastReply: unknown;
  return {
    user: { id: userId, tag: 'threadcord-e2e#0001' },
    guild,
    channel,
    channelId: channel.id,
    replied: false,
    deferred: false,
    options: makeOptions(subcommand, values),
    async reply(payload: unknown) {
      lastReply = payload;
      return payload;
    },
    async deferReply() {
      return;
    },
    async editReply(payload: unknown) {
      lastReply = payload;
      return payload;
    },
    async fetchReply() {
      return lastReply;
    },
  };
}

const outDir = join(process.cwd(), 'local-acceptance');
mkdirSync(outDir, { recursive: true });
const reportPath = join(outDir, 'multi-session-report.json');

await loadRegistry();
await loadProjects();
await loadSessions();

const project = getProjectByName('threadcord');
if (!project?.discordCategoryId) {
  throw new Error(
    'Mounted project "threadcord" is not bound to a Discord category. Run /project setup first.',
  );
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

await client.login(config.token);
const guild = await client.guilds.fetch(config.guildId);
await guild.channels.fetch();

const category = guild.channels.cache.get(project.discordCategoryId) as CategoryChannel | undefined;
if (!category || category.type !== ChannelType.GuildCategory) {
  throw new Error('Bound category not found in guild');
}

const controlChannel = await guild.channels.create({
  name: `multi-session-control-${Date.now().toString().slice(-4)}`,
  type: ChannelType.GuildText,
  parent: category.id,
  reason: 'threadcord multi-session smoke test',
});

const actorId = config.allowedUsers[0] || 'integration-e2e-user';
const createdLabels = [
  `multi-a-${Date.now().toString().slice(-4)}`,
  `multi-b-${(Date.now() + 1).toString().slice(-4)}`,
];

try {
  for (const label of createdLabels) {
    const interaction = makeInteraction(actorId, guild, controlChannel, 'spawn', {
      label,
      provider: 'claude',
      mode: 'auto',
    });
    await handleAgent(interaction as any);
  }

  const sessions = getSessionsByCategory(category.id).filter(
    (session) => session.type === 'persistent' && createdLabels.includes(session.agentLabel),
  );

  const report = {
    categoryId: category.id,
    categoryName: category.name,
    expectedArchitecture: '当前实现为 Category=Project, Channel=Session, Thread=Subagent',
    userRequestedArchitectureCheck:
      '你提出“一个项目应该是个频道”，但当前代码实现并不是 Channel=Project，而是 Category=Project',
    createdLabels,
    createdSessions: sessions.map((session) => ({
      id: session.id,
      channelId: session.channelId,
      label: session.agentLabel,
      categoryId: session.categoryId,
    })),
    passed:
      sessions.length === 2 && sessions.every((session) => session.categoryId === category.id),
  };

  writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await controlChannel.delete('threadcord multi-session smoke cleanup').catch(() => {});
  client.destroy();
  process.exit(0);
}

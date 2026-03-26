import { basename, resolve } from 'node:path';
import type { CategoryChannel, Guild } from 'discord.js';
import {
  loadRegistry,
  registerProject,
  getAllRegisteredProjects,
  getProjectByPath,
  renameProject,
  removeProject,
  updateProjectDiscord,
} from './project-registry.ts';
import { getConfigValue } from './global-config.ts';

type DiscordEnsureResult =
  | { ok: true; categoryId: string; logChannelId: string }
  | { ok: false; reason: string };

function parseNameArg(args: string[]): string | undefined {
  const idx = args.indexOf('--name');
  if (idx >= 0 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

function printHelp(): void {
  console.log(`
agentcord project — manage mounted projects

Usage:
  agentcord project init [--name <name>]
  agentcord project list
  agentcord project info
  agentcord project rename <new-name>
  agentcord project remove
`);
}

async function ensureLogChannel(guild: Guild, category: CategoryChannel): Promise<string> {
  const { ChannelType } = await import('discord.js');

  const existing = category.children.cache.find(
    ch => ch.type === ChannelType.GuildText && ch.name === 'project-logs',
  );
  if (existing && existing.type === ChannelType.GuildText) {
    return existing.id;
  }

  const logChannel = await guild.channels.create({
    name: 'project-logs',
    type: ChannelType.GuildText,
    parent: category.id,
  });
  return logChannel.id;
}

async function tryEnsureDiscordResources(projectName: string): Promise<DiscordEnsureResult> {
  const token = getConfigValue('DISCORD_TOKEN');
  const guildId = getConfigValue('DISCORD_GUILD_ID');
  if (!token) {
    return { ok: false, reason: 'DISCORD_TOKEN is not configured' };
  }
  if (!guildId) {
    return { ok: false, reason: 'DISCORD_GUILD_ID is not configured (cannot locate target guild)' };
  }

  try {
    const { Client, GatewayIntentBits, ChannelType } = await import('discord.js');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(token);

    try {
      const guild = await client.guilds.fetch(guildId);
      await guild.channels.fetch();

      let category = guild.channels.cache.find(
        ch => ch.type === ChannelType.GuildCategory && ch.name === projectName,
      );
      if (!category) {
        category = await guild.channels.create({
          name: projectName,
          type: ChannelType.GuildCategory,
        });
      }
      if (category.type !== ChannelType.GuildCategory) {
        return { ok: false, reason: `Found non-category channel named ${projectName}` };
      }

      const logChannelId = await ensureLogChannel(guild, category);
      return { ok: true, categoryId: category.id, logChannelId };
    } finally {
      client.destroy();
    }
  } catch (err: unknown) {
    return { ok: false, reason: (err as Error).message || 'Discord connection failed' };
  }
}

async function tryRenameDiscordCategory(oldName: string, newName: string): Promise<string | null> {
  const token = getConfigValue('DISCORD_TOKEN');
  const guildId = getConfigValue('DISCORD_GUILD_ID');
  if (!token || !guildId) return 'DISCORD_TOKEN or DISCORD_GUILD_ID not configured';

  try {
    const { Client, GatewayIntentBits, ChannelType } = await import('discord.js');
    const client = new Client({ intents: [GatewayIntentBits.Guilds] });
    await client.login(token);
    try {
      const guild = await client.guilds.fetch(guildId);
      await guild.channels.fetch();
      const category = guild.channels.cache.find(
        ch => ch.type === ChannelType.GuildCategory && ch.name === oldName,
      );
      if (!category) return `No Discord category named ${oldName} found`;
      await category.setName(newName);
      return null;
    } finally {
      client.destroy();
    }
  } catch (err: unknown) {
    return (err as Error).message || 'Discord rename failed';
  }
}

export async function handleProject(args: string[]): Promise<void> {
  await loadRegistry();
  const [subcommand, ...rest] = args;

  switch (subcommand) {
    case 'init': {
      const cwd = resolve(process.cwd());
      const name = parseNameArg(rest) || basename(cwd);
      const project = await registerProject(name, cwd);
      const discord = await tryEnsureDiscordResources(project.name);
      if (discord.ok) {
        await updateProjectDiscord(project.name, discord.categoryId, discord.logChannelId);
      }
      console.log(`✓ Project registered: ${project.name}`);
      console.log(`  Path: ${project.path}`);
      if (!discord.ok) {
        console.log('  Project registered locally. Discord category will be created when the bot starts.');
        console.log(`  Discord sync skipped: ${discord.reason}`);
      }
      return;
    }

    case 'list': {
      const projects = getAllRegisteredProjects();
      if (projects.length === 0) {
        console.log('No projects registered. Run `agentcord project init` in a repository.');
        return;
      }
      for (const p of projects) {
        console.log(`${p.name}  ${p.path}  [${p.discordCategoryId ? 'discord:ready' : 'discord:pending'}]`);
      }
      return;
    }

    case 'info': {
      const cwd = resolve(process.cwd());
      const project = getProjectByPath(cwd);
      if (!project) {
        console.log('Current directory is not registered as an agentcord project.');
        process.exit(1);
      }
      console.log(`name: ${project.name}`);
      console.log(`path: ${project.path}`);
      console.log(`discordCategoryId: ${project.discordCategoryId ?? '(pending)'}`);
      console.log(`logChannelId: ${project.discordLogChannelId ?? '(pending)'}`);
      return;
    }

    case 'rename': {
      const newName = rest[0];
      if (!newName) {
        console.error('Usage: agentcord project rename <new-name>');
        process.exit(1);
      }
      const cwd = resolve(process.cwd());
      const project = getProjectByPath(cwd);
      if (!project) {
        console.error('Current directory is not registered.');
        process.exit(1);
      }
      const oldName = project.name;
      await renameProject(oldName, newName);
      const discordRenameErr = await tryRenameDiscordCategory(oldName, newName);
      console.log(`✓ Project renamed: ${oldName} -> ${newName}`);
      if (discordRenameErr) {
        console.log(`  Discord rename skipped: ${discordRenameErr}`);
      }
      return;
    }

    case 'remove': {
      const cwd = resolve(process.cwd());
      const project = getProjectByPath(cwd);
      if (!project) {
        console.error('Current directory is not registered.');
        process.exit(1);
      }
      await removeProject(project.name);
      console.log(`✓ Project removed: ${project.name}`);
      return;
    }

    case undefined:
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;

    default:
      console.error(`Unknown project subcommand: ${subcommand}`);
      printHelp();
      process.exit(1);
  }
}

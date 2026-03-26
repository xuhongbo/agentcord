import { basename, resolve } from 'node:path';
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

async function tryEnsureDiscordResources(projectName: string): Promise<{ categoryId?: string; logChannelId?: string }> {
  const token = getConfigValue('DISCORD_TOKEN');
  const guildId = getConfigValue('DISCORD_GUILD_ID');
  if (!token || !guildId) return {};

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

      let logChannel = (category as any).children?.cache?.find(
        (ch: any) => ch.type === ChannelType.GuildText && ch.name === 'project-logs',
      );
      if (!logChannel) {
        logChannel = await guild.channels.create({
          name: 'project-logs',
          type: ChannelType.GuildText,
          parent: category.id,
        });
      }

      return { categoryId: category.id, logChannelId: logChannel.id };
    } finally {
      client.destroy();
    }
  } catch {
    return {};
  }
}

async function tryRenameDiscordCategory(oldName: string, newName: string): Promise<void> {
  const token = getConfigValue('DISCORD_TOKEN');
  const guildId = getConfigValue('DISCORD_GUILD_ID');
  if (!token || !guildId) return;

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
      if (category) {
        await category.setName(newName);
      }
    } finally {
      client.destroy();
    }
  } catch {
    // ignore
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
      if (discord.categoryId) {
        await updateProjectDiscord(project.name, discord.categoryId, discord.logChannelId);
      }
      console.log(`✓ Project registered: ${project.name}`);
      console.log(`  Path: ${project.path}`);
      if (!discord.categoryId) {
        console.log('  Project registered locally. Discord category will be created when the bot starts.');
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
      await tryRenameDiscordCategory(oldName, newName);
      console.log(`✓ Project renamed: ${oldName} -> ${newName}`);
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

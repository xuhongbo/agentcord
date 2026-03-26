import { createHash } from 'node:crypto';
import type { Client, Guild, TextChannel, CategoryChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import { listCodexSessionsForProjects } from './codex-session-discovery.ts';
import {
  getAllRegisteredProjects,
  updateProjectDiscord,
  type RegisteredProject,
} from './project-registry.ts';
import * as sessions from './session-manager.ts';

const SYNC_INTERVAL_MS = 30_000;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncInProgress = false;

function makeSyncedSessionId(provider: 'claude' | 'codex', providerSessionId: string): string {
  const digest = createHash('sha1').update(`${provider}:${providerSessionId}`).digest('hex').slice(0, 16);
  return `${provider}-${digest}`;
}

async function runSyncSafely(client: Client): Promise<void> {
  if (syncInProgress) return;
  syncInProgress = true;
  try {
    await runSync(client);
  } finally {
    syncInProgress = false;
  }
}

export function startSync(client: Client): void {
  void runSyncSafely(client);
  syncTimer = setInterval(() => void runSyncSafely(client), SYNC_INTERVAL_MS);
}

export function stopSync(): void {
  if (syncTimer) {
    clearInterval(syncTimer);
    syncTimer = null;
  }
}

async function ensureProjectCategory(guild: Guild, project: RegisteredProject): Promise<CategoryChannel> {
  let category: CategoryChannel | undefined;
  if (project.discordCategoryId) {
    category = guild.channels.cache.get(project.discordCategoryId) as CategoryChannel | undefined;
  }
  if (!category) {
    category = guild.channels.cache.find(
      ch => ch.type === ChannelType.GuildCategory && ch.name === project.name,
    ) as CategoryChannel | undefined;
  }
  if (!category) {
    category = await guild.channels.create({
      name: project.name,
      type: ChannelType.GuildCategory,
    });
  }
  await updateProjectDiscord(project.name, category.id, project.discordLogChannelId);
  return category;
}

async function findOrCreateSyncChannel(
  guild: Guild,
  category: CategoryChannel,
  provider: 'claude' | 'codex',
  providerSessionId: string,
  fallbackName: string,
  projectPath: string,
): Promise<TextChannel> {
  const existing = category.children.cache.find(
    ch =>
      ch.type === ChannelType.GuildText &&
      typeof ch.topic === 'string' &&
      ch.topic.includes(`Provider Session: ${providerSessionId}`),
  ) as TextChannel | undefined;
  if (existing) return existing;

  return await guild.channels.create({
    name: fallbackName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `${provider} session (synced) | Dir: ${projectPath} | Provider Session: ${providerSessionId}`,
  }) as TextChannel;
}

async function syncSession(
  guild: Guild,
  project: RegisteredProject,
  provider: 'claude' | 'codex',
  providerSessionId: string,
  nameHint: string,
): Promise<void> {
  const category = await ensureProjectCategory(guild, project);
  const base = nameHint.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || providerSessionId.slice(0, 12);
  const channelName = `${provider}-${base}`.slice(0, 90);

  const channel = await findOrCreateSyncChannel(
    guild,
    category,
    provider,
    providerSessionId,
    channelName,
    project.path,
  );

  await sessions.createSyncedSession(
    makeSyncedSessionId(provider, providerSessionId),
    channel.id,
    project.path,
    project.name,
    provider,
    providerSessionId,
  );
}

async function runSync(client: Client): Promise<void> {
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const projects = getAllRegisteredProjects();
  if (projects.length === 0) return;

  const existingProviderIds = new Set(
    sessions.getAllSessions().map(s => s.providerSessionId).filter(Boolean),
  );

  try {
    const claudeSdk = await import('@anthropic-ai/claude-agent-sdk');
    for (const project of projects) {
      try {
        const claudeSessions = await claudeSdk.listSessions({ dir: project.path, limit: 50 });
        for (const cs of claudeSessions) {
          if (!cs?.sessionId || existingProviderIds.has(cs.sessionId)) continue;
          await syncSession(guild, project, 'claude', cs.sessionId, cs.summary || cs.firstPrompt || cs.sessionId);
          existingProviderIds.add(cs.sessionId);
        }
      } catch {
        // skip this project
      }
    }
  } catch {
    // SDK unavailable
  }

  const codexSessions = listCodexSessionsForProjects(projects.map(p => p.path));
  for (const session of codexSessions) {
    if (existingProviderIds.has(session.id)) continue;
    const project = projects.find(p => p.path === session.projectPath);
    if (!project) continue;
    try {
      await syncSession(guild, project, 'codex', session.id, session.threadName);
      existingProviderIds.add(session.id);
    } catch {
      // skip one session
    }
  }
}

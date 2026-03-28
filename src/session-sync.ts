import type { Client, Guild, TextChannel, CategoryChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import { listCodexSessionsForProjects } from './codex-session-discovery.ts';
import { getAllRegisteredProjects } from './project-registry.ts';
import * as sessions from './thread-manager.ts';
import { config } from './config.ts';

const SYNC_INTERVAL_MS = config.sessionSyncIntervalMs;
let syncTimer: ReturnType<typeof setInterval> | null = null;
let syncInProgress = false;

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

async function findOrCreateSessionChannel(
  guild: Guild,
  category: CategoryChannel,
  provider: 'claude' | 'codex',
  providerSessionId: string,
  fallbackName: string,
): Promise<TextChannel> {
  const existing = category.children.cache.find(
    (channel) =>
      channel.type === ChannelType.GuildText &&
      typeof channel.topic === 'string' &&
      channel.topic.includes(`Provider Session: ${providerSessionId}`),
  ) as TextChannel | undefined;
  if (existing) return existing;

  return guild.channels.create({
    name: fallbackName,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `${provider} session (synced) | Provider Session: ${providerSessionId}`,
  }) as Promise<TextChannel>;
}

async function syncPersistentSession(
  guild: Guild,
  category: CategoryChannel,
  projectName: string,
  directory: string,
  provider: 'claude' | 'codex',
  providerSessionId: string,
  labelHint: string,
): Promise<void> {
  const base =
    labelHint
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || providerSessionId.slice(0, 12);

  const channel = await findOrCreateSessionChannel(
    guild,
    category,
    provider,
    providerSessionId,
    `${provider}-${base}`.slice(0, 100),
  );

  await sessions.createSession({
    channelId: channel.id,
    categoryId: category.id,
    projectName,
    agentLabel: labelHint,
    provider,
    providerSessionId,
    directory,
    type: 'persistent',
  });
}

async function runSync(client: Client): Promise<void> {
  const guild = client.guilds.cache.first();
  if (!guild) {
    console.log('[sync] No guild found, skipping sync.');
    return;
  }

  const projects = getAllRegisteredProjects().filter((project) => project.discordCategoryId);
  if (projects.length === 0) {
    console.log('[sync] No mounted projects with Discord categories, skipping sync.');
    return;
  }

  console.log(`[sync] Starting sync for ${projects.length} project(s)...`);

  const existingProviderIds = new Set(
    sessions
      .getAllSessions()
      .map((session) => session.providerSessionId)
      .filter(Boolean),
  );

  try {
    const claudeSdk = await import('@anthropic-ai/claude-agent-sdk');
    let claudeSynced = 0;
    for (const project of projects) {
      const category = guild.channels.cache.get(project.discordCategoryId!) as
        | CategoryChannel
        | undefined;
      if (!category || category.type !== ChannelType.GuildCategory) {
        console.log(`[sync] Project "${project.name}": category ${project.discordCategoryId} not found in guild cache, skipping.`);
        continue;
      }

      try {
        const claudeSessions = await claudeSdk.listSessions({ dir: project.path, limit: 50 });
        for (const item of claudeSessions) {
          if (!item?.sessionId || existingProviderIds.has(item.sessionId)) continue;
          await syncPersistentSession(
            guild,
            category,
            project.name,
            project.path,
            'claude',
            item.sessionId,
            item.summary || item.firstPrompt || item.sessionId,
          );
          existingProviderIds.add(item.sessionId);
          claudeSynced++;
        }
      } catch (err) {
        console.warn(`[sync] Failed to sync Claude sessions for project "${project.name}":`, err);
      }
    }
    console.log(`[sync] Claude: synced ${claudeSynced} new session(s).`);
  } catch (err) {
    console.log('[sync] Claude SDK unavailable, skipping Claude session sync.', err);
  }

  const codexSessions = listCodexSessionsForProjects(projects.map((project) => project.path));
  console.log(`[sync] Codex: found ${codexSessions.length} local session(s).`);
  let codexSynced = 0;
  for (const session of codexSessions) {
    if (existingProviderIds.has(session.id)) continue;
    const project = projects.find((item) => item.path === session.projectPath);
    if (!project?.discordCategoryId) continue;

    const category = guild.channels.cache.get(project.discordCategoryId) as
      | CategoryChannel
      | undefined;
    if (!category || category.type !== ChannelType.GuildCategory) continue;

    try {
      await syncPersistentSession(
        guild,
        category,
        project.name,
        session.cwd,
        'codex',
        session.id,
        session.threadName,
      );
      existingProviderIds.add(session.id);
      codexSynced++;
    } catch (err) {
      console.warn(`[sync] Failed to sync Codex session ${session.id}:`, err);
    }
  }
  console.log(`[sync] Codex: synced ${codexSynced} new session(s).`);
  console.log(`[sync] Sync complete.`);
}

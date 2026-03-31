import type { Guild } from 'discord.js';
import { endSession, getAllSessions, getSession } from './thread-manager.ts';

export interface SessionCleanupResult {
  deletedChannels: number;
  missingChannels: number;
  endedSessions: number;
  skippedSessions: number;
  failed: Array<{
    sessionId: string;
    channelId?: string;
    message: string;
  }>;
}

async function resolveChannel(guild: Guild, channelId: string) {
  return guild.channels.cache.get(channelId) ?? (await guild.channels.fetch(channelId).catch(() => null));
}

export async function cleanupSessionsById(
  guild: Guild,
  sessionIds: Iterable<string>,
  deleteReason = 'threadcord session cleanup',
): Promise<SessionCleanupResult> {
  const result: SessionCleanupResult = {
    deletedChannels: 0,
    missingChannels: 0,
    endedSessions: 0,
    skippedSessions: 0,
    failed: [],
  };

  for (const sessionId of new Set(Array.from(sessionIds).filter(Boolean))) {
    const session = getSession(sessionId);
    if (!session) {
      result.skippedSessions += 1;
      continue;
    }

    try {
      const channel = await resolveChannel(guild, session.channelId);
      if (channel) {
        await channel.delete(deleteReason);
        result.deletedChannels += 1;
      } else {
        result.missingChannels += 1;
      }

      await endSession(session.id);
      result.endedSessions += 1;
    } catch (error) {
      result.failed.push({
        sessionId: session.id,
        channelId: session.channelId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}

export async function reconcileSessionRecordsWithGuild(
  guild: Guild,
): Promise<{ checkedSessions: number; endedMissingSessions: number }> {
  const sessions = getAllSessions();
  let endedMissingSessions = 0;

  for (const session of sessions) {
    const channel = await resolveChannel(guild, session.channelId);
    if (channel) continue;

    await endSession(session.id);
    endedMissingSessions += 1;
  }

  return {
    checkedSessions: sessions.length,
    endedMissingSessions,
  };
}

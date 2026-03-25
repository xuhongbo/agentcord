import {
  ChannelType,
  ThreadAutoArchiveDuration,
  type TextChannel,
  type AnyThreadChannel,
} from 'discord.js';
import { config } from './config.ts';
import { createSession, endSession, getSessionsByChannel, getAllSessions } from './thread-manager.ts';
import type { ThreadSession, ProviderName } from './types.ts';

// Watchdog: archive idle subagents every 5 minutes
const SUBAGENT_IDLE_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

export function canSpawnSubagent(parentSession: ThreadSession): boolean {
  return parentSession.subagentDepth < config.maxSubagentDepth;
}

/**
 * Spawn an ephemeral subagent thread in the same project channel as the parent session.
 * Creates a Discord thread named "[sub:{provider}] {label}".
 */
export async function spawnSubagent(
  parentSession: ThreadSession,
  label: string,
  provider: ProviderName,
  projectChannel: TextChannel,
): Promise<ThreadSession> {
  if (!canSpawnSubagent(parentSession)) {
    throw new Error(
      `Max subagent depth (${config.maxSubagentDepth}) reached. Cannot spawn further subagents.`,
    );
  }

  const threadName = `[sub:${provider}] ${label}`.slice(0, 100);

  const thread = await projectChannel.threads.create({
    name: threadName,
    type: ChannelType.PublicThread,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneHour,
    reason: `Subagent spawned by session ${parentSession.id}`,
  });

  const session = await createSession({
    threadId: thread.id,
    channelId: parentSession.channelId,
    projectName: parentSession.projectName,
    agentLabel: label,
    provider,
    directory: parentSession.directory,
    type: 'subagent',
    parentThreadId: parentSession.threadId,
    subagentDepth: parentSession.subagentDepth + 1,
    mode: parentSession.mode,
  });

  return session;
}

/**
 * Archive a completed subagent thread and optionally notify the parent thread.
 */
export async function archiveSubagent(
  session: ThreadSession,
  thread: AnyThreadChannel,
  summary?: string,
): Promise<void> {
  // Post completion summary in the subagent thread before archiving
  if (summary) {
    try {
      await thread.send(`*Subagent complete: ${summary}*`);
    } catch { /* thread may already be archived */ }
  }

  // Archive the thread
  try {
    await thread.setArchived(true, 'Subagent task completed');
  } catch { /* best effort */ }

  // End the session record
  try {
    await endSession(session.id);
  } catch { /* already ended */ }
}

/**
 * Get all active subagents for a parent session.
 */
export function getSubagents(parentSession: ThreadSession): ThreadSession[] {
  return getSessionsByChannel(parentSession.channelId).filter(
    s => s.type === 'subagent' && s.parentThreadId === parentSession.threadId,
  );
}

/**
 * Watchdog: archive subagent threads that have been idle too long.
 * Call this periodically (e.g. every 5 minutes).
 */
export async function runSubagentWatchdog(
  getThread: (threadId: string) => AnyThreadChannel | undefined,
): Promise<void> {
  const now = Date.now();

  // Find all channels with subagent sessions
  const checked = new Set<string>();

  for (const session of getSubagentSessions()) {
    if (checked.has(session.id)) continue;
    checked.add(session.id);

    const idle = now - session.lastActivity;
    if (idle < SUBAGENT_IDLE_TIMEOUT_MS) continue;
    if (session.isGenerating) continue;

    const thread = getThread(session.threadId);
    if (!thread) {
      // Thread is gone, just clean up the session
      await endSession(session.id).catch(() => {});
      continue;
    }

    await archiveSubagent(session, thread, 'Idle timeout reached.');
  }
}

function getSubagentSessions(): ThreadSession[] {
  return getAllSessions().filter(s => s.type === 'subagent');
}

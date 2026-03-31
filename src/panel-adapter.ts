// 实时作战面板集成适配器
// 将新组件集成到现有 output-handler / session-executor / shell-handler

import type { TextChannel, AnyThreadChannel } from 'discord.js';
import { StatusCard } from './discord/status-card.ts';
import { SummaryHandler } from './discord/summary-handler.ts';
import { InteractionCard } from './discord/interaction-card.ts';
import { StateMachine } from './state/state-machine.ts';
import { toPlatformEvent, mapPlatformEventToState } from './state/event-normalizer.ts';
import type { ProviderEvent } from './providers/types.ts';
import * as sessions from './thread-manager.ts';
import type {
  PlatformEvent,
  SessionStateSnapshot,
  DigestItem,
  UnifiedState,
} from './state/types.ts';

type SessionChannel = TextChannel | AnyThreadChannel;

// 全局状态机实例
const stateMachine = new StateMachine();

// 会话到组件的映射
const sessionComponents = new Map<string, {
  channel: SessionChannel;
  statusCard: StatusCard;
  summaryHandler: SummaryHandler;
  interactionCard: InteractionCard;
}>();

// 会话摘要队列（低频聚合）
const sessionDigests = new Map<string, DigestItem[]>();
const MAX_DIGEST_QUEUE_SIZE = 20;

function getSessionComponents(sessionId: string): {
  channel: SessionChannel;
  statusCard: StatusCard;
  summaryHandler: SummaryHandler;
  interactionCard: InteractionCard;
} | undefined {
  return sessionComponents.get(sessionId);
}

function ensureSession(sessionId: string): SessionStateSnapshot {
  return stateMachine.ensureSession(sessionId);
}

function resolveProviderSource(
  sessionId: string,
  fallback: 'claude' | 'codex' = 'claude',
): 'claude' | 'codex' {
  const session = sessions.getSession(sessionId);
  return session?.provider === 'codex' ? 'codex' : fallback;
}

export async function initializeSessionPanel(
  sessionId: string,
  channel: SessionChannel,
  options: {
    statusCardMessageId?: string;
    initialTurn?: number;
    phase?: string;
  } = {},
): Promise<void> {
  const existing = getSessionComponents(sessionId);
  if (existing) return;

  const statusCard = new StatusCard(channel);
  if (options.statusCardMessageId) {
    statusCard.adopt(options.statusCardMessageId);
  }
  await statusCard.initialize({
    turn: options.initialTurn ?? 1,
    phase: options.phase,
    updatedAt: Date.now(),
  });

  const summaryHandler = new SummaryHandler(channel, statusCard);
  const interactionCard = new InteractionCard(channel);

  sessionComponents.set(sessionId, {
    channel,
    statusCard,
    summaryHandler,
    interactionCard,
  });

  sessions.setStatusCardBinding(sessionId, {
    messageId: statusCard.getMessageId() ?? options.statusCardMessageId,
  });

  const snapshot = ensureSession(sessionId);
  if (snapshot.turn <= 0) {
    stateMachine.updateSession(sessionId, { turn: options.initialTurn ?? 1 });
  }
}

export async function registerExistingStatusCard(
  sessionId: string,
  channel: SessionChannel,
  statusCardMessageId: string,
): Promise<void> {
  await initializeSessionPanel(sessionId, channel, {
    statusCardMessageId,
  });
}

export async function updateSessionState(
  sessionId: string,
  event: ProviderEvent | PlatformEvent,
  options: {
    sourceHint?: 'claude' | 'codex';
    channel?: SessionChannel;
  } = {},
): Promise<SessionStateSnapshot | null> {
  if (!getSessionComponents(sessionId) && options.channel) {
    const session = sessions.getSession(sessionId);
    await initializeSessionPanel(sessionId, options.channel, {
      statusCardMessageId: session?.statusCardMessageId,
      initialTurn: session?.currentTurn || 1,
    });
  }

  const platformEvent = toPlatformEvent(
    event,
    sessionId,
    options.sourceHint ?? resolveProviderSource(sessionId),
  );
  if (!platformEvent) return null;

  const snapshot = stateMachine.applyPlatformEvent(platformEvent);
  const components = getSessionComponents(sessionId);
  if (components) {
    await components.statusCard.update(snapshot.state, {
      turn: snapshot.turn,
      updatedAt: snapshot.updatedAt,
        phase: snapshot.phase,
    });
  }

  sessions.updateSession(sessionId, {
    currentTurn: snapshot.turn,
    humanResolved: snapshot.humanResolved,
  });

  return snapshot;
}

export async function handleResultEvent(
  sessionId: string,
  event: Extract<ProviderEvent, { type: 'result' }>,
  textContent: string,
): Promise<void> {
  const components = getSessionComponents(sessionId);
  if (!components) return;

  const snapshot = ensureSession(sessionId);
  if (snapshot.turn <= 0) {
    stateMachine.updateSession(sessionId, { turn: 1 });
  }

  const isSessionEnd = event.metadata?.sessionEnd === true;
  const source = resolveProviderSource(sessionId);
  await components.interactionCard.hide();
  sessions.setCurrentInteractionMessage(sessionId, undefined);

  if (isSessionEnd) {
    await components.summaryHandler.sendEndingSummary(textContent);
    await updateSessionState(sessionId, {
      type: 'session_ended',
      sessionId,
      source,
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { from: 'result' },
    });
  } else if (!event.success) {
    const failureText =
      textContent.trim() || event.errors.join('\n').trim() || '任务失败';
    await components.summaryHandler.sendTurnFailure(failureText, snapshot.turn);
    await updateSessionState(sessionId, {
      type: 'errored',
      sessionId,
      source,
      confidence: 'high',
      timestamp: Date.now(),
      metadata: { from: 'result', errors: event.errors },
    });
  } else {
    const before = ensureSession(sessionId);
    await components.summaryHandler.sendTurnSummary(textContent, before.turn);
    const after = stateMachine.incrementTurn(sessionId);
    sessions.updateSession(sessionId, {
      currentTurn: after.turn,
      humanResolved: false,
    });
    await components.statusCard.update('idle', {
      turn: after.turn,
      updatedAt: Date.now(),
      phase: stateMachine.getStateLabel('idle'),
    });
    stateMachine.updateSession(sessionId, {
      state: 'idle',
      phase: stateMachine.getStateLabel('idle'),
      isCompleted: false,
      isWaitingHuman: false,
    });
  }
}

export async function handleAwaitingHuman(
  sessionId: string,
  detail: string,
  options: {
    source?: 'claude' | 'codex';
  } = {},
): Promise<string | null> {
  const components = getSessionComponents(sessionId);
  if (!components) return null;

  let snapshot = ensureSession(sessionId);
  if (snapshot.turn <= 0) {
    snapshot = stateMachine.incrementTurn(sessionId);
  }

  await updateSessionState(sessionId, {
    type: 'awaiting_human',
    sessionId,
    source: options.source ?? resolveProviderSource(sessionId),
    confidence: 'high',
    timestamp: Date.now(),
    metadata: { detail },
  });

  const messageId = await components.interactionCard.show(sessionId, snapshot.turn, detail);
  sessions.updateSession(sessionId, {
    currentTurn: snapshot.turn,
    humanResolved: false,
    currentInteractionMessageId: messageId,
  });
  sessions.setCurrentInteractionMessage(sessionId, messageId);
  return messageId;
}

export function queueDigest(sessionId: string, item: DigestItem): void {
  const text = item.text.trim();
  if (!text) return;

  if (!sessionDigests.has(sessionId)) {
    sessionDigests.set(sessionId, []);
  }
  const queue = sessionDigests.get(sessionId)!;
  const last = queue[queue.length - 1];
  if (last && last.kind === item.kind && last.text === text) {
    return;
  }

  queue.push({ kind: item.kind, text });
  if (queue.length > MAX_DIGEST_QUEUE_SIZE) {
    queue.splice(0, queue.length - MAX_DIGEST_QUEUE_SIZE);
  }
}

export function getDigestQueue(sessionId: string): DigestItem[] {
  return [...(sessionDigests.get(sessionId) ?? [])];
}

export function clearDigestQueue(sessionId: string): void {
  sessionDigests.delete(sessionId);
}

function renderDigest(items: DigestItem[]): string {
  const grouped = new Map<string, string[]>();
  for (const item of items) {
    if (!grouped.has(item.kind)) grouped.set(item.kind, []);
    grouped.get(item.kind)!.push(item.text);
  }

  const lines: string[] = ['**最近进展**'];
  for (const [kind, texts] of grouped) {
    const latest = texts.slice(-2).join('；');
    lines.push(`- ${kind}：${latest}`);
    if (texts.length > 2) {
      lines.push(`- ${kind}：另有 ${texts.length - 2} 条已折叠`);
    }
  }

  return lines.join('\n');
}

export async function flushDigest(sessionId: string): Promise<void> {
  const components = getSessionComponents(sessionId);
  if (!components) return;

  const queue = getDigestQueue(sessionId);
  if (queue.length === 0) return;

  await components.summaryHandler.sendDigestSummary(renderDigest(queue));
  clearDigestQueue(sessionId);
}

export function mapPlatformEventTypeToUnifiedState(type: PlatformEvent['type']): UnifiedState | null {
  return mapPlatformEventToState(type);
}

export function getStateMachine(): StateMachine {
  return stateMachine;
}

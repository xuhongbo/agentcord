import { EmbedBuilder, type Message, type TextChannel, type AnyThreadChannel } from 'discord.js';
import type { ThreadSession } from './types.ts';
import { splitMessage } from './utils.ts';

type SessionChannel = TextChannel | AnyThreadChannel;

type PresentationStateName =
  | 'idle'
  | 'running'
  | 'awaiting_human'
  | 'completed'
  | 'blocked'
  | 'error';

type DigestKind =
  | 'command'
  | 'file'
  | 'subagent'
  | 'tool'
  | 'search'
  | 'reasoning'
  | 'todo'
  | 'monitor'
  | 'error'
  | 'info';

type DigestItem = {
  kind: DigestKind;
  text: string;
};

interface PresentationState {
  statusMessage?: Message;
  digestMessage?: Message;
  state: PresentationStateName;
  phase: string;
  summary: string;
  updatedAt: number;
  commandCount: number;
  fileChangeCount: number;
  subagentCount: number;
  iteration?: number;
  digestQueue: DigestItem[];
  lastDigestSentAt: number;
  finalSent: boolean;
}

const DIGEST_MIN_INTERVAL_MS = 15_000;

const states = new Map<string, PresentationState>();

function getOrCreateState(sessionId: string): PresentationState {
  const existing = states.get(sessionId);
  if (existing) return existing;

  const created: PresentationState = {
    state: 'idle',
    phase: '待命',
    summary: '等待开始',
    updatedAt: Date.now(),
    commandCount: 0,
    fileChangeCount: 0,
    subagentCount: 0,
    digestQueue: [],
    lastDigestSentAt: 0,
    finalSent: false,
  };
  states.set(sessionId, created);
  return created;
}

function formatTime(ts: number): string {
  const date = new Date(ts);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function renderStateLabel(state: PresentationStateName): string {
  switch (state) {
    case 'running':
      return '🔄 运行中';
    case 'awaiting_human':
      return '🟡 等待人工';
    case 'completed':
      return '✅ 已完成';
    case 'blocked':
      return '⛔ 已阻塞';
    case 'error':
      return '❌ 异常';
    default:
      return '💤 待命';
  }
}

function renderStateColor(state: PresentationStateName): number {
  switch (state) {
    case 'running':
      return 0xf39c12;
    case 'awaiting_human':
      return 0xf1c40f;
    case 'completed':
      return 0x2ecc71;
    case 'blocked':
      return 0xe67e22;
    case 'error':
      return 0xe74c3c;
    default:
      return 0x95a5a6;
  }
}

export function buildSessionStatusEmbed(
  session: Pick<
    ThreadSession,
    'agentLabel' | 'provider' | 'mode' | 'workflowState'
  >,
  presentation?: Partial<PresentationState>,
): EmbedBuilder {
  const state = presentation?.state ?? 'idle';
  const phase = presentation?.phase ?? '待命';
  const summary = presentation?.summary ?? '等待开始';
  const updatedAt = presentation?.updatedAt ?? Date.now();
  const commandCount = presentation?.commandCount ?? 0;
  const fileChangeCount = presentation?.fileChangeCount ?? 0;
  const subagentCount = presentation?.subagentCount ?? 0;
  const iteration =
    presentation?.iteration ?? session.workflowState?.iteration ?? 0;

  return new EmbedBuilder()
    .setColor(renderStateColor(state))
    .setTitle(`${renderStateLabel(state)}｜${session.agentLabel}`)
    .setDescription(summary)
    .addFields(
      { name: 'Provider', value: session.provider, inline: true },
      { name: 'Mode', value: session.mode, inline: true },
      { name: 'Phase', value: phase, inline: true },
      { name: 'Iteration', value: `${iteration}`, inline: true },
      { name: 'Commands', value: `${commandCount}`, inline: true },
      { name: 'File Changes', value: `${fileChangeCount}`, inline: true },
      { name: 'Subagents', value: `${subagentCount}`, inline: true },
      { name: 'Updated', value: formatTime(updatedAt), inline: true },
    );
}

export async function registerSessionStatusMessage(
  session: Pick<
    ThreadSession,
    'id' | 'agentLabel' | 'provider' | 'mode' | 'workflowState'
  >,
  _channel: SessionChannel,
  message: Message,
): Promise<void> {
  const state = getOrCreateState(session.id);
  state.statusMessage = message;
  state.state = 'idle';
  state.phase = '待命';
  state.summary = '等待首条消息';
  state.updatedAt = Date.now();
  try {
    await message.pin();
  } catch {
    /* best effort */
  }
}

export async function updateSessionStatus(
  session: Pick<
    ThreadSession,
    'id' | 'agentLabel' | 'provider' | 'mode' | 'workflowState'
  >,
  channel: SessionChannel,
  patch: Partial<PresentationState>,
): Promise<void> {
  const state = getOrCreateState(session.id);
  Object.assign(state, patch, { updatedAt: patch.updatedAt ?? Date.now() });

  const embed = buildSessionStatusEmbed(session, state);

  if (state.statusMessage) {
    await state.statusMessage.edit({
      embeds: [embed],
      components: state.statusMessage.components ?? [],
    });
    return;
  }

  state.statusMessage = await channel.send({ embeds: [embed] });
  try {
    await state.statusMessage.pin();
  } catch {
    /* best effort */
  }
}

export function queueSessionDigest(sessionId: string, line: string | DigestItem): void {
  const state = getOrCreateState(sessionId);
  const item = normalizeDigestItem(line);
  const trimmed = item.text.trim();
  if (!trimmed) return;
  const last = state.digestQueue[state.digestQueue.length - 1];
  if (last && last.kind === item.kind && last.text === trimmed) return;
  state.digestQueue.push({ kind: item.kind, text: trimmed });
  if (state.digestQueue.length > 20) {
    state.digestQueue = state.digestQueue.slice(-20);
  }
}

function normalizeDigestItem(
  input: string | DigestItem,
): DigestItem {
  if (typeof input !== 'string') return input;
  return { kind: classifyDigestKind(input), text: input };
}

function classifyDigestKind(line: string): DigestKind {
  if (line.startsWith('命令：')) return 'command';
  if (line.startsWith('文件变更：')) return 'file';
  if (line.startsWith('子代理')) return 'subagent';
  if (line.startsWith('工具：') || line.startsWith('工具结果：') || line.startsWith('任务工具：'))
    return 'tool';
  if (line.startsWith('检索：')) return 'search';
  if (line.startsWith('推理：')) return 'reasoning';
  if (line.startsWith('待办更新：')) return 'todo';
  if (line.startsWith('错误：') || line.startsWith('异常：')) return 'error';
  if (line.startsWith('第 ') || line.startsWith('自动处理了一个提问分支')) return 'monitor';
  return 'info';
}

function renderDigestDescription(items: DigestItem[]): string {
  const groups = new Map<DigestKind, string[]>();
  for (const item of items) {
    if (!groups.has(item.kind)) groups.set(item.kind, []);
    groups.get(item.kind)!.push(item.text);
  }

  const lines: string[] = ['**最近进展**'];

  const addGroup = (label: string, kind: DigestKind, limit = 2) => {
    const values = groups.get(kind) ?? [];
    if (values.length === 0) return;
    const shown = values.slice(-limit);
    lines.push(`- ${label}：${shown.join('；')}`);
    if (values.length > limit) {
      lines.push(`- ${label}：另有 ${values.length - limit} 条已折叠`);
    }
  };

  addGroup('命令', 'command');
  addGroup('文件', 'file');
  addGroup('子代理', 'subagent');
  addGroup('工具', 'tool', 1);
  addGroup('检索', 'search', 1);
  addGroup('待办', 'todo', 1);
  addGroup('监控', 'monitor', 1);
  addGroup('信息', 'info', 1);

  const errors = groups.get('error') ?? [];
  if (errors.length > 0) {
    lines.push('', '**风险**');
    for (const err of errors.slice(-2)) {
      lines.push(`- ${err}`);
    }
  }

  return lines.join('\n');
}

export async function flushSessionDigest(
  session: Pick<ThreadSession, 'id' | 'agentLabel'>,
  channel: SessionChannel,
  force = false,
): Promise<void> {
  const state = getOrCreateState(session.id);
  if (state.digestQueue.length === 0) return;
  if (!force && Date.now() - state.lastDigestSentAt < DIGEST_MIN_INTERVAL_MS) return;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`📌 最近摘要｜${session.agentLabel}`)
    .setDescription(renderDigestDescription(state.digestQueue))
    .setFooter({ text: `更新于 ${formatTime(Date.now())}` });

  if (state.digestMessage) {
    await state.digestMessage.edit({ embeds: [embed] });
  } else {
    state.digestMessage = await channel.send({ embeds: [embed] });
  }

  state.digestQueue = [];
  state.lastDigestSentAt = Date.now();
}

export async function finalizeSessionPresentation(
  session: Pick<
    ThreadSession,
    'id' | 'agentLabel' | 'provider' | 'mode' | 'workflowState'
  >,
  channel: SessionChannel,
  finalState: {
    outcome: 'completed' | 'blocked' | 'stopped' | 'error';
    summary: string;
    terminal?: boolean;
  },
): Promise<void> {
  const state = getOrCreateState(session.id);
  const isTerminal = finalState.terminal ?? true;
  if (isTerminal && state.finalSent) return;
  if (isTerminal) state.finalSent = true;

  const mappedState: PresentationStateName =
    finalState.outcome === 'completed'
      ? 'completed'
      : finalState.outcome === 'blocked'
        ? 'blocked'
        : 'error';

  const statusSummary =
    isTerminal
      ? finalState.outcome === 'completed'
        ? '任务已结束'
        : finalState.outcome === 'blocked'
          ? '任务已阻塞'
          : '任务已失败'
      : '等待下一条消息';

  await updateSessionStatus(session, channel, {
    state: isTerminal ? mappedState : 'idle',
    phase: isTerminal ? (finalState.outcome === 'completed' ? '已结束' : '已收尾') : '待命',
    summary: statusSummary,
  });

  const baseTitle = isTerminal
    ? finalState.outcome === 'completed'
      ? `✅ 结束总结｜${session.agentLabel}`
      : finalState.outcome === 'blocked'
        ? `⛔ 阻塞总结｜${session.agentLabel}`
        : `❌ 结束总结｜${session.agentLabel}`
    : finalState.outcome === 'completed'
      ? `✅ 本轮总结｜${session.agentLabel}`
      : finalState.outcome === 'blocked'
        ? `⛔ 本轮总结｜${session.agentLabel}`
        : `❌ 本轮总结｜${session.agentLabel}`;

  const parts = splitMessage(finalState.summary, 3800);
  for (let index = 0; index < parts.length; index++) {
    const embed = new EmbedBuilder()
      .setColor(renderStateColor(mappedState))
      .setTitle(parts.length > 1 ? `${baseTitle}（${index + 1}/${parts.length}）` : baseTitle)
      .setDescription(parts[index])
      .addFields(
        { name: 'Provider', value: session.provider, inline: true },
        { name: 'Mode', value: session.mode, inline: true },
        { name: 'Updated', value: formatTime(Date.now()), inline: true },
      );

    await channel.send({ embeds: [embed] });
  }
}

export function incrementSessionCounters(
  sessionId: string,
  patch: Partial<Pick<PresentationState, 'commandCount' | 'fileChangeCount' | 'subagentCount'>>,
): void {
  const state = getOrCreateState(sessionId);
  state.commandCount += patch.commandCount ?? 0;
  state.fileChangeCount += patch.fileChangeCount ?? 0;
  state.subagentCount += patch.subagentCount ?? 0;
  state.updatedAt = Date.now();
}

export function resetSessionPresentationState(): void {
  states.clear();
}

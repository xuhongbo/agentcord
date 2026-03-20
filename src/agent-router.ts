import type { Message, TextChannel, WebhookClient } from 'discord.js';
import * as sessions from './session-manager.ts';
import * as agentMgr from './agent-manager.ts';
import { config } from './config.ts';
import { splitMessage, isAbortError } from './utils.ts';
import * as projectMgr from './project-manager.ts';
import type { AgentData } from './types.ts';
import type { ProviderEvent } from './providers/types.ts';

// ── Loop prevention ──

const chainState = new Map<string, { depth: number; lastHumanAt: number }>();
const MAX_DEPTH = 8;
const CHAIN_TTL = 5 * 60 * 1000; // 5 min

function canContinueChain(channelId: string): boolean {
  const state = chainState.get(channelId);
  if (!state) return true;
  if (Date.now() - state.lastHumanAt > CHAIN_TTL) {
    chainState.delete(channelId);
    return true;
  }
  return state.depth < MAX_DEPTH;
}

function getChainDepth(channelId: string): number {
  return chainState.get(channelId)?.depth ?? 0;
}

export function onHumanMessage(channelId: string): void {
  chainState.set(channelId, { depth: 0, lastHumanAt: Date.now() });
}

function onAgentMessage(channelId: string): void {
  const state = chainState.get(channelId) || { depth: 0, lastHumanAt: Date.now() };
  state.depth++;
  chainState.set(channelId, state);
}

// ── @Mention detection ──

// Matches @AgentName in text, skipping code blocks
export function detectAgentMentions(content: string): AgentData[] {
  // Strip code blocks first
  const stripped = content.replace(/```[\s\S]*?```/g, '').replace(/`[^`]+`/g, '');

  const agents = agentMgr.getAllAgents();
  const mentioned: AgentData[] = [];

  for (const agent of agents) {
    // Case-insensitive match for @Name
    const pattern = new RegExp(`@${escapeRegExp(agent.name)}\\b`, 'i');
    if (pattern.test(stripped)) {
      mentioned.push(agent);
    }
  }

  return mentioned;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Routing ──

export async function routeToAgents(
  message: Message,
  mentionedAgents: AgentData[],
  senderAgent?: AgentData,
): Promise<void> {
  const channel = message.channel as TextChannel;
  const channelId = channel.id;

  for (const agent of mentionedAgents) {
    // Self-reply block
    if (senderAgent && senderAgent.id === agent.id) continue;

    // Depth check
    if (!canContinueChain(channelId)) {
      const depth = getChainDepth(channelId);
      await channel.send(
        `*Pausing for human input \u2014 agents have exchanged ${depth} messages. Send a message to continue.*`,
      );
      return;
    }

    // Determine working directory and project from channel context
    const { directory, projectName } = resolveChannelContext(channel);

    // Get or create session for this agent in this channel
    const sessionId = await agentMgr.getOrCreateSession(agent, channelId, directory, projectName);

    // Build the prompt with sender context
    const prompt = senderAgent
      ? `[${senderAgent.emoji || ''} ${senderAgent.name}] ${message.content}`
      : `[User: ${message.author.displayName}] ${message.content}`;

    // Stream the response via webhook
    try {
      const responseText = await streamAgentResponse(agent, channel, sessionId, prompt);

      // Track depth
      onAgentMessage(channelId);

      // Check if response mentions other agents → cascade
      if (responseText) {
        const nextMentions = detectAgentMentions(responseText);
        if (nextMentions.length > 0) {
          // Create a fake message-like object for the cascade
          // We use the original message's channel reference
          const fakeMessage = {
            content: responseText,
            channel: message.channel,
            author: message.author, // Not used for agent routing
          } as unknown as Message;

          await routeToAgents(fakeMessage, nextMentions, agent);
        }
      }
    } catch (err: unknown) {
      if (!isAbortError(err)) {
        await channel.send(`Error from ${agent.name}: ${(err as Error).message || 'Unknown error'}`);
      }
    }
  }
}

// Figure out directory and project from the channel's category
function resolveChannelContext(channel: TextChannel): { directory: string; projectName: string } {
  const parentId = channel.parentId;
  if (parentId) {
    const project = projectMgr.getProjectByCategoryId(parentId);
    if (project) {
      return { directory: project.directory, projectName: project.name };
    }
  }
  return {
    directory: config.defaultDirectory,
    projectName: 'default',
  };
}

// ── Webhook streaming ──

export async function streamAgentResponse(
  agent: AgentData,
  channel: TextChannel,
  sessionId: string,
  prompt: string,
): Promise<string> {
  // Get or create webhook for this agent in this channel
  let webhookClient: WebhookClient;
  try {
    webhookClient = await agentMgr.getOrCreateWebhook(agent, channel);
  } catch {
    // Fallback: if we can't create webhooks (permissions), post as bot with embed
    return await streamAgentResponseFallback(agent, channel, sessionId, prompt);
  }

  const displayName = agent.emoji ? `${agent.emoji} ${agent.name}` : agent.name;

  // Show typing
  channel.sendTyping().catch(() => {});

  // Send prompt and collect response
  const stream = sessions.sendPrompt(sessionId, prompt);
  let fullText = '';
  let currentMessageId: string | null = null;
  let buffer = '';
  let lastFlush = Date.now();
  const FLUSH_INTERVAL = 500;

  try {
    for await (const event of stream) {
      if (event.type === 'text_delta') {
        fullText += event.text;
        buffer += event.text;

        const now = Date.now();
        if (now - lastFlush >= FLUSH_INTERVAL && buffer.length > 0) {
          await flushWebhookBuffer();
          lastFlush = now;
        }
      }
      // For agent chat, we only stream text — tool calls etc. happen silently
    }

    // Final flush
    if (buffer.length > 0 || !currentMessageId) {
      await flushWebhookBuffer();
    }
  } finally {
    webhookClient.destroy();
  }

  return fullText;

  async function flushWebhookBuffer(): Promise<void> {
    if (fullText.length === 0) return;

    const chunks = splitMessage(fullText);
    const lastChunk = chunks[chunks.length - 1];

    if (currentMessageId && chunks.length === 1) {
      // Edit existing message
      try {
        await webhookClient.editMessage(currentMessageId, {
          content: lastChunk,
        });
      } catch {
        // Message may have been deleted, send new one
        const msg = await webhookClient.send({
          content: lastChunk,
          username: displayName,
          avatarURL: agent.avatarUrl || undefined,
        });
        currentMessageId = typeof msg === 'string' ? msg : msg.id;
      }
    } else if (currentMessageId && chunks.length > 1) {
      // Content overflowed — finalize first message, send remainder
      try {
        await webhookClient.editMessage(currentMessageId, {
          content: chunks[0],
        });
      } catch { /* deleted */ }
      currentMessageId = null;

      for (let i = 1; i < chunks.length - 1; i++) {
        await webhookClient.send({
          content: chunks[i],
          username: displayName,
          avatarURL: agent.avatarUrl || undefined,
        });
      }

      const msg = await webhookClient.send({
        content: lastChunk,
        username: displayName,
        avatarURL: agent.avatarUrl || undefined,
      });
      currentMessageId = typeof msg === 'string' ? msg : msg.id;
    } else {
      // First message
      const msg = await webhookClient.send({
        content: lastChunk,
        username: displayName,
        avatarURL: agent.avatarUrl || undefined,
      });
      currentMessageId = typeof msg === 'string' ? msg : msg.id;
    }

    buffer = '';
  }
}

// Fallback when webhooks aren't available — post as bot with styled prefix
async function streamAgentResponseFallback(
  agent: AgentData,
  channel: TextChannel,
  sessionId: string,
  prompt: string,
): Promise<string> {
  const prefix = agent.emoji ? `**${agent.emoji} ${agent.name}:** ` : `**${agent.name}:** `;

  channel.sendTyping().catch(() => {});

  const stream = sessions.sendPrompt(sessionId, prompt);
  let fullText = '';

  for await (const event of stream) {
    if (event.type === 'text_delta') {
      fullText += event.text;
    }
  }

  if (fullText) {
    const chunks = splitMessage(prefix + fullText);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }

  return fullText;
}

import {
  type Message,
  type AnyThreadChannel,
  AttachmentBuilder,
} from 'discord.js';
import { readFileSync } from 'node:fs';
import sharp from 'sharp';
import { config } from './config.ts';
import { getSessionByThread } from './thread-manager.ts';
import { executeSessionPrompt } from './session-executor.ts';
import { handleOutputStream } from './output-handler.ts';
import { isUserAllowed, isAbortError } from './utils.ts';
import type { ContentBlock, ImageBlock, ImageMediaType } from './providers/types.ts';

// Per-user rate limiting (threadId-scoped): userId:threadId → timestamp
const lastMessageTime = new Map<string, number>();

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const TEXT_EXTS = new Set(['.txt', '.md', '.log', '.json', '.ts', '.js', '.py', '.sh', '.yaml', '.yml', '.toml', '.env', '.csv']);
const MAX_IMAGE_BASE64_BYTES = 5 * 1024 * 1024; // 5MB

async function fetchAttachment(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch attachment: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

function getExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot).toLowerCase() : '';
}

function mimeToMediaType(ext: string): ImageMediaType {
  switch (ext) {
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.gif': return 'image/gif';
    case '.webp': return 'image/webp';
    default: return 'image/png';
  }
}

async function buildImageBlock(data: Buffer, ext: string): Promise<ImageBlock> {
  let processed = data;

  // Resize if too large
  if (data.length > MAX_IMAGE_BASE64_BYTES) {
    try {
      processed = await sharp(data)
        .resize({ width: 1280, height: 1280, fit: 'inside', withoutEnlargement: true })
        .toBuffer();
    } catch {
      processed = data; // fallback to original
    }
  }

  return {
    type: 'image',
    source: {
      type: 'base64',
      media_type: mimeToMediaType(ext),
      data: processed.toString('base64'),
    },
  };
}

export async function handleMessage(message: Message): Promise<void> {
  // Ignore bots
  if (message.author.bot) return;

  // Only handle messages in threads
  if (!message.channel.isThread()) return;

  const thread = message.channel as AnyThreadChannel;

  // Only handle sessions we're managing
  const session = getSessionByThread(thread.id);
  if (!session) return;

  // Authorization
  if (!isUserAllowed(message.author.id, config.allowedUsers, config.allowAllUsers)) {
    await thread.send('You are not authorized to use this bot.').catch(() => {});
    return;
  }

  // Per-user+thread rate limiting
  const rateKey = `${message.author.id}:${thread.id}`;
  const now = Date.now();
  const last = lastMessageTime.get(rateKey) || 0;
  if (now - last < config.rateLimitMs) {
    return; // silently drop (don't spam with rate-limit messages)
  }
  lastMessageTime.set(rateKey, now);

  // Guard: already generating
  if (session.isGenerating) {
    await thread.send('*Agent is already generating. Stop it first with `/agent stop`.*').catch(() => {});
    return;
  }

  // Build content blocks from message text + attachments
  const blocks: ContentBlock[] = [];

  if (message.content.trim()) {
    blocks.push({ type: 'text', text: message.content.trim() });
  }

  for (const attachment of message.attachments.values()) {
    const ext = getExtension(attachment.name || '');

    if (IMAGE_EXTS.has(ext)) {
      try {
        const data = await fetchAttachment(attachment.url);
        const imageBlock = await buildImageBlock(data, ext);
        blocks.push(imageBlock);
      } catch {
        // Skip attachment on error
      }
    } else if (TEXT_EXTS.has(ext) && attachment.size < 100_000) {
      try {
        const data = await fetchAttachment(attachment.url);
        blocks.push({ type: 'text', text: `[${attachment.name}]\n${data.toString('utf-8')}` });
      } catch {
        // Skip
      }
    }
  }

  if (blocks.length === 0) return;

  // Execute the prompt via session executor
  await executeSessionPrompt(session, thread, blocks.length === 1 && blocks[0].type === 'text'
    ? (blocks[0] as { type: 'text'; text: string }).text
    : blocks);
}

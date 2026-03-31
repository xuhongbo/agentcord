import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { PlatformEvent } from './state/types.ts';
import { updateSessionState } from './panel-adapter.ts';
import * as sessions from './thread-manager.ts';
import { discoverAndRegisterSession } from './session-discovery.ts';
import type { Client } from 'discord.js';

const HOOK_PORT = 48760;
let server: ReturnType<typeof createServer> | null = null;
let discordClient: Client | null = null;

export function startHookServer(client: Client): void {
  discordClient = client;

  server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === 'POST' && req.url === '/hook-event') {
      await handleHookEvent(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  server.listen(HOOK_PORT, '127.0.0.1', () => {
    console.log(`Hook server listening on http://127.0.0.1:${HOOK_PORT}`);
  });

  server.on('error', (err) => {
    console.error(`Hook server error: ${err.message}`);
  });
}

export function stopHookServer(): void {
  if (server) {
    server.close();
    server = null;
  }
  discordClient = null;
}

async function handleHookEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];

  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', async () => {
    try {
      const body = Buffer.concat(chunks).toString();
      const event: PlatformEvent = JSON.parse(body);

      // 尝试查找已存在的会话
      let session = sessions.getSessionByCodexId(event.sessionId);

      // 如果会话不存在，尝试快速注册
      if (!session && discordClient && event.metadata?.cwd) {
        const registered = await discoverAndRegisterSession(discordClient, {
          provider: event.source === 'claude' ? 'claude' : 'codex',
          providerSessionId: event.sessionId,
          cwd: event.metadata.cwd as string,
          discoverySource: 'claude-hook',
        });

        if (registered) {
          session = sessions.getSession(registered.sessionId);
        }
      }

      if (!session) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: 'Session not found and could not register' }));
        return;
      }

      // 获取 Discord channel
      const channel = discordClient?.channels.cache.get(session.channelId);
      if (!channel || !('send' in channel)) {
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true, message: 'Channel not found' }));
        return;
      }

      // 更新会话状态
      await updateSessionState(session.id, event, {
        sourceHint: event.source === 'claude' ? 'claude' : 'codex',
        channel: channel as any,
      });

      // 更新最近观察信息
      sessions.updateSession(session.id, {
        lastObservedState: event.type,
        lastObservedEventKey: event.metadata?.hookEvent as string,
        lastObservedAt: event.timestamp,
      });

      res.writeHead(200);
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      console.error('Hook event error:', err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  });
}

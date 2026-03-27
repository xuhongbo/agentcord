import { describe, expect, it } from 'vitest';
import { handleOutputStream } from '../src/output-handler.ts';
import type { ProviderEvent } from '../src/providers/types.ts';

class FakeMessage {
  content = '';

  async edit(payload: string | { content?: string }): Promise<this> {
    if (typeof payload === 'string') {
      this.content = payload;
    } else if (typeof payload.content === 'string') {
      this.content = payload.content;
    }
    return this;
  }

  async delete(): Promise<void> {}
}

function createFakeChannel() {
  const sent: any[] = [];

  return {
    sent,
    async send(payload: any): Promise<FakeMessage> {
      sent.push(payload);
      const message = new FakeMessage();
      if (typeof payload === 'string') {
        message.content = payload;
      } else if (typeof payload?.content === 'string') {
        message.content = payload.content;
      }
      return message;
    },
    async sendTyping(): Promise<void> {},
  };
}

async function* streamEvents(events: ProviderEvent[]): AsyncGenerator<ProviderEvent> {
  for (const event of events) {
    yield event;
  }
}

function collectSentText(channel: ReturnType<typeof createFakeChannel>): string {
  return channel.sent
    .map((payload) => (typeof payload === 'string' ? payload : (payload?.content ?? '')))
    .filter(Boolean)
    .join('');
}

describe('handleOutputStream', () => {
  it('preserves the leading chunks of the first long streamed response', async () => {
    const channel = createFakeChannel();
    const longText = 'A'.repeat(2100) + 'B'.repeat(2100) + 'C'.repeat(200);

    await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: longText },
        { type: 'tool_start', toolName: 'Read', toolInput: '{}' },
      ]),
      channel as any,
      'session-1',
    );

    const sentText = collectSentText(channel);
    expect(sentText).toContain('A'.repeat(200));
    expect(sentText).toContain('B'.repeat(200));
    expect(sentText).toContain('C'.repeat(200));
  });

  it('returns the accumulated worker text after the stream finishes', async () => {
    const channel = createFakeChannel();

    const result = await handleOutputStream(
      streamEvents([
        { type: 'text_delta', text: 'Completed the requested change.' },
        { type: 'result', success: true, costUsd: 0, durationMs: 25, numTurns: 1, errors: [] },
      ]),
      channel as any,
      'session-2',
    );

    expect(result.text).toContain('Completed the requested change.');
  });
});

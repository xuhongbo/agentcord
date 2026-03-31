import { describe, expect, it } from 'vitest';
import { normalizeCodexEvent } from '../src/state/event-normalizer.ts';

describe('normalizeCodexEvent', () => {
  it('将 task_complete 映射为 completed', () => {
    const event = normalizeCodexEvent('event_msg:task_complete', 'session-1', {
      cwd: '/repo',
      observedState: 'attention',
      monitorSessionId: 'codex:abc',
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe('completed');
    expect(event?.source).toBe('codex');
    expect(event?.metadata).toMatchObject({
      eventKey: 'event_msg:task_complete',
      cwd: '/repo',
      observedState: 'attention',
      monitorSessionId: 'codex:abc',
    });
  });

  it('将 stale-cleanup 映射为 session_ended', () => {
    const event = normalizeCodexEvent('stale-cleanup', 'session-2', {
      cwd: '/repo',
      observedState: 'sleeping',
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe('session_ended');
  });

  it('当 eventKey 未映射时使用 observedState 回退', () => {
    const event = normalizeCodexEvent('unknown:event', 'session-3', {
      observedState: 'working',
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe('work_started');
  });

  it('permission 状态给中置信度', () => {
    const event = normalizeCodexEvent('unknown:event', 'session-4', {
      observedState: 'codex-permission',
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe('awaiting_human');
    expect(event?.confidence).toBe('medium');
  });

  it('当 observedState 为 codex-permission 时优先映射为 awaiting_human', () => {
    const event = normalizeCodexEvent('response_item:function_call', 'session-5', {
      observedState: 'codex-permission',
    });

    expect(event).not.toBeNull();
    expect(event?.type).toBe('awaiting_human');
    expect(event?.confidence).toBe('medium');
  });
});

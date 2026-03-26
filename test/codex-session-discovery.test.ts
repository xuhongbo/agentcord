import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  readSessionIndex,
  findSessionFileById,
  listCodexSessionsForProjects,
} from '../src/codex-session-discovery.ts';

describe('codex-session-discovery', () => {
  it('reads index and locates session file', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    mkdirSync(join(codexHome, 'sessions', '2026', '03'), { recursive: true });
    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      [
        JSON.stringify({ id: 'abc', thread_name: 'feature x', updated_at: 123 }),
        JSON.stringify({ thread_name: 'missing id' }),
      ].join('\n'),
    );
    writeFileSync(
      join(codexHome, 'sessions', '2026', '03', 'one.jsonl'),
      `${JSON.stringify({ type: 'session_meta', payload: { cwd: '/repo/a' }, id: 'abc' })}\n${JSON.stringify({ type: 'user', text: 'hi' })}`,
    );

    const index = readSessionIndex(codexHome);
    expect(index).toHaveLength(1);
    expect(index[0].threadName).toBe('feature x');

    const file = findSessionFileById('abc', codexHome);
    expect(file).toContain('one.jsonl');
  });

  it('filters by mounted project path', () => {
    const codexHome = mkdtempSync(join(tmpdir(), 'codex-home-'));
    mkdirSync(join(codexHome, 'sessions'), { recursive: true });

    writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      JSON.stringify({ id: 'sid-1', thread_name: 'thread 1', updated_at: 1 }),
    );
    writeFileSync(
      join(codexHome, 'sessions', 's.jsonl'),
      JSON.stringify({ type: 'session_meta', payload: { cwd: '/work/project-a/sub' }, id: 'sid-1' }),
    );

    const sessions = listCodexSessionsForProjects(['/work/project-a', '/work/project-b'], codexHome);
    expect(sessions).toHaveLength(1);
    expect(sessions[0].projectPath).toBe('/work/project-a');
  });
});

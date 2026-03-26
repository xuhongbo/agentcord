import { mkdtempSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, beforeEach } from 'vitest';
import { Store, _setDataDirForTest } from '../src/persistence.ts';

let dataDir = '';

describe('json persistence store', () => {
  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'agentcord-persist-'));
    _setDataDirForTest(dataDir);
  });

  it('writes and reads json data', async () => {
    const s = new Store<Record<string, { name: string }>>('projects.json');
    await s.write({ demo: { name: 'demo' } });

    const data = await s.read();
    expect(data?.demo?.name).toBe('demo');
  });

  it('stores files in the configured data dir', async () => {
    const s = new Store<Record<string, { id: string }>>('agents.json');
    await s.write({ a1: { id: 'a1' } });

    const data = await s.read();
    expect(data?.a1?.id).toBe('a1');
    expect(existsSync(join(dataDir, 'agents.json'))).toBe(true);
  });
});

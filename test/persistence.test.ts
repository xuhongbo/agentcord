import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = process.cwd();
const PERSISTENCE_MODULE = join(REPO_ROOT, 'src', 'persistence.ts');

function runInIsolatedDir(code: string, cwd: string): string {
  return execFileSync(
    'node',
    ['--experimental-strip-types', '-e', code],
    { cwd, encoding: 'utf-8' },
  );
}

describe('sqlite persistence store', () => {
  it('migrates legacy json to sqlite and archives source file', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentcord-persist-'));
    const dataDir = join(cwd, '.discord-friends');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'projects.json'), JSON.stringify({ demo: { name: 'demo' } }), 'utf-8');

    const script = `
      const { Store } = await import(${JSON.stringify(PERSISTENCE_MODULE)});
      const s = new Store('projects.json');
      const first = await s.read();
      if (!first?.demo) throw new Error('missing migrated data');
      await s.write({ demo2: { name: 'demo2' } });
      const second = await s.read();
      if (!second?.demo2) throw new Error('missing sqlite write');
      console.log('ok');
    `;

    const output = runInIsolatedDir(script, cwd);
    expect(output).toContain('ok');
    expect(existsSync(join(dataDir, 'state.db'))).toBe(true);
    expect(existsSync(join(dataDir, 'legacy-json', 'projects.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'projects.json'))).toBe(false);
  });

  it('reads sqlite data across process restarts', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'agentcord-persist-'));

    runInIsolatedDir(
      `
        const { Store } = await import(${JSON.stringify(PERSISTENCE_MODULE)});
        const s = new Store('agents.json');
        await s.write({ a1: { id: 'a1' } });
      `,
      cwd,
    );

    const output = runInIsolatedDir(
      `
        const { Store } = await import(${JSON.stringify(PERSISTENCE_MODULE)});
        const s = new Store('agents.json');
        const data = await s.read();
        if (!data?.a1) throw new Error('missing persisted row');
        console.log(JSON.stringify(data));
      `,
      cwd,
    );

    expect(existsSync(join(cwd, '.discord-friends', 'state.db'))).toBe(true);
    expect(output).toContain('"a1"');
  });
});

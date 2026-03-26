import { beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { _setDataDirForTest } from '../src/persistence.ts';
import {
  loadRegistry,
  registerProject,
  getProjectByName,
  getProjectByPath,
  getAllRegisteredProjects,
  renameProject,
  removeProject,
} from '../src/project-registry.ts';

describe('project-registry', () => {
  let dataDir: string;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'agentcord-project-reg-'));
    _setDataDirForTest(dataDir);
    await loadRegistry();
  });

  it('registers and queries projects', async () => {
    const project = await registerProject('demo', '/tmp/demo');
    expect(getProjectByName('demo')?.id).toBe(project.id);
    expect(getProjectByPath('/tmp/demo')?.name).toBe('demo');
    expect(getAllRegisteredProjects().length).toBe(1);
  });

  it('rejects duplicate path and duplicate name', async () => {
    await registerProject('demo', '/tmp/demo');
    await expect(registerProject('demo2', '/tmp/demo')).rejects.toThrow(/Path already registered/);
    await expect(registerProject('demo', '/tmp/another')).rejects.toThrow(/Project name already exists/);
  });

  it('renames and removes project', async () => {
    await registerProject('demo', '/tmp/demo');
    await renameProject('demo', 'demo-renamed');
    expect(getProjectByName('demo')).toBeUndefined();
    expect(getProjectByName('demo-renamed')).toBeDefined();

    await removeProject('demo-renamed');
    expect(getAllRegisteredProjects()).toHaveLength(0);
  });

  it('migrates legacy projects.json object map to registry array shape', async () => {
    const legacy = {
      legacy: {
        name: 'legacy',
        directory: '/tmp/legacy',
        categoryId: 'cat-123',
        logChannelId: 'log-456',
        skills: { build: 'run build' },
        mcpServers: [{ name: 'ctx', command: 'npx', args: ['ctx'] }],
      },
    };
    writeFileSync(join(dataDir, 'projects.json'), JSON.stringify(legacy, null, 2), 'utf-8');

    await loadRegistry();

    const project = getProjectByName('legacy');
    expect(project).toBeDefined();
    expect(project?.path).toBe('/tmp/legacy');
    expect(project?.discordCategoryId).toBe('cat-123');
    expect(project?.discordLogChannelId).toBe('log-456');
    expect(project?.skills).toEqual({ build: 'run build' });
    expect(project?.mcpServers).toHaveLength(1);

    const persisted = JSON.parse(readFileSync(join(dataDir, 'projects.json'), 'utf-8'));
    expect(Array.isArray(persisted)).toBe(true);
    expect(persisted[0]?.path).toBe('/tmp/legacy');
  });
});

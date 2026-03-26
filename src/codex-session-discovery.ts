import { existsSync, readFileSync, globSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export interface CodexIndexedSession {
  id: string;
  threadName: string;
  updatedAt?: number;
}

export interface CodexDiscoveredSession {
  id: string;
  threadName: string;
  updatedAt?: number;
  cwd: string;
  projectPath: string;
}

export function readSessionIndex(codexHome = join(homedir(), '.codex')): CodexIndexedSession[] {
  const indexPath = join(codexHome, 'session_index.jsonl');
  if (!existsSync(indexPath)) return [];
  const lines = readFileSync(indexPath, 'utf-8').split('\n').filter(Boolean);

  const out: CodexIndexedSession[] = [];
  for (const line of lines) {
    try {
      const json = JSON.parse(line);
      if (!json.id || typeof json.id !== 'string') continue;
      out.push({
        id: json.id,
        threadName: typeof json.thread_name === 'string' && json.thread_name ? json.thread_name : json.id,
        updatedAt: typeof json.updated_at === 'number' ? json.updated_at : undefined,
      });
    } catch {
      // skip malformed records
    }
  }
  return out;
}

export function findSessionFileById(id: string, codexHome = join(homedir(), '.codex')): string | null {
  const sessionsDir = join(codexHome, 'sessions');
  if (!existsSync(sessionsDir)) return null;

  const files = globSync(join(sessionsDir, '**/*.jsonl'));
  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf-8');
      if (content.includes(id)) return file;
    } catch {
      // continue
    }
  }
  return null;
}

export function isSubpathOfProject(cwd: string, projectPath: string): boolean {
  const normalizedCwd = resolve(cwd);
  const normalizedProject = resolve(projectPath);
  return normalizedCwd === normalizedProject || normalizedCwd.startsWith(`${normalizedProject}${sep}`);
}

export function listCodexSessionsForProjects(
  projectPaths: string[],
  codexHome = join(homedir(), '.codex'),
): CodexDiscoveredSession[] {
  const indexed = readSessionIndex(codexHome);
  const normalizedProjects = projectPaths.map(p => resolve(p));
  const out: CodexDiscoveredSession[] = [];

  for (const row of indexed) {
    try {
      const file = findSessionFileById(row.id, codexHome);
      if (!file) continue;
      const firstLine = readFileSync(file, 'utf-8').split('\n').find(Boolean);
      if (!firstLine) continue;
      const first = JSON.parse(firstLine);
      if (first.type !== 'session_meta') continue;
      const cwd = first.payload?.cwd;
      if (typeof cwd !== 'string' || !cwd) continue;

      const matches = normalizedProjects.filter(projectPath => isSubpathOfProject(cwd, projectPath));
      if (matches.length === 0) continue;
      matches.sort((a, b) => b.length - a.length);

      out.push({
        id: row.id,
        threadName: row.threadName,
        updatedAt: row.updatedAt,
        cwd: resolve(cwd),
        projectPath: matches[0],
      });
    } catch {
      // skip this session
    }
  }

  return out;
}

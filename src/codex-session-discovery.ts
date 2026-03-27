import { existsSync, readFileSync, globSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';

let rgAvailable: boolean | null = null;

function isRipgrepAvailable(): boolean {
  if (rgAvailable !== null) return rgAvailable;
  try {
    execFileSync('rg', ['--version'], { stdio: 'ignore' });
    rgAvailable = true;
  } catch {
    rgAvailable = false;
  }
  return rgAvailable;
}

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

interface SessionMetaRecord {
  sessionId: string | null;
  cwd: string | null;
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

function readSessionMetaRecord(file: string): SessionMetaRecord | null {
  try {
    const firstLine = readFileSync(file, 'utf-8').split('\n').find(Boolean);
    if (!firstLine) return null;
    const first = JSON.parse(firstLine);
    if (first.type !== 'session_meta') return null;
    const sessionId = typeof first.payload?.id === 'string'
      ? first.payload.id
      : typeof first.id === 'string'
        ? first.id
        : null;
    const cwd = typeof first.payload?.cwd === 'string' ? first.payload.cwd : null;
    return { sessionId, cwd };
  } catch {
    return null;
  }
}

function fileMatchesSessionId(file: string, id: string): boolean {
  const meta = readSessionMetaRecord(file);
  return meta?.sessionId === id;
}

export function findSessionFileById(id: string, codexHome = join(homedir(), '.codex')): string | null {
  const sessionsDir = join(codexHome, 'sessions');
  if (!existsSync(sessionsDir)) return null;

  // Only try ripgrep if it's available
  if (isRipgrepAvailable()) {
    try {
      const result = execFileSync(
        'rg',
        ['-l', '--fixed-strings', `"${id}"`, sessionsDir],
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] },
      )
        .trim()
        .split('\n')
        .filter(Boolean);
      for (const file of result) {
        if (fileMatchesSessionId(file, id)) return file;
      }
    } catch {
      // fall back to slower in-process scan
    }
  }

  const files = globSync(join(sessionsDir, '**/*.jsonl'));
  for (const file of files) {
    if (fileMatchesSessionId(file, id)) return file;
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
      const meta = readSessionMetaRecord(file);
      if (!meta || meta.sessionId !== row.id || !meta.cwd) continue;
      const cwd = meta.cwd;

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

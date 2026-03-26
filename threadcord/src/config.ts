import 'dotenv/config';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ProviderName, SessionMode } from './types.ts';

function required(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optional(key: string, fallback: string): string {
  return process.env[key] || fallback;
}

function optionalList(key: string, fallback: string[] = []): string[] {
  const val = process.env[key];
  if (!val) return fallback;
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function optionalInt(key: string, fallback: number): number {
  const val = process.env[key];
  if (!val) return fallback;
  const n = parseInt(val, 10);
  return isNaN(n) ? fallback : n;
}

function optionalBool(key: string, fallback: boolean): boolean {
  const val = process.env[key];
  if (!val) return fallback;
  return val === 'true' || val === '1';
}

export const config = {
  // Discord
  token: required('DISCORD_TOKEN'),
  clientId: required('DISCORD_CLIENT_ID'),
  guildId: optional('DISCORD_GUILD_ID', ''),

  // Access control
  allowedUsers: optionalList('ALLOWED_USER_IDS'),
  allowAllUsers: optionalBool('ALLOW_ALL_USERS', false),

  // Filesystem
  defaultDirectory: optional('DEFAULT_DIRECTORY', homedir()),
  allowedPaths: optionalList('ALLOWED_PATHS', [homedir()]),
  dataDir: optional('DATA_DIR', join(homedir(), '.threadcord')),

  // Provider defaults
  defaultProvider: optional('DEFAULT_PROVIDER', 'claude') as ProviderName,
  defaultMode: optional('DEFAULT_MODE', 'auto') as SessionMode,

  // Subagent limits
  maxSubagentDepth: optionalInt('MAX_SUBAGENT_DEPTH', 3),

  // Session limits & auto-archive
  maxActiveSessionsPerProject: optionalInt('MAX_ACTIVE_SESSIONS', 20),
  autoArchiveDays: optionalInt('AUTO_ARCHIVE_DAYS', 7),

  // Message cleanup
  messageRetentionDays: optionalInt('MESSAGE_RETENTION_DAYS', 0),

  // Rate limiting
  rateLimitMs: optionalInt('RATE_LIMIT_MS', 1000),

  // Codex provider defaults
  codexSandboxMode: optional('CODEX_SANDBOX_MODE', 'workspace') as 'workspace' | 'project' | 'none',
  codexApprovalPolicy: optional('CODEX_APPROVAL_POLICY', 'auto-edit') as 'auto-edit' | 'on-failure' | 'never',
  codexNetworkAccessEnabled: optionalBool('CODEX_NETWORK_ACCESS', false),
} as const;

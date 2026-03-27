import Configstore from 'configstore';

export const SENSITIVE_KEYS = new Set([
  'DISCORD_TOKEN',
  'ANTHROPIC_API_KEY',
  'CODEX_API_KEY',
]);

export const VALID_KEYS = new Set([
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'ALLOWED_USERS',
  'ALLOW_ALL_USERS',
  'DEFAULT_PROVIDER',
  'DEFAULT_MODE',
  'CLAUDE_PERMISSION_MODE',
  'MAX_SUBAGENT_DEPTH',
  'MAX_ACTIVE_SESSIONS',
  'AUTO_ARCHIVE_DAYS',
  'CODEX_SANDBOX_MODE',
  'CODEX_APPROVAL_POLICY',
  'CODEX_NETWORK_ACCESS_ENABLED',
  'CODEX_WEB_SEARCH',
  'CODEX_REASONING_EFFORT',
  'CODEX_PATH',
  'CODEX_API_KEY',
  'CODEX_BASE_URL',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'MESSAGE_RETENTION_DAYS',
  'RATE_LIMIT_MS',
  'SHELL_ENABLED',
  'SHELL_ALLOWED_USERS',
  'SESSION_SYNC_INTERVAL_MS',
  'HEALTH_REPORT_ENABLED',
  'HEALTH_REPORT_INTERVAL_MS',
  'HEALTH_CHECK_STUCK_THRESHOLD_MS',
  'HEALTH_CHECK_IDLE_THRESHOLD_MS',
]);

const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const CODEX_APPROVAL_POLICIES = new Set(['never', 'on-request', 'on-failure', 'untrusted']);

let store: Configstore | null = null;

function getStore(): Configstore {
  if (!store) {
    store = new Configstore('threadcord', {}, { globalConfigPath: true });
  }
  return store;
}

/** 仅测试时使用，替换底层 store 实例 */
export function _setStoreForTest(s: Configstore): void {
  store = s;
}

/**
 * 校验配置值。返回 null 表示合法，返回字符串表示错误信息。
 */
export function validateConfigValue(key: string, value: string): string | null {
  if (!VALID_KEYS.has(key)) {
    return `Unknown config key: ${key}. Valid keys: ${Array.from(VALID_KEYS).join(', ')}`;
  }
  switch (key) {
    case 'CODEX_SANDBOX_MODE':
      if (!CODEX_SANDBOX_MODES.has(value)) {
        return `Invalid value for CODEX_SANDBOX_MODE. Expected one of: ${Array.from(CODEX_SANDBOX_MODES).join(', ')}`;
      }
      break;
    case 'CODEX_APPROVAL_POLICY':
      if (!CODEX_APPROVAL_POLICIES.has(value)) {
        return `Invalid value for CODEX_APPROVAL_POLICY. Expected one of: ${Array.from(CODEX_APPROVAL_POLICIES).join(', ')}`;
      }
      break;
    case 'ALLOW_ALL_USERS':
      if (value !== 'true' && value !== 'false') {
        return `Invalid value for ALLOW_ALL_USERS. Expected "true" or "false"`;
      }
      break;

    case 'SHELL_ENABLED':
      if (value !== 'true' && value !== 'false') {
        return `Invalid value for SHELL_ENABLED. Expected "true" or "false"`;
      }
      break;
    case 'RATE_LIMIT_MS':
    case 'SESSION_SYNC_INTERVAL_MS':
    case 'HEALTH_REPORT_INTERVAL_MS':
    case 'HEALTH_CHECK_STUCK_THRESHOLD_MS':
    case 'HEALTH_CHECK_IDLE_THRESHOLD_MS': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        return `Invalid value for ${key}. Expected a non-negative integer`;
      }
      break;
    }
    case 'HEALTH_REPORT_ENABLED':
      if (value !== 'true' && value !== 'false') {
        return `Invalid value for HEALTH_REPORT_ENABLED. Expected "true" or "false"`;
      }
      break;
    case 'MAX_SUBAGENT_DEPTH':
    case 'MAX_ACTIVE_SESSIONS': {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return `Invalid value for ${key}. Expected a positive integer`;
      }
      break;
    }
    case 'MESSAGE_RETENTION_DAYS': {
      const n = Number(value);
      if (!Number.isInteger(n) || n <= 0) {
        return `Invalid value for MESSAGE_RETENTION_DAYS. Expected a positive integer`;
      }
      break;
    }
    case 'AUTO_ARCHIVE_DAYS': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        return `Invalid value for AUTO_ARCHIVE_DAYS. Expected a non-negative integer`;
      }
      break;
    }
    case 'DEFAULT_PROVIDER':
      if (!['claude', 'codex'].includes(value)) {
        return `Invalid value for DEFAULT_PROVIDER. Expected one of: claude, codex`;
      }
      break;
    case 'DEFAULT_MODE':
      if (!['auto', 'plan', 'normal', 'monitor'].includes(value)) {
        return `Invalid value for DEFAULT_MODE. Expected one of: auto, plan, normal, monitor`;
      }
      break;
    case 'CLAUDE_PERMISSION_MODE':
      if (!['bypass', 'normal'].includes(value)) {
        return `Invalid value for CLAUDE_PERMISSION_MODE. Expected one of: bypass, normal`;
      }
      break;
    case 'CODEX_WEB_SEARCH':
      if (!['disabled', 'cached', 'live'].includes(value)) {
        return `Invalid value for CODEX_WEB_SEARCH. Expected one of: disabled, cached, live`;
      }
      break;
    case 'CODEX_REASONING_EFFORT':
      if (!['', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
        return `Invalid value for CODEX_REASONING_EFFORT. Expected one of: minimal, low, medium, high, xhigh`;
      }
      break;
  }
  return null;
}

/**
 * 对敏感值打码：保留首尾各 4 字符，中间替换为 ********
 */
export function maskSensitive(key: string, value: string): string {
  if (!SENSITIVE_KEYS.has(key)) return value;
  if (value.length <= 8) return '********';
  return `${value.slice(0, 4)}********${value.slice(-4)}`;
}

export function getConfigValue(key: string): string | undefined {
  return getStore().get(key) as string | undefined;
}

export function setConfigValue(key: string, value: string): void {
  getStore().set(key, value);
}

export function deleteConfigValue(key: string): void {
  getStore().delete(key);
}

export function getAllConfig(): Record<string, string> {
  return (getStore().all ?? {}) as Record<string, string>;
}

export function getConfigPath(): string {
  return getStore().path;
}

import Configstore from 'configstore';

export const SENSITIVE_KEYS = new Set(['DISCORD_TOKEN']);

export const VALID_KEYS = new Set([
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'DISCORD_GUILD_ID',
  'ALLOWED_USERS',
  'ALLOW_ALL_USERS',
  'CODEX_SANDBOX_MODE',
  'CODEX_APPROVAL_POLICY',
  'CODEX_NETWORK_ACCESS_ENABLED',
  'MESSAGE_RETENTION_DAYS',
  'RATE_LIMIT_MS',
  'SHELL_ENABLED',
  'SHELL_ALLOWED_USERS',
]);

const CODEX_SANDBOX_MODES = new Set(['read-only', 'workspace-write', 'danger-full-access']);
const CODEX_APPROVAL_POLICIES = new Set(['never', 'on-request', 'on-failure', 'untrusted']);

let store: Configstore | null = null;

function getStore(): Configstore {
  if (!store) {
    store = new Configstore('agentcord', {}, { globalConfigPath: true });
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
    case 'RATE_LIMIT_MS': {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0) {
        return `Invalid value for RATE_LIMIT_MS. Expected a non-negative integer`;
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

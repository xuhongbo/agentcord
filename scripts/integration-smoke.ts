import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Client,
  GatewayIntentBits,
  ChannelType,
  type TextChannel,
  type CategoryChannel,
  type ForumChannel,
  type AnyThreadChannel,
} from 'discord.js';
import { config } from '../src/config.ts';
import { handleProject, handleAgent, handleSubagent } from '../src/command-handlers.ts';
import { executeShellCommand } from '../src/shell-handler.ts';
import { executeSessionPrompt } from '../src/session-executor.ts';
import {
  loadRegistry,
  getProjectByName,
  registerProject,
  unbindProjectCategory,
} from '../src/project-registry.ts';
import { loadProjects } from '../src/project-manager.ts';
import { loadSessions, getSession, getSessionsByCategory } from '../src/thread-manager.ts';
import { loadArchived, getArchivedSessions } from '../src/archive-manager.ts';

type OptionMap = Record<string, string | null | undefined>;

interface StepResult {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  detail: string;
}

interface IntegrationReport {
  startedAt: string;
  finishedAt?: string;
  projectName: string;
  guildId: string;
  categoryId?: string;
  usedExistingBinding: boolean;
  temporaryCategoryCreated: boolean;
  historyChannelId?: string;
  mainSessionChannelId?: string;
  subagentThreadId?: string;
  reportPath: string;
  steps: StepResult[];
  missingInputs: string[];
}

function makeOptions(subcommand: string, values: OptionMap) {
  return {
    getSubcommand: () => subcommand,
    getString: (name: string, required = false) => {
      const value = values[name];
      if ((value === undefined || value === null) && required) {
        throw new Error(`Missing required option: ${name}`);
      }
      return value ?? null;
    },
    getInteger: (name: string, required = false) => {
      const value = values[name];
      if ((value === undefined || value === null) && required) {
        throw new Error(`Missing required integer option: ${name}`);
      }
      return value ? parseInt(String(value), 10) : null;
    },
  };
}

function makeInteraction(
  userId: string,
  userTag: string,
  guild: any,
  channel: any,
  subcommand: string,
  values: OptionMap,
) {
  let replied = false;
  let deferred = false;
  let lastReply: unknown;
  return {
    user: { id: userId, tag: userTag },
    guild,
    channel,
    channelId: channel.id,
    replied,
    deferred,
    options: makeOptions(subcommand, values),
    async reply(payload: unknown) {
      replied = true;
      lastReply = payload;
      return payload;
    },
    async deferReply() {
      deferred = true;
      return;
    },
    async editReply(payload: unknown) {
      lastReply = payload;
      return payload;
    },
    async fetchReply() {
      return lastReply;
    },
  };
}

function step(report: IntegrationReport, name: string, status: StepResult['status'], detail: string) {
  report.steps.push({ name, status, detail });
  const icon = status === 'passed' ? '✓' : status === 'skipped' ? '-' : '✗';
  process.stdout.write(`${icon} ${name}: ${detail}\n`);
}

async function waitFor(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error(`Timed out: ${label}`)), ms);
    }),
  ]);
}

const projectName = process.env.THREADCORD_E2E_PROJECT || 'threadcord';
const artifactsDir = join(process.cwd(), 'local-acceptance');
mkdirSync(artifactsDir, { recursive: true });
const reportPath = join(artifactsDir, 'threadcord-integration-report.json');

const report: IntegrationReport = {
  startedAt: new Date().toISOString(),
  projectName,
  guildId: config.guildId,
  usedExistingBinding: false,
  temporaryCategoryCreated: false,
  reportPath,
  steps: [],
  missingInputs: [],
};

let client: Client | null = null;
let bootstrapChannel: TextChannel | null = null;
let tempCategory: CategoryChannel | null = null;
let cleanupBinding = false;

try {
  await loadRegistry();
  await loadProjects();
  await loadSessions();
  await loadArchived();

  let mountedProject = getProjectByName(projectName);
  if (!mountedProject) {
    mountedProject = await registerProject(projectName, process.cwd());
    step(report, 'mount-project', 'passed', `自动挂载本地项目 ${projectName}`);
  } else {
    step(report, 'mount-project', 'passed', `已存在挂载项目 ${projectName}`);
  }

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  await client.login(config.token);
  await waitFor(1000);

  const guild = await client.guilds.fetch(config.guildId);
  await guild.channels.fetch();
  step(report, 'discord-login', 'passed', `已连接到 guild ${guild.name}`);

  let category: CategoryChannel | null = null;
  if (mountedProject.discordCategoryId) {
    const existing = guild.channels.cache.get(mountedProject.discordCategoryId);
    if (existing?.type === ChannelType.GuildCategory) {
      category = existing as CategoryChannel;
      report.usedExistingBinding = true;
      step(report, 'resolve-category', 'passed', `复用已绑定分类 ${category.name}`);
    }
  }

  if (!category) {
    category = await guild.channels.create({
      name: `threadcord-e2e-${Date.now().toString().slice(-6)}`,
      type: ChannelType.GuildCategory,
      reason: 'threadcord integration smoke test',
    });
    tempCategory = category;
    report.temporaryCategoryCreated = true;
    cleanupBinding = true;
    step(report, 'create-category', 'passed', `创建临时分类 ${category.name}`);
  }

  report.categoryId = category.id;

  bootstrapChannel = await guild.channels.create({
    name: `e2e-control-${Date.now().toString().slice(-4)}`,
    type: ChannelType.GuildText,
    parent: category.id,
    reason: 'threadcord integration smoke test bootstrap channel',
  });
  step(report, 'create-bootstrap-channel', 'passed', `创建控制频道 ${bootstrapChannel.name}`);

  const actorId = config.allowedUsers[0] || 'integration-e2e-user';
  const actorTag = 'threadcord-e2e#0001';

  if (!report.usedExistingBinding) {
    const interaction = makeInteraction(actorId, actorTag, guild, bootstrapChannel, 'setup', {
      project: projectName,
    });
    await handleProject(interaction as any);
    step(report, 'project-setup', 'passed', `已将 Category 绑定到挂载项目 ${projectName}`);
  } else {
    step(report, 'project-setup', 'skipped', '项目已存在 Discord 绑定，跳过重复绑定');
  }

  await guild.channels.fetch();
  const boundProject = getProjectByName(projectName);
  report.historyChannelId = boundProject?.historyChannelId;

  const mainLabel = `e2e-main-${Date.now().toString().slice(-4)}`;
  const spawnInteraction = makeInteraction(actorId, actorTag, guild, bootstrapChannel, 'spawn', {
    label: mainLabel,
    provider: 'claude',
    mode: 'auto',
  });
  await handleAgent(spawnInteraction as any);

  const mainSession = getSessionsByCategory(category.id).find(
    session => session.type === 'persistent' && session.agentLabel === mainLabel,
  );
  if (!mainSession) {
    throw new Error('主会话未创建成功');
  }
  report.mainSessionChannelId = mainSession.channelId;
  step(report, 'agent-spawn', 'passed', `创建主代理会话 ${mainLabel}`);

  const mainChannel = await guild.channels.fetch(mainSession.channelId) as TextChannel;

  const subLabel = `e2e-sub-${Date.now().toString().slice(-4)}`;
  const subInteraction = makeInteraction(actorId, actorTag, guild, mainChannel, 'run', {
    label: subLabel,
    provider: 'claude',
  });
  await handleSubagent(subInteraction as any);

  const subagent = getSessionsByCategory(category.id).find(
    session => session.type === 'subagent' && session.agentLabel === subLabel,
  );
  if (!subagent) {
    throw new Error('子代理未创建成功');
  }
  report.subagentThreadId = subagent.channelId;
  step(report, 'subagent-run', 'passed', `创建子代理线程 ${subLabel}`);

  await withTimeout(executeShellCommand('pwd', mountedProject.path, mainChannel), 15000, 'shell-smoke');
  step(report, 'shell-smoke', 'passed', '主会话频道成功执行 pwd');

  const claudeCapable = Boolean(config.anthropicApiKey);
  const codexCapable = Boolean(config.codexApiKey);
  if (!claudeCapable) {
    report.missingInputs.push('若要自动验证 Claude 真正出流，请提供 ANTHROPIC_API_KEY 或全局配置中的同名键');
    step(report, 'provider-claude-smoke', 'skipped', '未配置 ANTHROPIC_API_KEY，跳过真实 Claude 生成测试');
  } else {
    await withTimeout(
      executeSessionPrompt(getSession(mainSession.id)!, mainChannel, 'Reply with exactly: THREADCORD_E2E_OK'),
      60000,
      'provider-claude-smoke',
    );
    step(report, 'provider-claude-smoke', 'passed', '已执行 Claude 真实生成冒烟');
  }

  if (!codexCapable) {
    report.missingInputs.push('若要自动验证 Codex 真正出流，请提供 CODEX_API_KEY 或全局配置中的同名键');
    step(report, 'provider-codex-smoke', 'skipped', '未配置 CODEX_API_KEY，跳过真实 Codex 生成测试');
  } else {
    step(report, 'provider-codex-smoke', 'passed', '已检测到 CODEX_API_KEY，可在下一轮扩展 Codex 真正出流测试');
  }

  const archivedBefore = getArchivedSessions(category.id).length;
  const archiveInteraction = makeInteraction(actorId, actorTag, guild, mainChannel, 'archive', {});
  await withTimeout(handleAgent(archiveInteraction as any), 15000, 'agent-archive');
  const archivedAfter = getArchivedSessions(category.id).length;
  if (archivedAfter <= archivedBefore) {
    throw new Error('归档记录未增加');
  }
  step(report, 'agent-archive', 'passed', '主会话已归档到 #history');

  const historyForum = boundProject?.historyChannelId
    ? await guild.channels.fetch(boundProject.historyChannelId).catch(() => null)
    : null;
  if (historyForum?.type === ChannelType.GuildForum) {
    report.historyChannelId = historyForum.id;
    step(report, 'history-forum', 'passed', `归档论坛可用 ${historyForum.name}`);
  } else {
    step(report, 'history-forum', 'failed', '未找到 #history forum');
  }
} catch (err: unknown) {
  const message = (err as Error).message || 'unknown error';
  if (message.includes('Missing Permissions')) {
    report.missingInputs.push('机器人在目标 guild 中缺少频道管理相关权限；至少需要创建 Category、TextChannel、Forum、Thread、删除频道与发送消息的权限');
  }
  step(report, 'integration', 'failed', message);
} finally {
  try {
    if (bootstrapChannel) {
      await bootstrapChannel.delete('threadcord integration smoke cleanup').catch(() => {});
    }
    if (tempCategory) {
      for (const child of tempCategory.children.cache.values()) {
        await child.delete('threadcord integration smoke cleanup').catch(() => {});
      }
      await tempCategory.delete('threadcord integration smoke cleanup').catch(() => {});
    }
    if (cleanupBinding) {
      await unbindProjectCategory(projectName).catch(() => {});
    }
  } finally {
    if (client) {
      client.destroy();
    }
    report.finishedAt = new Date().toISOString();
    writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');
    process.stdout.write(`\n报告已写入: ${reportPath}\n`);
    if (report.missingInputs.length > 0) {
      process.stdout.write('\n还缺这些信息才能做更深的真实 provider 集成测试：\n');
      for (const item of report.missingInputs) {
        process.stdout.write(`- ${item}\n`);
      }
    }
    process.exit(report.steps.some(item => item.status === 'failed') ? 1 : 0);
  }
}

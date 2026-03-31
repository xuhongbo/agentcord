// 本地会话快速注册
// 实现设计文档第 7.4 节的统一注册流程

import type { Client, CategoryChannel, TextChannel } from 'discord.js';
import { ChannelType } from 'discord.js';
import type { ProviderName } from './types.ts';
import * as sessions from './thread-manager.ts';
import * as projects from './project-manager.ts';

export interface SessionDiscoveryParams {
  provider: ProviderName;
  providerSessionId: string;
  cwd: string;
  discoverySource: 'claude-hook' | 'codex-log';
}

export async function discoverAndRegisterSession(
  client: Client,
  params: SessionDiscoveryParams,
): Promise<{ sessionId: string; channelId: string; isNew: boolean } | null> {
  // 1. 检查是否已注册
  const existing = sessions.getSessionByProviderSession(params.provider, params.providerSessionId);
  if (existing) {
    // 更新最近观察信息
    sessions.updateSession(existing.id, {
      lastObservedAt: Date.now(),
      lastObservedCwd: params.cwd,
    });
    return {
      sessionId: existing.id,
      channelId: existing.channelId,
      isNew: false,
    };
  }

  // 2. 用 cwd 归属到已挂载项目
  const project = projects.findProjectByCwd(params.cwd);
  if (!project) {
    console.warn(`[Session Discovery] No mounted project found for cwd: ${params.cwd}`);
    return null;
  }

  // 3. 查找或创建 Discord Category
  let category = client.channels.cache.get(project.categoryId) as CategoryChannel | undefined;
  if (!category) {
    console.warn(`[Session Discovery] Category not found: ${project.categoryId}`);
    return null;
  }

  // 4. 生成会话标签
  const timestamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
  const agentLabel = `${params.provider}-${timestamp}`;

  // 5. 创建 Discord 频道
  let channel: TextChannel;
  try {
    channel = await category.guild.channels.create({
      name: agentLabel,
      type: ChannelType.GuildText,
      parent: category.id,
      reason: `Auto-discovered ${params.provider} session from ${params.discoverySource}`,
    });
  } catch (err) {
    console.error(`[Session Discovery] Failed to create channel:`, err);
    return null;
  }

  // 6. 创建 ThreadSession
  const session = await sessions.createSession({
    channelId: channel.id,
    categoryId: category.id,
    projectName: project.name,
    agentLabel,
    provider: params.provider,
    providerSessionId: params.providerSessionId,
    type: 'persistent',
    directory: params.cwd,
    mode: 'auto',
  });

  // 7. 更新发现来源等字段
  sessions.updateSession(session.id, {
    discoverySource: params.discoverySource,
    lastObservedAt: Date.now(),
    lastObservedCwd: params.cwd,
    remoteHumanControl: false, // 非受管会话
  });

  console.log(
    `[Session Discovery] Registered new ${params.provider} session: ${session.id} (${channel.name})`,
  );

  return {
    sessionId: session.id,
    channelId: channel.id,
    isNew: true,
  };
}

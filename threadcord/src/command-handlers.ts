import {
  EmbedBuilder,
  ChannelType,
  ThreadAutoArchiveDuration,
  type ChatInputCommandInteraction,
  type TextChannel,
  type AnyThreadChannel,
} from 'discord.js';
import { config } from './config.ts';
import * as threadMgr from './thread-manager.ts';
import * as projectMgr from './project-manager.ts';
import { spawnSubagent, getSubagents } from './subagent-manager.ts';
import { executeSessionPrompt, executeSessionContinue } from './session-executor.ts';
import { makeModeButtons } from './output-handler.ts';
import { executeShellCommand, listProcesses, killProcess } from './shell-handler.ts';
import { isUserAllowed, resolvePath, formatUptime, formatRelative } from './utils.ts';
import type { ProviderName, SessionMode } from './types.ts';

let logFn: (msg: string) => void = console.log;
export function setLogger(fn: (msg: string) => void): void { logFn = fn; }
function log(msg: string): void { logFn(msg); }

const PROVIDER_LABELS: Record<ProviderName, string> = {
  claude: 'Claude Code',
  codex: 'OpenAI Codex',
};

const PROVIDER_COLORS: Record<ProviderName, number> = {
  claude: 0x3498db,
  codex: 0x10a37f,
};

const MODE_LABELS: Record<SessionMode, string> = {
  auto: '⚡ Auto — full autonomy',
  plan: '📋 Plan — plans before changes',
  normal: '🛡️ Normal — asks before destructive ops',
  monitor: '🧠 Monitor — steers until complete',
};

function assertUserAllowed(interaction: ChatInputCommandInteraction): boolean {
  if (!isUserAllowed(interaction.user.id, config.allowedUsers, config.allowAllUsers)) {
    interaction.reply({ content: 'You are not authorized to use this bot.', ephemeral: true });
    return false;
  }
  return true;
}

function resolveProjectChannelId(interaction: ChatInputCommandInteraction): string {
  if (interaction.channel?.isThread()) {
    return (interaction.channel as AnyThreadChannel).parentId ?? interaction.channelId;
  }
  return interaction.channelId;
}

// ── /project ──────────────────────────────────────────────────────────────────

export async function handleProject(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!assertUserAllowed(interaction)) return;
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'setup': return handleProjectSetup(interaction);
    case 'info': return handleProjectInfo(interaction);
    case 'personality': return handleProjectPersonality(interaction);
    case 'personality-clear': return handleProjectPersonalityClear(interaction);
    case 'skill-add': return handleProjectSkillAdd(interaction);
    case 'skill-remove': return handleProjectSkillRemove(interaction);
    case 'skill-list': return handleProjectSkillList(interaction);
    case 'skill-run': return handleProjectSkillRun(interaction);
    case 'mcp-add': return handleProjectMcpAdd(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleProjectSetup(interaction: ChatInputCommandInteraction): Promise<void> {
  // Must be in a plain text channel, not a thread
  if (interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run `/project setup` in a project channel, not inside a thread.', ephemeral: true });
    return;
  }

  const directory = interaction.options.getString('directory') || config.defaultDirectory;
  const resolvedDir = resolvePath(directory);
  const channelId = interaction.channelId;
  const channelName = (interaction.channel as TextChannel)?.name || 'unknown';

  await interaction.deferReply();

  const project = projectMgr.getOrCreateProject(channelId, channelName, resolvedDir);

  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`✅ Project Ready: ${project.name}`)
    .addFields(
      { name: 'Channel', value: `<#${channelId}>`, inline: true },
      { name: 'Directory', value: `\`${resolvedDir}\``, inline: true },
    )
    .setDescription('Use `/agent spawn` to create an agent thread in this channel.');

  await interaction.editReply({ embeds: [embed] });
  log(`Project "${project.name}" set up by ${interaction.user.tag}`);
}

async function handleProjectInfo(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = resolveProjectChannelId(interaction);
  const project = projectMgr.getProject(channelId);
  if (!project) {
    await interaction.reply({ content: 'This channel is not set up as a project. Run `/project setup` first.', ephemeral: true });
    return;
  }

  const sessions = threadMgr.getSessionsByChannel(channelId);
  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`📁 Project: ${project.name}`)
    .addFields(
      { name: 'Directory', value: `\`${project.directory}\``, inline: false },
      { name: 'Active Threads', value: `${sessions.length}`, inline: true },
      { name: 'Skills', value: `${project.skills.length}`, inline: true },
      { name: 'MCP Servers', value: `${project.mcpServers.length}`, inline: true },
    );

  if (project.personality) {
    embed.addFields({ name: 'Personality', value: `\`\`\`\n${project.personality.slice(0, 500)}\n\`\`\`` });
  }

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleProjectPersonality(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = resolveProjectChannelId(interaction);
  const project = projectMgr.getProject(channelId);
  if (!project) {
    await interaction.reply({ content: 'Run `/project setup` first.', ephemeral: true });
    return;
  }
  const prompt = interaction.options.getString('prompt', true);
  projectMgr.setPersonality(channelId, prompt);
  await interaction.reply({ content: `Personality set for project **${project.name}**.`, ephemeral: true });
}

async function handleProjectPersonalityClear(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = resolveProjectChannelId(interaction);
  projectMgr.clearPersonality(channelId);
  await interaction.reply({ content: 'Personality cleared.', ephemeral: true });
}

async function handleProjectSkillAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = resolveProjectChannelId(interaction);
  const project = projectMgr.getProject(channelId);
  if (!project) {
    await interaction.reply({ content: 'Run `/project setup` first.', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const prompt = interaction.options.getString('prompt', true);
  projectMgr.addSkill(channelId, name, prompt);
  await interaction.reply({ content: `Skill **${name}** added.`, ephemeral: true });
}

async function handleProjectSkillRemove(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = resolveProjectChannelId(interaction);
  const name = interaction.options.getString('name', true);
  const removed = projectMgr.removeSkill(channelId, name);
  await interaction.reply({ content: removed ? `Skill **${name}** removed.` : `Skill **${name}** not found.`, ephemeral: true });
}

async function handleProjectSkillList(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = resolveProjectChannelId(interaction);
  const skills = projectMgr.getSkills(channelId);
  if (skills.length === 0) {
    await interaction.reply({ content: 'No skills defined. Use `/project skill-add`.', ephemeral: true });
    return;
  }
  const lines = skills.map(s => `**${s.name}**: ${s.prompt.slice(0, 80)}${s.prompt.length > 80 ? '…' : ''}`).join('\n');
  await interaction.reply({ content: `Skills:\n${lines}`, ephemeral: true });
}

async function handleProjectSkillRun(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = resolveProjectChannelId(interaction);
  const name = interaction.options.getString('name', true);
  const input = interaction.options.getString('input') || undefined;
  const prompt = projectMgr.executeSkill(channelId, name, input);
  if (!prompt) {
    await interaction.reply({ content: `Skill **${name}** not found.`, ephemeral: true });
    return;
  }

  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run this command inside an agent thread.', ephemeral: true });
    return;
  }

  const thread = interaction.channel as AnyThreadChannel;
  const session = threadMgr.getSessionByThread(thread.id);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  await interaction.editReply(`Running skill **${name}**...`);
  await executeSessionPrompt(session, thread, prompt);
}

async function handleProjectMcpAdd(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = resolveProjectChannelId(interaction);
  const project = projectMgr.getProject(channelId);
  if (!project) {
    await interaction.reply({ content: 'Run `/project setup` first.', ephemeral: true });
    return;
  }
  const name = interaction.options.getString('name', true);
  const command = interaction.options.getString('command', true);
  projectMgr.addMcpServer(channelId, name, command);
  await interaction.reply({ content: `MCP server **${name}** added.`, ephemeral: true });
}

// ── /agent ────────────────────────────────────────────────────────────────────

export async function handleAgent(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!assertUserAllowed(interaction)) return;
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'spawn': return handleAgentSpawn(interaction);
    case 'list': return handleAgentList(interaction);
    case 'stop': return handleAgentStop(interaction);
    case 'end': return handleAgentEnd(interaction);
    case 'mode': return handleAgentMode(interaction);
    case 'goal': return handleAgentGoal(interaction);
    case 'persona': return handleAgentPersona(interaction);
    case 'verbose': return handleAgentVerbose(interaction);
    case 'model': return handleAgentModel(interaction);
    case 'continue': return handleAgentContinue(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleAgentSpawn(interaction: ChatInputCommandInteraction): Promise<void> {
  // Must be in a project channel (not inside a thread)
  if (interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run `/agent spawn` in the project channel, not inside a thread.', ephemeral: true });
    return;
  }

  const channelId = interaction.channelId;
  const project = projectMgr.getProject(channelId);
  if (!project) {
    await interaction.reply({ content: 'This channel is not set up as a project. Run `/project setup` first.', ephemeral: true });
    return;
  }

  const label = interaction.options.getString('label', true);
  const provider = (interaction.options.getString('provider') || config.defaultProvider) as ProviderName;
  const mode = (interaction.options.getString('mode') || config.defaultMode) as SessionMode;
  const directory = interaction.options.getString('directory') || project.directory;

  await interaction.deferReply();

  const guild = interaction.guild!;
  const projectChannel = guild.channels.cache.get(channelId) as TextChannel;

  // Create Discord thread
  const threadName = `[${PROVIDER_LABELS[provider]}] ${label}`.slice(0, 100);
  const thread = await projectChannel.threads.create({
    name: threadName,
    type: ChannelType.PublicThread,
    autoArchiveDuration: ThreadAutoArchiveDuration.OneWeek,
    reason: `Agent session spawned by ${interaction.user.tag}`,
  });

  // Create session
  const session = await threadMgr.createSession({
    threadId: thread.id,
    channelId,
    projectName: project.name,
    agentLabel: label,
    provider,
    directory,
    type: 'persistent',
    mode,
  });

  if (mode !== 'auto') {
    threadMgr.setMode(session.id, mode);
  }

  // Send welcome embed into the thread
  const welcomeEmbed = new EmbedBuilder()
    .setColor(PROVIDER_COLORS[provider])
    .setTitle(`${PROVIDER_LABELS[provider]} Agent`)
    .setDescription('Type a message to start the agent. Use `/agent stop` to cancel generation.')
    .addFields(
      { name: 'Label', value: label, inline: true },
      { name: 'Mode', value: MODE_LABELS[mode], inline: false },
      { name: 'Directory', value: `\`${session.directory}\``, inline: false },
    );

  await thread.send({
    embeds: [welcomeEmbed],
    components: [makeModeButtons(session.id, mode)],
  });

  // Reply to original command
  const embed = new EmbedBuilder()
    .setColor(0x2ecc71)
    .setTitle(`✅ Agent Created: ${label}`)
    .addFields(
      { name: 'Thread', value: `<#${thread.id}>`, inline: true },
      { name: 'Provider', value: PROVIDER_LABELS[provider], inline: true },
      { name: 'Mode', value: MODE_LABELS[mode], inline: false },
      { name: 'Directory', value: `\`${session.directory}\``, inline: false },
    );

  await interaction.editReply({ embeds: [embed] });
  log(`Agent "${label}" (${provider}) spawned by ${interaction.user.tag} in channel ${channelId}`);
}

async function handleAgentList(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = resolveProjectChannelId(interaction);
  const sessions = threadMgr.getSessionsByChannel(channelId);

  if (sessions.length === 0) {
    await interaction.reply({ content: 'No active agent threads in this project.', ephemeral: true });
    return;
  }

  const lines = sessions.map(s => {
    const status = s.isGenerating ? '🔄 Generating' : '💤 Idle';
    const typeLabel = s.type === 'subagent' ? '[sub] ' : '';
    return `${status} | \`${typeLabel}${s.agentLabel}\` | ${s.provider} | <#${s.threadId}> | ${formatRelative(s.lastActivity)}`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Agent Threads (${sessions.length})`)
    .setDescription(lines.join('\n'));

  await interaction.reply({ embeds: [embed], ephemeral: true });
}

async function handleAgentStop(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run this inside an agent thread.', ephemeral: true });
    return;
  }
  const session = threadMgr.getSessionByThread(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }
  const stopped = threadMgr.abortSession(session.id);
  await interaction.reply({ content: stopped ? 'Generation stopped.' : 'Agent was not generating.', ephemeral: true });
}

async function handleAgentEnd(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run this inside an agent thread.', ephemeral: true });
    return;
  }
  const thread = interaction.channel as AnyThreadChannel;
  const session = threadMgr.getSessionByThread(thread.id);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  await interaction.deferReply();
  await threadMgr.endSession(session.id);

  try {
    await thread.setArchived(true, `Ended by ${interaction.user.tag}`);
  } catch { /* best effort */ }

  await interaction.editReply('Agent session ended and thread archived.');
  log(`Session "${session.id}" ended by ${interaction.user.tag}`);
}

async function handleAgentMode(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run this inside an agent thread.', ephemeral: true });
    return;
  }
  const session = threadMgr.getSessionByThread(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }
  const mode = interaction.options.getString('mode', true) as SessionMode;
  threadMgr.setMode(session.id, mode);
  await interaction.reply({ content: `Mode set to **${MODE_LABELS[mode]}**.`, ephemeral: true });
}

async function handleAgentGoal(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run this inside an agent thread.', ephemeral: true });
    return;
  }
  const session = threadMgr.getSessionByThread(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }
  const goal = interaction.options.getString('goal', true);
  threadMgr.setMonitorGoal(session.id, goal);
  await interaction.reply({ content: `Monitor goal set: *${goal}*`, ephemeral: true });
}

async function handleAgentPersona(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run this inside an agent thread.', ephemeral: true });
    return;
  }
  const session = threadMgr.getSessionByThread(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }
  const persona = interaction.options.getString('name') || undefined;
  threadMgr.setAgentPersona(session.id, persona === 'general' ? undefined : persona);
  await interaction.reply({ content: `Persona set to **${persona || 'general'}**.`, ephemeral: true });
}

async function handleAgentVerbose(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run this inside an agent thread.', ephemeral: true });
    return;
  }
  const session = threadMgr.getSessionByThread(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }
  const newVerbose = !session.verbose;
  threadMgr.setVerbose(session.id, newVerbose);
  await interaction.reply({ content: `Verbose mode ${newVerbose ? 'enabled' : 'disabled'}.`, ephemeral: true });
}

async function handleAgentModel(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run this inside an agent thread.', ephemeral: true });
    return;
  }
  const session = threadMgr.getSessionByThread(interaction.channelId);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }
  const model = interaction.options.getString('model', true);
  threadMgr.setModel(session.id, model);
  await interaction.reply({ content: `Model set to \`${model}\`.`, ephemeral: true });
}

async function handleAgentContinue(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run this inside an agent thread.', ephemeral: true });
    return;
  }
  const thread = interaction.channel as AnyThreadChannel;
  const session = threadMgr.getSessionByThread(thread.id);
  if (!session) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }
  if (session.isGenerating) {
    await interaction.reply({ content: 'Agent is already generating.', ephemeral: true });
    return;
  }
  await interaction.deferReply();
  await interaction.editReply('Continuing...');
  await executeSessionContinue(session, thread);
}

// ── /subagent ─────────────────────────────────────────────────────────────────

export async function handleSubagent(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!assertUserAllowed(interaction)) return;
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'run': return handleSubagentRun(interaction);
    case 'list': return handleSubagentList(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleSubagentRun(interaction: ChatInputCommandInteraction): Promise<void> {
  // Must be inside an agent thread
  if (!interaction.channel?.isThread()) {
    await interaction.reply({ content: 'Run `/subagent run` inside an agent thread.', ephemeral: true });
    return;
  }
  const thread = interaction.channel as AnyThreadChannel;
  const parentSession = threadMgr.getSessionByThread(thread.id);
  if (!parentSession) {
    await interaction.reply({ content: 'No session found for this thread.', ephemeral: true });
    return;
  }

  const label = interaction.options.getString('label', true);
  const provider = (interaction.options.getString('provider') || parentSession.provider) as ProviderName;

  await interaction.deferReply();

  const guild = interaction.guild!;
  const projectChannel = guild.channels.cache.get(parentSession.channelId) as TextChannel;
  if (!projectChannel) {
    await interaction.editReply('Could not find project channel.');
    return;
  }

  try {
    const subSession = await spawnSubagent(parentSession, label, provider, projectChannel);
    const embed = new EmbedBuilder()
      .setColor(0xf39c12)
      .setTitle(`🤖 Subagent Spawned: ${label}`)
      .addFields(
        { name: 'Thread', value: `<#${subSession.threadId}>`, inline: true },
        { name: 'Provider', value: PROVIDER_LABELS[provider], inline: true },
        { name: 'Depth', value: `${subSession.subagentDepth}`, inline: true },
      );
    await interaction.editReply({ embeds: [embed] });
    log(`Subagent "${label}" spawned by ${interaction.user.tag}`);
  } catch (err: unknown) {
    await interaction.editReply(`Failed to spawn subagent: ${(err as Error).message}`);
  }
}

async function handleSubagentList(interaction: ChatInputCommandInteraction): Promise<void> {
  const channelId = resolveProjectChannelId(interaction);
  const allSessions = threadMgr.getSessionsByChannel(channelId);
  const subagents = allSessions.filter(s => s.type === 'subagent');

  if (subagents.length === 0) {
    await interaction.reply({ content: 'No active subagents in this channel.', ephemeral: true });
    return;
  }

  const lines = subagents.map(s => {
    const status = s.isGenerating ? '🔄' : '💤';
    return `${status} \`${s.agentLabel}\` | <#${s.threadId}> | depth: ${s.subagentDepth}`;
  });

  await interaction.reply({ content: `Active subagents:\n${lines.join('\n')}`, ephemeral: true });
}

// ── /shell ────────────────────────────────────────────────────────────────────

export async function handleShell(interaction: ChatInputCommandInteraction): Promise<void> {
  if (!assertUserAllowed(interaction)) return;
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'run': return handleShellRun(interaction);
    case 'processes': return handleShellProcesses(interaction);
    case 'kill': return handleShellKill(interaction);
    default:
      await interaction.reply({ content: `Unknown subcommand: ${sub}`, ephemeral: true });
  }
}

async function handleShellRun(interaction: ChatInputCommandInteraction): Promise<void> {
  const command = interaction.options.getString('command', true);

  // Resolve the working directory from thread session or project
  const channelId = resolveProjectChannelId(interaction);
  let cwd = config.defaultDirectory;

  if (interaction.channel?.isThread()) {
    const session = threadMgr.getSessionByThread(interaction.channelId);
    if (session) cwd = session.directory;
  } else {
    const project = projectMgr.getProject(channelId);
    if (project) cwd = project.directory;
  }

  await interaction.deferReply();
  await interaction.editReply(`Running: \`${command}\``);

  const thread = interaction.channel as AnyThreadChannel;
  await executeShellCommand(command, cwd, thread);
}

async function handleShellProcesses(interaction: ChatInputCommandInteraction): Promise<void> {
  const procs = listProcesses();
  if (procs.length === 0) {
    await interaction.reply({ content: 'No running shell processes.', ephemeral: true });
    return;
  }
  const lines = procs.map(p => `**PID ${p.pid}** — \`${p.command}\` (${formatUptime(p.startedAt)})`);
  await interaction.reply({ content: `Running processes:\n${lines.join('\n')}`, ephemeral: true });
}

async function handleShellKill(interaction: ChatInputCommandInteraction): Promise<void> {
  const pid = interaction.options.getInteger('pid', true);
  const killed = killProcess(pid);
  await interaction.reply({ content: killed ? `Process ${pid} killed.` : `Process ${pid} not found.`, ephemeral: true });
}

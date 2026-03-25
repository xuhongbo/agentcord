import { REST, Routes, SlashCommandBuilder } from 'discord.js';
import { config } from './config.ts';

const commands = [
  // ── /project ──────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('project')
    .setDescription('Manage project channel configuration')
    .addSubcommand(sub => sub
      .setName('setup')
      .setDescription('Register this channel as a project')
      .addStringOption(opt => opt
        .setName('directory')
        .setDescription('Working directory on host (default: DEFAULT_DIRECTORY)')
        .setRequired(false)))
    .addSubcommand(sub => sub
      .setName('info')
      .setDescription('Show project info for this channel'))
    .addSubcommand(sub => sub
      .setName('personality')
      .setDescription('Set shared personality for all agents in this project')
      .addStringOption(opt => opt
        .setName('prompt')
        .setDescription('System prompt to apply to all agents')
        .setRequired(true)))
    .addSubcommand(sub => sub
      .setName('personality-clear')
      .setDescription('Remove the shared personality'))
    .addSubcommand(sub => sub
      .setName('skill-add')
      .setDescription('Add a reusable skill prompt')
      .addStringOption(opt => opt.setName('name').setDescription('Skill name').setRequired(true))
      .addStringOption(opt => opt.setName('prompt').setDescription('Skill prompt (use {input} as placeholder)').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('skill-remove')
      .setDescription('Remove a skill')
      .addStringOption(opt => opt.setName('name').setDescription('Skill name').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('skill-list')
      .setDescription('List all skills for this project'))
    .addSubcommand(sub => sub
      .setName('skill-run')
      .setDescription('Run a skill prompt')
      .addStringOption(opt => opt.setName('name').setDescription('Skill name').setRequired(true))
      .addStringOption(opt => opt.setName('input').setDescription('Input to substitute into {input}').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('mcp-add')
      .setDescription('Register an MCP server for this project')
      .addStringOption(opt => opt.setName('name').setDescription('Server name').setRequired(true))
      .addStringOption(opt => opt.setName('command').setDescription('Command to run the MCP server').setRequired(true))),

  // ── /agent ────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('agent')
    .setDescription('Manage AI agent threads')
    .addSubcommand(sub => sub
      .setName('spawn')
      .setDescription('Create a new agent thread in this project channel')
      .addStringOption(opt => opt.setName('label').setDescription('Thread label (e.g. fix-login-bug)').setRequired(true))
      .addStringOption(opt => opt
        .setName('provider')
        .setDescription('AI provider')
        .setRequired(false)
        .addChoices(
          { name: 'Claude (default)', value: 'claude' },
          { name: 'Codex', value: 'codex' },
        ))
      .addStringOption(opt => opt
        .setName('mode')
        .setDescription('Execution mode')
        .setRequired(false)
        .addChoices(
          { name: '⚡ Auto — full autonomy', value: 'auto' },
          { name: '📋 Plan — plan before changes', value: 'plan' },
          { name: '🛡️ Normal — ask before destructive ops', value: 'normal' },
          { name: '🧠 Monitor — steer until complete', value: 'monitor' },
        ))
      .addStringOption(opt => opt.setName('directory').setDescription('Override working directory').setRequired(false)))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List all agent threads in this project channel'))
    .addSubcommand(sub => sub
      .setName('stop')
      .setDescription('Stop generation in the current thread'))
    .addSubcommand(sub => sub
      .setName('end')
      .setDescription('End and archive the current agent thread'))
    .addSubcommand(sub => sub
      .setName('mode')
      .setDescription('Switch execution mode for the current thread')
      .addStringOption(opt => opt
        .setName('mode')
        .setDescription('New mode')
        .setRequired(true)
        .addChoices(
          { name: '⚡ Auto', value: 'auto' },
          { name: '📋 Plan', value: 'plan' },
          { name: '🛡️ Normal', value: 'normal' },
          { name: '🧠 Monitor', value: 'monitor' },
        )))
    .addSubcommand(sub => sub
      .setName('goal')
      .setDescription('Set monitor goal for the current thread')
      .addStringOption(opt => opt.setName('goal').setDescription('Goal description').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('persona')
      .setDescription('Set agent persona for the current thread')
      .addStringOption(opt => opt
        .setName('name')
        .setDescription('Persona name')
        .setRequired(false)
        .addChoices(
          { name: '🔍 Code Reviewer', value: 'code-reviewer' },
          { name: '🏗️ Architect', value: 'architect' },
          { name: '🐛 Debugger', value: 'debugger' },
          { name: '🔒 Security', value: 'security' },
          { name: '🚀 Performance', value: 'performance' },
          { name: '⚙️ DevOps', value: 'devops' },
          { name: '🧠 General (default)', value: 'general' },
        )))
    .addSubcommand(sub => sub
      .setName('verbose')
      .setDescription('Toggle verbose mode (show tool calls) in the current thread'))
    .addSubcommand(sub => sub
      .setName('model')
      .setDescription('Set model override for the current thread')
      .addStringOption(opt => opt.setName('model').setDescription('Model name (e.g. claude-sonnet-4-6)').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('continue')
      .setDescription('Continue generation in the current thread')),

  // ── /subagent ─────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('subagent')
    .setDescription('Manage ephemeral subagent threads')
    .addSubcommand(sub => sub
      .setName('run')
      .setDescription('Spawn an ephemeral subagent thread')
      .addStringOption(opt => opt.setName('label').setDescription('Subagent label').setRequired(true))
      .addStringOption(opt => opt
        .setName('provider')
        .setDescription('AI provider')
        .setRequired(false)
        .addChoices(
          { name: 'Claude (default)', value: 'claude' },
          { name: 'Codex', value: 'codex' },
        )))
    .addSubcommand(sub => sub
      .setName('list')
      .setDescription('List active subagent threads in this channel')),

  // ── /shell ────────────────────────────────────────────────────────
  new SlashCommandBuilder()
    .setName('shell')
    .setDescription('Run shell commands in the project directory')
    .addSubcommand(sub => sub
      .setName('run')
      .setDescription('Execute a shell command')
      .addStringOption(opt => opt.setName('command').setDescription('Command to run').setRequired(true)))
    .addSubcommand(sub => sub
      .setName('processes')
      .setDescription('List running shell processes'))
    .addSubcommand(sub => sub
      .setName('kill')
      .setDescription('Kill a running process')
      .addIntegerOption(opt => opt.setName('pid').setDescription('Process ID').setRequired(true))),
];

export async function registerCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const body = commands.map(c => c.toJSON());

  if (config.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body },
    );
    console.log(`[commands] Registered ${body.length} guild commands`);
  } else {
    await rest.put(
      Routes.applicationCommands(config.clientId),
      { body },
    );
    console.log(`[commands] Registered ${body.length} global commands`);
  }
}

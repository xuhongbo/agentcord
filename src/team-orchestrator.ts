import {
  EmbedBuilder,
  ChannelType,
  type Guild,
  type TextChannel,
} from 'discord.js';
import { Store } from './persistence.ts';
import * as sessions from './session-manager.ts';
import * as agentMgr from './agent-manager.ts';
import { streamAgentResponse } from './agent-router.ts';
import { ensureProjectCategory } from './command-handlers.ts';
import { getProjectByName } from './project-registry.ts';
import { sanitizeSessionName } from './utils.ts';
import type { AgentData } from './types.ts';
import type {
  TeamTask,
  TeamTaskPersistData,
  TaskPlan,
  TaskPhase,
  PhaseAssignment,
  TeamAgent,
} from './team-types.ts';

// ── Persistence ──

const taskStore = new Store<Record<string, TeamTaskPersistData>>('team-tasks.json');
const taskMap = new Map<string, TeamTask>();
const channelToTask = new Map<string, string>(); // channelId → taskId

// Check if a task was cancelled externally (phase mutated by cancelTeamTask)
function isCancelled(task: TeamTask): boolean {
  return task.phase === 'failed';
}

export async function loadTeamTasks(): Promise<void> {
  const data = await taskStore.read();
  if (!data) return;
  for (const [id, task] of Object.entries(data)) {
    taskMap.set(id, task);
    if (task.channelId) channelToTask.set(task.channelId, id);
  }
  console.log(`Restored ${taskMap.size} team task(s)`);
}

async function saveTasks(): Promise<void> {
  const data: Record<string, TeamTaskPersistData> = {};
  for (const [id, task] of taskMap) {
    data[id] = {
      id: task.id,
      description: task.description,
      projectName: task.projectName,
      directory: task.directory,
      channelId: task.channelId,
      managerSessionId: task.managerSessionId,
      phase: task.phase,
      plan: task.plan,
      agents: task.agents,
      createdAt: task.createdAt,
      createdBy: task.createdBy,
      completedAt: task.completedAt,
    };
  }
  await taskStore.write(data);
}

// ── Queries ──

export function getTeamTask(id: string): TeamTask | undefined {
  return taskMap.get(id);
}

export function getTeamTaskByChannel(channelId: string): TeamTask | undefined {
  const id = channelToTask.get(channelId);
  return id ? taskMap.get(id) : undefined;
}

export function getAllTeamTasks(): TeamTask[] {
  return Array.from(taskMap.values());
}

// ── Manager system prompt ──

const MANAGER_SYSTEM_PROMPT = `You are an engineering manager orchestrating a team of AI coding agents.

Your job:
1. Analyze the user's feature request
2. Explore the codebase to understand the project structure and existing patterns
3. Design a team plan that breaks the work into sequential phases (Design, Implement, Test)
4. For each phase, specify what specialist role is needed and what they should do

Output your plan in this EXACT format (after your analysis):

===TEAM_PLAN===
{
  "summary": "Brief description of the approach",
  "phases": [
    {
      "name": "Design",
      "assignments": [
        { "role": "Software Architect", "description": "Detailed instructions for what to design..." }
      ]
    },
    {
      "name": "Implement",
      "assignments": [
        { "role": "Frontend Developer", "description": "Detailed instructions for what to build..." }
      ]
    },
    {
      "name": "Test",
      "assignments": [
        { "role": "QA Engineer", "description": "Detailed instructions for what to test..." }
      ]
    }
  ]
}
===END_PLAN===

Guidelines:
- Explore the codebase FIRST using your tools (Read, Grep, Glob) before writing the plan
- Be specific in assignment descriptions — reference actual files, patterns, and conventions from the codebase
- Use 2-4 phases. Common patterns: Design→Implement→Test, or Plan→Implement→Review
- Each phase can have 1-3 assignments (roles working in that phase)
- Use clear role names: "Software Architect", "Backend Developer", "Frontend Developer", "QA Engineer", "DevOps Engineer", etc.
- The plan JSON must be valid JSON between the markers`;

export function getManagerSystemPrompt(_taskId: string): string {
  return MANAGER_SYSTEM_PROMPT;
}

// ── Orchestration ──

function slugifyTask(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

export async function startTeamTask(
  description: string,
  projectName: string,
  directory: string,
  guild: Guild,
  createdBy: string,
): Promise<TeamTask> {
  const taskId = `team-${slugifyTask(description)}-${Date.now().toString(36)}`;

  // [1] Create channel under project category
  const project = getProjectByName(projectName);
  if (!project) throw new Error(`Project not found: ${projectName}`);
  const { category } = await ensureProjectCategory(guild, project);
  const channel = await guild.channels.create({
    name: `team-${slugifyTask(description)}`.slice(0, 100),
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `Team task: ${description}`,
  }) as TextChannel;

  // Create task record
  const task: TeamTask = {
    id: taskId,
    description,
    projectName,
    directory,
    channelId: channel.id,
    managerSessionId: '',
    phase: 'planning',
    plan: null,
    agents: [],
    createdAt: Date.now(),
    createdBy,
  };
  taskMap.set(taskId, task);
  channelToTask.set(channel.id, taskId);
  await saveTasks();

  // [2] Post "Task started" embed
  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x9b59b6)
        .setTitle('Team Task Started')
        .setDescription(description)
        .addFields(
          { name: 'Project', value: projectName, inline: true },
          { name: 'Directory', value: `\`${directory}\``, inline: true },
          { name: 'Phase', value: 'Planning...', inline: true },
        ),
    ],
  });

  // Run orchestration in background (don't await)
  runOrchestration(task, channel).catch(async (err) => {
    console.error(`Team task "${taskId}" failed:`, err);
    task.phase = 'failed';
    await saveTasks();
    try {
      await channel.send(`Team task failed: ${(err as Error).message}`);
    } catch { /* channel may be gone */ }
  });

  return task;
}

async function runOrchestration(task: TeamTask, channel: TextChannel): Promise<void> {
  // [3] Create manager session
  const syntheticChannelId = `manager:${task.id}`;
  const managerSession = await sessions.createSession(
    `manager-${task.id.slice(0, 30)}`,
    task.directory,
    syntheticChannelId,
    task.projectName,
    'claude',
  );
  task.managerSessionId = managerSession.id;
  sessions.setAgentPersona(managerSession.id, `manager:${task.id}`);
  await saveTasks();

  // [4] Send planning prompt to manager
  const existingAgents = agentMgr.getAllAgents();
  const agentList = existingAgents.length > 0
    ? existingAgents.map(a => `- ${a.name}: ${a.role} (${a.provider})`).join('\n')
    : '(none)';

  const planningPrompt = `Analyze this feature request and create a team plan.

**Feature request:** ${task.description}

**Working directory:** ${task.directory}
**Project:** ${task.projectName}

**Existing agents available for reuse:**
${agentList}

Please explore the codebase first, then output your team plan using the ===TEAM_PLAN=== format.`;

  await channel.send('*Manager is analyzing the codebase and creating a plan...*');

  let managerResponse = '';
  const stream = sessions.sendPrompt(managerSession.id, planningPrompt);
  for await (const event of stream) {
    if (event.type === 'text_delta') {
      managerResponse += event.text;
    }
  }

  // [5–6] Parse plan
  const plan = parsePlan(managerResponse);
  if (!plan) {
    task.phase = 'failed';
    await saveTasks();
    await channel.send('Failed to parse team plan from manager response. Raw output:\n' +
      managerResponse.slice(0, 1900));
    return;
  }

  task.plan = plan;
  task.phase = 'executing';
  await saveTasks();

  // Post plan embed
  const phasesSummary = plan.phases
    .map((p, i) => {
      const assignments = p.assignments
        .map(a => `  \u2022 **${a.role}**: ${a.description.slice(0, 100)}`)
        .join('\n');
      return `**${i + 1}. ${p.name}**\n${assignments}`;
    })
    .join('\n\n');

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x3498db)
        .setTitle('Team Plan')
        .setDescription(plan.summary)
        .addFields({ name: 'Phases', value: phasesSummary.slice(0, 1024) }),
    ],
  });

  // [7] Assemble team
  const roleToAgent = new Map<string, AgentData>();
  const teamAgents: TeamAgent[] = [];

  for (const phase of plan.phases) {
    for (const assignment of phase.assignments) {
      if (roleToAgent.has(assignment.role)) continue;

      let agent = agentMgr.findAgentByRole(assignment.role);
      const reused = !!agent;
      if (!agent) {
        const name = agentMgr.generateFlowerName();
        agent = await agentMgr.createAgent(name, assignment.role, 'claude', 'system');
      }
      roleToAgent.set(assignment.role, agent);
      teamAgents.push({ agentId: agent.id, role: assignment.role, reused });
    }
  }
  task.agents = teamAgents;
  await saveTasks();

  // Post team assembly embed
  const teamLines = teamAgents.map(ta => {
    const agent = agentMgr.getAgentById(ta.agentId);
    const name = agent?.name || ta.agentId;
    const tag = ta.reused ? '(reused)' : '(new)';
    return `\u2022 **${name}** \u2014 ${ta.role} ${tag}`;
  });

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('Team Assembled')
        .setDescription(teamLines.join('\n')),
    ],
  });

  // [8] Execute phases sequentially
  const previousResults: string[] = [];

  for (const phase of plan.phases) {
    // Check if task was cancelled (may be mutated externally by cancelTeamTask)
    if (isCancelled(task)) return;

    phase.status = 'in_progress';
    await saveTasks();

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xf39c12)
          .setTitle(`Phase: ${phase.name}`)
          .setDescription(`Starting ${phase.assignments.length} assignment(s)...`),
      ],
    });

    for (const assignment of phase.assignments) {
      if (isCancelled(task)) return;

      assignment.status = 'in_progress';
      const agent = roleToAgent.get(assignment.role);
      if (!agent) continue;

      assignment.agentName = agent.name;

      // Get or create agent session in this channel
      const sessionId = await agentMgr.getOrCreateSession(
        agent, channel.id, task.directory, task.projectName,
      );

      // Build contextual prompt
      const contextParts: string[] = [
        `**Task:** ${task.description}`,
        `**Phase:** ${phase.name}`,
        `**Your assignment:** ${assignment.description}`,
      ];
      if (previousResults.length > 0) {
        contextParts.push(
          '\n**Context from previous phases:**',
          ...previousResults.map((r, i) => `--- Result ${i + 1} ---\n${r.slice(0, 3000)}`),
        );
      }

      const prompt = contextParts.join('\n\n');

      // Stream agent response via webhook
      try {
        const responseText = await streamAgentResponse(agent, channel, sessionId, prompt);
        assignment.result = responseText;
        assignment.status = 'completed';
        previousResults.push(`[${agent.name} / ${assignment.role}]\n${responseText}`);
      } catch (err) {
        assignment.status = 'completed';
        assignment.result = `Error: ${(err as Error).message}`;
        previousResults.push(`[${agent.name} / ${assignment.role}] Error: ${(err as Error).message}`);
      }

      await saveTasks();
    }

    phase.status = 'completed';
    await saveTasks();
  }

  // [9] Manager review
  task.phase = 'reviewing';
  await saveTasks();

  await channel.send('*Manager is reviewing all results...*');

  const reviewPrompt = `All phases are complete. Here are the results from each agent:

${previousResults.join('\n\n---\n\n')}

Please provide a brief final summary: what was accomplished, any issues found, and next steps if any.`;

  let reviewResponse = '';
  try {
    const reviewStream = sessions.sendPrompt(managerSession.id, reviewPrompt);
    for await (const event of reviewStream) {
      if (event.type === 'text_delta') {
        reviewResponse += event.text;
      }
    }
  } catch {
    reviewResponse = 'Manager review unavailable.';
  }

  // Post review
  if (reviewResponse) {
    const chunks = reviewResponse.match(/[\s\S]{1,1900}/g) || [];
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
  }

  // [10] Complete
  task.phase = 'completed';
  task.completedAt = Date.now();
  await saveTasks();

  await channel.send({
    embeds: [
      new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle('Team Task Completed')
        .setDescription(`${task.description}\n\nUse \`/team cancel\` to clean up this channel when you're done reviewing.`),
    ],
  });
}

// ── Plan parsing ──

function parsePlan(response: string): TaskPlan | null {
  const startMarker = '===TEAM_PLAN===';
  const endMarker = '===END_PLAN===';

  const startIdx = response.indexOf(startMarker);
  const endIdx = response.indexOf(endMarker);

  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;

  const jsonStr = response.slice(startIdx + startMarker.length, endIdx).trim();

  try {
    const raw = JSON.parse(jsonStr) as {
      summary?: string;
      phases?: Array<{
        name?: string;
        assignments?: Array<{ role?: string; description?: string }>;
      }>;
    };

    if (!raw.summary || !Array.isArray(raw.phases) || raw.phases.length === 0) return null;

    const phases: TaskPhase[] = raw.phases.map(p => ({
      name: p.name || 'Unnamed Phase',
      status: 'pending' as const,
      assignments: (p.assignments || []).map(a => ({
        role: a.role || 'Developer',
        description: a.description || '',
        status: 'pending' as const,
      })),
    }));

    return { summary: raw.summary, phases };
  } catch {
    return null;
  }
}

// ── Cleanup ──

export async function cleanupTeamTask(taskId: string, guild: Guild): Promise<void> {
  const task = taskMap.get(taskId);
  if (!task) return;

  // End manager session
  if (task.managerSessionId) {
    try { await sessions.endSession(task.managerSessionId); } catch { /* gone */ }
  }

  // End all agent sessions for this channel
  for (const ta of task.agents) {
    const agent = agentMgr.getAgentById(ta.agentId);
    if (!agent) continue;
    const sessionId = agent.channelSessions[task.channelId];
    if (sessionId) {
      try { await sessions.endSession(sessionId); } catch { /* gone */ }
      delete agent.channelSessions[task.channelId];
    }
    // Clean up webhooks for this channel
    if (agent.webhooks[task.channelId]) {
      delete agent.webhooks[task.channelId];
    }
  }

  // Delete the Discord channel
  try {
    const channel = guild.channels.cache.get(task.channelId);
    if (channel) await channel.delete();
  } catch { /* already gone */ }

  // Remove from maps
  channelToTask.delete(task.channelId);
  taskMap.delete(taskId);
  await saveTasks();
}

// ── Cancel ──

export async function cancelTeamTask(taskId: string, guild: Guild): Promise<boolean> {
  const task = taskMap.get(taskId);
  if (!task) return false;

  task.phase = 'failed';
  await saveTasks();

  // Abort manager session if generating
  if (task.managerSessionId) {
    sessions.abortSession(task.managerSessionId);
  }

  // Abort all agent sessions
  for (const ta of task.agents) {
    const agent = agentMgr.getAgentById(ta.agentId);
    if (!agent) continue;
    const sessionId = agent.channelSessions[task.channelId];
    if (sessionId) sessions.abortSession(sessionId);
  }

  // Brief delay then full cleanup
  setTimeout(() => cleanupTeamTask(taskId, guild).catch(() => {}), 5000);
  return true;
}

import { Store } from './persistence.ts';
import type { Project, Skill, McpServer } from './types.ts';

// Store shape: Record<categoryId, Project>
const projectStore = new Store<Record<string, Project>>('projects.json');

let projects: Record<string, Project> = {};

export async function loadProjects(): Promise<void> {
  projects = projectStore.read() || {};
}

function saveProjects(): void {
  projectStore.write(projects);
}

// ─── Core lookups ──────────────────────────────────────────────────────────────

export function getProject(categoryId: string): Project | undefined {
  return projects[categoryId];
}

export function getProjectByName(name: string): Project | undefined {
  return Object.values(projects).find(p => p.name === name);
}

export function getAllProjects(): Record<string, Project> {
  return { ...projects };
}

export function getOrCreateProject(categoryId: string, name: string, directory: string): Project {
  if (!projects[categoryId]) {
    projects[categoryId] = {
      categoryId,
      name,
      directory,
      skills: [],
      mcpServers: [],
      createdAt: Date.now(),
    };
    saveProjects();
  }
  return projects[categoryId];
}

// ─── History channel ───────────────────────────────────────────────────────────

export function setHistoryChannelId(categoryId: string, channelId: string): void {
  const project = projects[categoryId];
  if (!project) return;
  project.historyChannelId = channelId;
  saveProjects();
}

export function getHistoryChannelId(categoryId: string): string | undefined {
  return projects[categoryId]?.historyChannelId;
}

// ─── Personality ───────────────────────────────────────────────────────────────

export function setPersonality(categoryId: string, personality: string): void {
  const project = projects[categoryId];
  if (!project) return;
  project.personality = personality;
  saveProjects();
}

export function getPersonality(categoryId: string): string | undefined {
  return projects[categoryId]?.personality;
}

export function clearPersonality(categoryId: string): void {
  const project = projects[categoryId];
  if (!project) return;
  delete project.personality;
  saveProjects();
}

// ─── Skills ────────────────────────────────────────────────────────────────────

export function addSkill(categoryId: string, name: string, prompt: string): void {
  const project = projects[categoryId];
  if (!project) return;
  const existing = project.skills.findIndex(s => s.name === name);
  if (existing >= 0) {
    project.skills[existing] = { name, prompt };
  } else {
    project.skills.push({ name, prompt });
  }
  saveProjects();
}

export function removeSkill(categoryId: string, name: string): boolean {
  const project = projects[categoryId];
  if (!project) return false;
  const idx = project.skills.findIndex(s => s.name === name);
  if (idx < 0) return false;
  project.skills.splice(idx, 1);
  saveProjects();
  return true;
}

export function getSkills(categoryId: string): Skill[] {
  return projects[categoryId]?.skills || [];
}

export function executeSkill(categoryId: string, name: string, input?: string): string | null {
  const project = projects[categoryId];
  if (!project) return null;
  const skill = project.skills.find(s => s.name === name);
  if (!skill) return null;
  return input
    ? skill.prompt.replace(/\{input\}/g, input)
    : skill.prompt.replace(/\{input\}/g, '');
}

// ─── MCP Servers ───────────────────────────────────────────────────────────────

export function addMcpServer(categoryId: string, serverName: string, command: string, args?: string[]): void {
  const project = projects[categoryId];
  if (!project) return;
  const existing = project.mcpServers.findIndex(s => s.name === serverName);
  const server: McpServer = {
    name: serverName,
    command,
    ...(args?.length ? { args } : {}),
  };
  if (existing >= 0) {
    project.mcpServers[existing] = server;
  } else {
    project.mcpServers.push(server);
  }
  saveProjects();
}

export function removeMcpServer(categoryId: string, serverName: string): boolean {
  const project = projects[categoryId];
  if (!project) return false;
  const idx = project.mcpServers.findIndex(s => s.name === serverName);
  if (idx < 0) return false;
  project.mcpServers.splice(idx, 1);
  saveProjects();
  return true;
}

export function getMcpServers(categoryId: string): McpServer[] {
  return projects[categoryId]?.mcpServers || [];
}

// ─── System Prompt Parts ───────────────────────────────────────────────────────

/**
 * Returns an array of strings to pass to providers as systemPromptParts.
 * Includes personality if set, and descriptions for each configured MCP server.
 */
export function getSystemPromptParts(categoryId: string): string[] {
  const project = projects[categoryId];
  if (!project) return [];

  const parts: string[] = [];

  if (project.personality) {
    parts.push(project.personality);
  }

  for (const server of project.mcpServers) {
    const argStr = server.args?.length ? ` ${server.args.join(' ')}` : '';
    parts.push(
      `You have access to the MCP server "${server.name}" (${server.command}${argStr}).`,
    );
  }

  return parts;
}

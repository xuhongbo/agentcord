import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadRegistry,
  getProjectByName,
  getAllRegisteredProjects,
  getProjectByCategoryId as getRegisteredProjectByCategoryId,
  updateProjectDiscord,
  updateProject,
} from './project-registry.ts';
import type { Project, McpServer } from './types.ts';

export async function loadProjects(): Promise<void> {
  await loadRegistry();
}

function toLegacyProject(name: string): Project | undefined {
  const project = getProjectByName(name);
  if (!project || !project.discordCategoryId) return undefined;
  return {
    name: project.name,
    directory: project.path,
    categoryId: project.discordCategoryId,
    logChannelId: project.discordLogChannelId,
    personality: project.personality,
    skills: project.skills,
    mcpServers: project.mcpServers,
  };
}

export function getProject(name: string): Project | undefined {
  return toLegacyProject(name);
}

export function getAllProjects(): Record<string, Project> {
  const out: Record<string, Project> = {};
  for (const project of getAllRegisteredProjects()) {
    if (!project.discordCategoryId) continue;
    out[project.name] = {
      name: project.name,
      directory: project.path,
      categoryId: project.discordCategoryId,
      logChannelId: project.discordLogChannelId,
      personality: project.personality,
      skills: project.skills,
      mcpServers: project.mcpServers,
    };
  }
  return out;
}

export function getProjectByCategoryId(categoryId: string): Project | undefined {
  const project = getRegisteredProjectByCategoryId(categoryId);
  if (!project) return undefined;
  return {
    name: project.name,
    directory: project.path,
    categoryId: project.discordCategoryId ?? categoryId,
    logChannelId: project.discordLogChannelId,
    personality: project.personality,
    skills: project.skills,
    mcpServers: project.mcpServers,
  };
}

export function updateProjectCategory(name: string, categoryId: string, logChannelId?: string): void {
  void updateProjectDiscord(name, categoryId, logChannelId);
}

// Personality

export function setPersonality(projectName: string, prompt: string): boolean {
  const project = getProjectByName(projectName);
  if (!project) return false;
  project.personality = prompt;
  void updateProject(project);
  return true;
}

export function getPersonality(projectName: string): string | undefined {
  return getProjectByName(projectName)?.personality;
}

export function clearPersonality(projectName: string): boolean {
  const project = getProjectByName(projectName);
  if (!project) return false;
  delete project.personality;
  void updateProject(project);
  return true;
}

// Skills

export function addSkill(projectName: string, name: string, prompt: string): boolean {
  const project = getProjectByName(projectName);
  if (!project) return false;
  project.skills[name] = prompt;
  void updateProject(project);
  return true;
}

export function removeSkill(projectName: string, name: string): boolean {
  const project = getProjectByName(projectName);
  if (!project || !project.skills[name]) return false;
  delete project.skills[name];
  void updateProject(project);
  return true;
}

export function getSkills(projectName: string): Record<string, string> {
  return getProjectByName(projectName)?.skills || {};
}

export function executeSkill(projectName: string, skillName: string, input?: string): string | null {
  const project = getProjectByName(projectName);
  if (!project) return null;
  const template = project.skills[skillName];
  if (!template) return null;
  return input ? template.replace(/\{input\}/g, input) : template.replace(/\{input\}/g, '');
}

// MCP Servers

export async function addMcpServer(projectDir: string, projectName: string, server: McpServer): Promise<boolean> {
  const project = getProjectByName(projectName);
  if (!project) return false;

  const existing = project.mcpServers.findIndex(s => s.name === server.name);
  if (existing >= 0) {
    project.mcpServers[existing] = server;
  } else {
    project.mcpServers.push(server);
  }
  await updateProject(project);

  await writeMcpJson(projectDir, project.mcpServers);
  return true;
}

export async function removeMcpServer(projectDir: string, projectName: string, name: string): Promise<boolean> {
  const project = getProjectByName(projectName);
  if (!project) return false;

  const idx = project.mcpServers.findIndex(s => s.name === name);
  if (idx < 0) return false;

  project.mcpServers.splice(idx, 1);
  await updateProject(project);
  await writeMcpJson(projectDir, project.mcpServers);
  return true;
}

export function listMcpServers(projectName: string): McpServer[] {
  return getProjectByName(projectName)?.mcpServers || [];
}

async function writeMcpJson(projectDir: string, servers: McpServer[]): Promise<void> {
  const mcpPath = join(projectDir, '.mcp.json');

  let mcpConfig: Record<string, unknown> = {};
  try {
    if (existsSync(mcpPath)) {
      const existing = await readFile(mcpPath, 'utf-8');
      mcpConfig = JSON.parse(existing);
    }
  } catch {
    // Start fresh
  }

  const mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }> = {};
  for (const server of servers) {
    mcpServers[server.name] = {
      command: server.command,
      ...(server.args?.length ? { args: server.args } : {}),
      ...(server.env ? { env: server.env } : {}),
    };
  }

  mcpConfig.mcpServers = mcpServers;
  await writeFile(mcpPath, JSON.stringify(mcpConfig, null, 2), 'utf-8');
}

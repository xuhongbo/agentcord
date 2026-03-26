import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Store } from './persistence.ts';
import type { McpServer } from './types.ts';

export interface RegisteredProject {
  id: string;
  name: string;
  path: string;
  discordCategoryId?: string;
  discordLogChannelId?: string;
  personality?: string;
  skills: Record<string, string>;
  mcpServers: McpServer[];
  createdAt: number;
  updatedAt: number;
}

const store = new Store<RegisteredProject[]>('projects.json');
let projects: RegisteredProject[] = [];

function normalizePath(path: string): string {
  return resolve(path);
}

async function saveRegistry(): Promise<void> {
  await store.write(projects);
}

export async function loadRegistry(): Promise<void> {
  projects = (await store.read()) || [];
}

export function getProjectByName(name: string): RegisteredProject | undefined {
  return projects.find(p => p.name === name);
}

export function getProjectByPath(path: string): RegisteredProject | undefined {
  const normalized = normalizePath(path);
  return projects.find(p => normalizePath(p.path) === normalized);
}

export function getProjectByCategoryId(categoryId: string): RegisteredProject | undefined {
  return projects.find(p => p.discordCategoryId === categoryId);
}

export function getAllRegisteredProjects(): RegisteredProject[] {
  return [...projects];
}

export async function registerProject(name: string, path: string): Promise<RegisteredProject> {
  const normalizedPath = normalizePath(path);
  const existingByPath = getProjectByPath(normalizedPath);
  if (existingByPath) {
    if (existingByPath.name !== name) {
      throw new Error(`Path already registered as project "${existingByPath.name}"`);
    }
    return existingByPath;
  }

  if (getProjectByName(name)) {
    throw new Error(`Project name already exists: ${name}`);
  }

  const now = Date.now();
  const project: RegisteredProject = {
    id: randomUUID(),
    name,
    path: normalizedPath,
    skills: {},
    mcpServers: [],
    createdAt: now,
    updatedAt: now,
  };

  projects.push(project);
  await saveRegistry();
  return project;
}

export async function renameProject(oldName: string, newName: string): Promise<void> {
  const project = getProjectByName(oldName);
  if (!project) throw new Error(`Project not found: ${oldName}`);
  if (oldName !== newName && getProjectByName(newName)) {
    throw new Error(`Project name already exists: ${newName}`);
  }
  project.name = newName;
  project.updatedAt = Date.now();
  await saveRegistry();
}

export async function removeProject(name: string): Promise<void> {
  const before = projects.length;
  projects = projects.filter(p => p.name !== name);
  if (projects.length === before) throw new Error(`Project not found: ${name}`);
  await saveRegistry();
}

export async function updateProjectDiscord(name: string, categoryId: string, logChannelId?: string): Promise<void> {
  const project = getProjectByName(name);
  if (!project) throw new Error(`Project not found: ${name}`);
  project.discordCategoryId = categoryId;
  if (logChannelId) project.discordLogChannelId = logChannelId;
  project.updatedAt = Date.now();
  await saveRegistry();
}

export async function updateProject(project: RegisteredProject): Promise<void> {
  const idx = projects.findIndex(p => p.name === project.name);
  if (idx < 0) throw new Error(`Project not found: ${project.name}`);
  projects[idx] = { ...project, updatedAt: Date.now() };
  await saveRegistry();
}

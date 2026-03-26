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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeSkills(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries = Object.entries(value).filter(([, prompt]) => typeof prompt === 'string');
  return Object.fromEntries(entries);
}

function normalizeMcpServers(value: unknown): McpServer[] {
  if (!Array.isArray(value)) return [];
  return value.filter(server => {
    if (!isRecord(server)) return false;
    return typeof server.name === 'string' && typeof server.command === 'string';
  }) as McpServer[];
}

function normalizeProjectFromArray(value: unknown): RegisteredProject | undefined {
  if (!isRecord(value) || typeof value.name !== 'string' || typeof value.path !== 'string') return undefined;
  const now = Date.now();
  return {
    id: typeof value.id === 'string' ? value.id : randomUUID(),
    name: value.name,
    path: normalizePath(value.path),
    discordCategoryId: typeof value.discordCategoryId === 'string' ? value.discordCategoryId : undefined,
    discordLogChannelId: typeof value.discordLogChannelId === 'string' ? value.discordLogChannelId : undefined,
    personality: typeof value.personality === 'string' ? value.personality : undefined,
    skills: normalizeSkills(value.skills),
    mcpServers: normalizeMcpServers(value.mcpServers),
    createdAt: typeof value.createdAt === 'number' ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === 'number' ? value.updatedAt : now,
  };
}

function normalizeProjectFromLegacyEntry(name: string, value: unknown): RegisteredProject | undefined {
  if (!isRecord(value) || typeof value.directory !== 'string') return undefined;
  const now = Date.now();
  return {
    id: randomUUID(),
    name: typeof value.name === 'string' ? value.name : name,
    path: normalizePath(value.directory),
    discordCategoryId: typeof value.categoryId === 'string' ? value.categoryId : undefined,
    discordLogChannelId: typeof value.logChannelId === 'string' ? value.logChannelId : undefined,
    personality: typeof value.personality === 'string' ? value.personality : undefined,
    skills: normalizeSkills(value.skills),
    mcpServers: normalizeMcpServers(value.mcpServers),
    createdAt: now,
    updatedAt: now,
  };
}

function normalizeRegistryData(raw: unknown): { projects: RegisteredProject[]; migrated: boolean } {
  if (Array.isArray(raw)) {
    const normalized = raw.map(normalizeProjectFromArray).filter((project): project is RegisteredProject => !!project);
    return { projects: normalized, migrated: normalized.length !== raw.length };
  }

  if (!isRecord(raw)) {
    return { projects: [], migrated: raw !== undefined && raw !== null };
  }

  const normalized = Object.entries(raw)
    .map(([name, project]) => normalizeProjectFromLegacyEntry(name, project))
    .filter((project): project is RegisteredProject => !!project);
  return { projects: normalized, migrated: true };
}

export async function loadRegistry(): Promise<void> {
  const raw = await store.read();
  const normalized = normalizeRegistryData(raw);
  projects = normalized.projects;
  if (normalized.migrated) {
    await saveRegistry();
  }
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

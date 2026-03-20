import { WebhookClient, type TextChannel } from 'discord.js';
import { Store } from './persistence.ts';
import * as sessions from './session-manager.ts';
import { config } from './config.ts';
import { sanitizeSessionName } from './utils.ts';
import type { AgentData, ProviderName } from './types.ts';
import { agents as personaTemplates } from './agents.ts';

const agentStore = new Store<Record<string, AgentData>>('agents.json');
const agentMap = new Map<string, AgentData>();

// Flower names used for random agent name generation
const FLOWER_NAMES = [
  'Acacia', 'Amaryllis', 'Anemone', 'Aster', 'Azalea',
  'Begonia', 'Bluebell', 'Buttercup', 'Camellia', 'Carnation',
  'Chrysanthemum', 'Clover', 'Columbine', 'Cornflower', 'Cosmos',
  'Crocus', 'Daffodil', 'Dahlia', 'Daisy', 'Dandelion',
  'Echinacea', 'Edelweiss', 'Elderflower', 'Foxglove', 'Freesia',
  'Gardenia', 'Geranium', 'Gladiolus', 'Hazel', 'Heather',
  'Hibiscus', 'Holly', 'Hyacinth', 'Iris', 'Ivy',
  'Jasmine', 'Juniper', 'Lantana', 'Larkspur', 'Lavender',
  'Lilac', 'Lily', 'Lotus', 'Magnolia', 'Marigold',
  'Myrtle', 'Narcissus', 'Oleander', 'Orchid', 'Pansy',
  'Peony', 'Petunia', 'Poppy', 'Primrose', 'Protea',
  'Rosemary', 'Sage', 'Snapdragon', 'Sunflower', 'Thistle',
  'Tulip', 'Verbena', 'Violet', 'Wisteria', 'Yarrow',
  'Zinnia',
];

// Load agents from disk on startup
export async function loadAgents(): Promise<void> {
  const data = await agentStore.read();
  if (!data) return;
  for (const [id, agent] of Object.entries(data)) {
    agentMap.set(id, agent);
  }
  console.log(`Restored ${agentMap.size} agent(s)`);
}

async function saveAgents(): Promise<void> {
  const data: Record<string, AgentData> = {};
  for (const [id, agent] of agentMap) {
    data[id] = agent;
  }
  await agentStore.write(data);
}

// Slugify a name: "Alex The Great" → "alex-the-great"
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// Pick a random flower name that isn't already taken
export function generateFlowerName(): string {
  const takenNames = new Set(
    Array.from(agentMap.values()).map(a => a.name.toLowerCase()),
  );
  const available = FLOWER_NAMES.filter(f => !takenNames.has(f.toLowerCase()));
  if (available.length === 0) {
    // All flowers taken — append a number to a random one
    const base = FLOWER_NAMES[Math.floor(Math.random() * FLOWER_NAMES.length)];
    let n = 2;
    while (takenNames.has(`${base} ${n}`.toLowerCase())) n++;
    return `${base} ${n}`;
  }
  return available[Math.floor(Math.random() * available.length)];
}

// Generate a system prompt from role, with optional template matching
function generateSystemPrompt(name: string, role: string): string {
  // Check if role matches a known persona template
  const template = personaTemplates.find(
    t => t.name === role.toLowerCase() || t.description.toLowerCase().includes(role.toLowerCase()),
  );

  const rolePrompt = template?.systemPrompt || `You specialize in: ${role}`;

  return `You are ${name}, a ${role}.

You are an AI agent participating in a Discord server alongside other agents and human users.

${rolePrompt}

Communication rules:
- When you want another agent to do something, mention them with @TheirName in your response
- Be concise in channel messages — focus on actionable content
- When you complete work, summarize what you did
- If you need clarification, ask the user or relevant agent`;
}

// Build the full system prompt including team awareness
export function buildAgentSystemPrompt(agent: AgentData): string {
  const otherAgents = getAllAgents().filter(a => a.id !== agent.id);
  let prompt = agent.systemPrompt;

  if (otherAgents.length > 0) {
    const agentList = otherAgents
      .map(a => `- @${a.name}: ${a.role}`)
      .join('\n');
    prompt += `\n\nOther agents in this server:\n${agentList}`;
  }

  return prompt;
}

// CRUD operations

export async function createAgent(
  name: string,
  role: string,
  provider: ProviderName,
  createdBy: string,
  opts?: { model?: string; emoji?: string; avatarUrl?: string },
): Promise<AgentData> {
  const id = slugify(name);
  if (!id) throw new Error('Invalid agent name');
  if (agentMap.has(id)) throw new Error(`Agent "${id}" already exists`);

  const agent: AgentData = {
    id,
    name,
    role,
    systemPrompt: generateSystemPrompt(name, role),
    provider,
    model: opts?.model,
    emoji: opts?.emoji,
    avatarUrl: opts?.avatarUrl,
    createdAt: Date.now(),
    createdBy,
    channelSessions: {},
    webhooks: {},
  };

  agentMap.set(id, agent);
  await saveAgents();
  return agent;
}

export async function deleteAgent(id: string): Promise<boolean> {
  const agent = agentMap.get(id);
  if (!agent) return false;

  // End all sessions for this agent
  for (const [, sessionId] of Object.entries(agent.channelSessions)) {
    try {
      await sessions.endSession(sessionId);
    } catch {
      // Session may already be gone
    }
  }

  // Clean up webhooks
  for (const [, wh] of Object.entries(agent.webhooks)) {
    try {
      const client = new WebhookClient({ id: wh.id, token: wh.token });
      await client.delete();
      client.destroy();
    } catch {
      // Webhook may already be deleted
    }
  }

  agentMap.delete(id);
  await saveAgents();
  return true;
}

export function getAgentById(id: string): AgentData | undefined {
  return agentMap.get(id);
}

export function getAgentByName(name: string): AgentData | undefined {
  const lower = name.toLowerCase();
  for (const agent of agentMap.values()) {
    if (agent.name.toLowerCase() === lower || agent.id === lower) {
      return agent;
    }
  }
  return undefined;
}

export function getAllAgents(): AgentData[] {
  return Array.from(agentMap.values());
}

export async function updateAgentPrompt(id: string, prompt: string): Promise<boolean> {
  const agent = agentMap.get(id);
  if (!agent) return false;
  agent.systemPrompt = prompt;
  await saveAgents();
  return true;
}

// Per-channel session management

export async function getOrCreateSession(
  agent: AgentData,
  channelId: string,
  directory: string,
  projectName: string,
): Promise<string> {
  // Check if we already have a session for this channel
  const existingId = agent.channelSessions[channelId];
  if (existingId) {
    const session = sessions.getSession(existingId);
    if (session) return existingId;
    // Session was cleaned up externally, remove stale reference
    delete agent.channelSessions[channelId];
  }

  // Use a synthetic channelId so this doesn't overwrite
  // the regular session's channel mapping
  const syntheticChannelId = `agent:${agent.id}:${channelId}`;
  const sessionName = `agent-${agent.id}-${channelId.slice(-6)}`;
  const session = await sessions.createSession(
    sessionName,
    directory,
    syntheticChannelId,
    projectName,
    agent.provider,
  );

  // Link the agent's system prompt to this session
  sessions.setAgentPersona(session.id, `agent:${agent.id}`);

  agent.channelSessions[channelId] = session.id;
  await saveAgents();
  return session.id;
}

// Webhook management — lazily create per agent per channel

export async function getOrCreateWebhook(
  agent: AgentData,
  channel: TextChannel,
): Promise<WebhookClient> {
  // Check cached webhook
  const cached = agent.webhooks[channel.id];
  if (cached) {
    try {
      const client = new WebhookClient({ id: cached.id, token: cached.token });
      // Verify it still exists by fetching it
      return client;
    } catch {
      // Webhook gone, will recreate
      delete agent.webhooks[channel.id];
    }
  }

  // Create a new webhook in this channel
  const webhook = await channel.createWebhook({
    name: agent.name,
    avatar: agent.avatarUrl || undefined,
    reason: `Agent webhook for ${agent.name}`,
  });

  agent.webhooks[channel.id] = { id: webhook.id, token: webhook.token! };
  await saveAgents();

  return new WebhookClient({ id: webhook.id, token: webhook.token! });
}

// Find an existing agent whose role matches (for team reuse)
export function findAgentByRole(role: string): AgentData | undefined {
  const lower = role.toLowerCase();
  // Exact match first
  for (const agent of agentMap.values()) {
    if (agent.role.toLowerCase() === lower) return agent;
  }
  // Fuzzy: 60%+ keyword overlap
  const roleTokens = lower.split(/\s+/).filter(t => t.length > 2);
  if (roleTokens.length === 0) return undefined;
  for (const agent of agentMap.values()) {
    const agentTokens = agent.role.toLowerCase().split(/\s+/);
    const overlap = roleTokens.filter(t => agentTokens.includes(t));
    if (overlap.length >= Math.ceil(roleTokens.length * 0.6)) return agent;
  }
  return undefined;
}

// Consistent color from agent name
export function agentColor(agent: AgentData): number {
  let hash = 0;
  for (let i = 0; i < agent.name.length; i++) {
    hash = ((hash << 5) - hash + agent.name.charCodeAt(i)) | 0;
  }
  // Map to a pleasant color range
  const hue = Math.abs(hash) % 360;
  // HSL to hex with fixed saturation=70% lightness=50%
  return hslToHex(hue, 70, 50);
}

function hslToHex(h: number, s: number, l: number): number {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color);
  };
  return (f(0) << 16) | (f(8) << 8) | f(4);
}

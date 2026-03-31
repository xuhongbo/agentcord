// 人工门控管理器
// 实现设计文档第 6.4 节和第 10 节的门控协调逻辑

import type { HumanGate, HumanGateStatus, HumanGateResolveSource, ProviderName } from './types.ts';
import * as sessions from './thread-manager.ts';

// 运行时门控注册表（内存，不持久化）
const activeGates = new Map<string, HumanGate>();
let gateIdCounter = 0;

export function createHumanGate(params: {
  sessionId: string;
  provider: ProviderName;
  type: HumanGate['type'];
  isBlocking: boolean;
  supportsRemoteDecision: boolean;
  summary: string;
  detail?: string;
  relatedCommand?: string;
  turn: number;
}): HumanGate {
  const id = `gate-${Date.now()}-${++gateIdCounter}`;
  const gate: HumanGate = {
    id,
    sessionId: params.sessionId,
    provider: params.provider,
    type: params.type,
    isBlocking: params.isBlocking,
    supportsRemoteDecision: params.supportsRemoteDecision,
    summary: params.summary,
    detail: params.detail,
    relatedCommand: params.relatedCommand,
    createdAt: Date.now(),
    status: 'pending',
    turn: params.turn,
  };

  activeGates.set(id, gate);

  // 更新会话的活跃门控 ID
  sessions.updateSession(params.sessionId, {
    activeHumanGateId: id,
  });

  return gate;
}

export function getHumanGate(gateId: string): HumanGate | undefined {
  return activeGates.get(gateId);
}

export function getActiveGateForSession(sessionId: string): HumanGate | undefined {
  for (const gate of activeGates.values()) {
    if (gate.sessionId === sessionId && gate.status === 'pending') {
      return gate;
    }
  }
  return undefined;
}

export function resolveHumanGate(
  gateId: string,
  action: 'approve' | 'deny' | 'answer',
  source: HumanGateResolveSource,
  answer?: string,
): boolean {
  const gate = activeGates.get(gateId);
  if (!gate) return false;

  // 一条门控只能处理一次
  if (gate.status !== 'pending') {
    return false;
  }

  // 更新门控状态
  gate.status = action === 'approve' ? 'approved' : action === 'deny' ? 'denied' : 'answered';
  gate.resolvedAt = Date.now();
  gate.resolvedSource = source;
  gate.resolvedAction = answer || action;

  // 清除会话的活跃门控 ID
  sessions.updateSession(gate.sessionId, {
    activeHumanGateId: undefined,
    humanResolved: true,
  });

  return true;
}

export function invalidateHumanGate(gateId: string, source: HumanGateResolveSource): boolean {
  const gate = activeGates.get(gateId);
  if (!gate) return false;

  if (gate.status !== 'pending') {
    return false;
  }

  gate.status = 'invalidated';
  gate.resolvedAt = Date.now();
  gate.resolvedSource = source;

  sessions.updateSession(gate.sessionId, {
    activeHumanGateId: undefined,
  });

  return true;
}

export function expireHumanGate(gateId: string): boolean {
  const gate = activeGates.get(gateId);
  if (!gate) return false;

  if (gate.status !== 'pending') {
    return false;
  }

  gate.status = 'expired';
  gate.resolvedAt = Date.now();
  gate.resolvedSource = 'timeout';

  sessions.updateSession(gate.sessionId, {
    activeHumanGateId: undefined,
  });

  return true;
}

export function invalidateAllPendingGates(reason: HumanGateResolveSource = 'restart'): number {
  let count = 0;
  for (const gate of activeGates.values()) {
    if (gate.status === 'pending') {
      gate.status = 'invalidated';
      gate.resolvedAt = Date.now();
      gate.resolvedSource = reason;
      sessions.updateSession(gate.sessionId, {
        activeHumanGateId: undefined,
      });
      count++;
    }
  }
  return count;
}

export function cleanupExpiredGates(maxAgeMs: number = 3600000): number {
  const now = Date.now();
  let count = 0;
  for (const [id, gate] of activeGates.entries()) {
    if (gate.resolvedAt && now - gate.resolvedAt > maxAgeMs) {
      activeGates.delete(id);
      count++;
    }
  }
  return count;
}

export function getAllActiveGates(): HumanGate[] {
  return Array.from(activeGates.values()).filter(g => g.status === 'pending');
}

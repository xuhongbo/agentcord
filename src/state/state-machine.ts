// 状态机核心逻辑
// 参考：clawd-on-desk/src/state.js

import type { UnifiedState, SessionStateSnapshot, PlatformEvent } from './types.ts';
import { STATE_PRIORITY, STATE_LABELS, STATE_COLORS, PLATFORM_EVENT_TO_STATE } from './types.ts';

export class StateMachine {
  private sessions = new Map<string, SessionStateSnapshot>();

  ensureSession(sessionId: string): SessionStateSnapshot {
    const existing = this.sessions.get(sessionId);
    if (existing) return existing;
    const created = this.createDefaultSnapshot();
    this.sessions.set(sessionId, created);
    return created;
  }

  updateSession(sessionId: string, patch: Partial<SessionStateSnapshot>): void {
    const current = this.ensureSession(sessionId);
    this.sessions.set(sessionId, { ...current, ...patch, updatedAt: Date.now() });
  }

  getSession(sessionId: string): SessionStateSnapshot | undefined {
    return this.sessions.get(sessionId);
  }

  resolveDisplayState(): UnifiedState {
    let best: UnifiedState = 'idle';
    let bestPri = 0;

    for (const [, s] of this.sessions) {
      const pri = STATE_PRIORITY[s.state] || 0;
      if (pri > bestPri) {
        best = s.state;
        bestPri = pri;
      }
    }

    return best;
  }

  shouldTransition(from: UnifiedState, to: UnifiedState): boolean {
    const fromPri = STATE_PRIORITY[from] || 0;
    const toPri = STATE_PRIORITY[to] || 0;
    return toPri >= fromPri;
  }

  getStateLabel(state: UnifiedState): string {
    return STATE_LABELS[state] || state;
  }

  getStateColor(state: UnifiedState): number {
    return STATE_COLORS[state] || 0x808080;
  }

  incrementTurn(sessionId: string): SessionStateSnapshot {
    const current = this.ensureSession(sessionId);
    const nextTurn = current.turn + 1;
    this.updateSession(sessionId, {
      turn: nextTurn,
      isCompleted: false,
      isWaitingHuman: false,
      humanResolved: false,
    });
    return this.ensureSession(sessionId);
  }

  applyPlatformEvent(event: PlatformEvent): SessionStateSnapshot {
    const mappedState = PLATFORM_EVENT_TO_STATE[event.type];
    const current = this.ensureSession(event.sessionId);

    if (!mappedState) return current;

    const patch: Partial<SessionStateSnapshot> = {
      state: mappedState,
      source: 'formal',
      confidence: event.confidence,
      phase: this.getStateLabel(mappedState),
      isWaitingHuman: mappedState === 'awaiting_human',
      humanResolved: event.type === 'human_resolved',
      isCompleted: mappedState === 'completed',
      isError: mappedState === 'error',
      isStalled: mappedState === 'stalled',
    };

    if (event.type === 'session_started' && current.turn <= 0) {
      patch.turn = 1;
    }
    if (event.type === 'session_ended') {
      patch.isWaitingHuman = false;
    }

    this.updateSession(event.sessionId, patch);
    return this.ensureSession(event.sessionId);
  }

  private createDefaultSnapshot(): SessionStateSnapshot {
    return {
      state: 'idle',
      source: 'formal',
      confidence: 'high',
      updatedAt: Date.now(),
      turn: 0,
      isWaitingHuman: false,
      humanResolved: false,
      isCompleted: false,
      isError: false,
      isStalled: false,
    };
  }
}

// 状态机核心逻辑
// 参考：clawd-on-desk/src/state.js

import type { UnifiedState, SessionStateSnapshot, PlatformEvent } from './types.ts';
import { STATE_PRIORITY, STATE_LABELS, STATE_COLORS, PLATFORM_EVENT_TO_STATE } from './types.ts';

export class StateMachine {
  private sessions = new Map<string, SessionStateSnapshot>();
  private completedTimers = new Map<string, NodeJS.Timeout>();

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

  shouldTransition(
    from: UnifiedState,
    to: UnifiedState,
    fromSource: 'formal' | 'inferred' = 'formal',
    toSource: 'formal' | 'inferred' = 'formal'
  ): boolean {
    const fromPri = STATE_PRIORITY[from] || 0;
    const toPri = STATE_PRIORITY[to] || 0;

    // formal 事件优先于 inferred
    if (fromSource === 'formal' && toSource === 'inferred') {
      return toPri > fromPri; // 只有更高优先级才能打断
    }

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

    const allowTransition =
      event.type === 'human_resolved' ||
      event.type === 'completed' ||
      event.type === 'session_idle' ||
      event.type === 'session_ended' ||
      this.shouldTransition(
        current.state,
        mappedState,
        current.stateSource,
        event.stateSource ?? 'formal'
      );
    if (!allowTransition) {
      return current;
    }

    const phaseLabel =
      (event.metadata?.phase as string) ?? this.getStateLabel(mappedState);

    const patch: Partial<SessionStateSnapshot> = {
      state: mappedState,
      stateSource: event.stateSource ?? 'formal',
      confidence: event.confidence,
      phase: phaseLabel,
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

    // completed 自动回落到 idle（3 秒后）
    if (mappedState === 'completed') {
      // 清理旧的 timer
      const existingTimer = this.completedTimers.get(event.sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      // 设置新的 timer
      const timer = setTimeout(() => {
        this.applyPlatformEvent({
          type: 'session_idle',
          sessionId: event.sessionId,
          source: event.source, // 继承原事件的 source
          stateSource: 'formal',
          confidence: 'high',
          timestamp: Date.now(),
          metadata: { phase: '待命' },
        });
        this.completedTimers.delete(event.sessionId);
      }, 3000);

      this.completedTimers.set(event.sessionId, timer);
    }

    this.updateSession(event.sessionId, patch);
    return this.ensureSession(event.sessionId);
  }

  private createDefaultSnapshot(): SessionStateSnapshot {
    return {
      state: 'idle',
      stateSource: 'formal',
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

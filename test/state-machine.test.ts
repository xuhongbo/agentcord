import { describe, expect, it } from 'vitest';
import { StateMachine } from '../src/state/state-machine.ts';

describe('StateMachine priority enforcement', () => {
  it('should ignore lower priority events while higher priority state is active', () => {
    const machine = new StateMachine();
    const sessionId = 'priority-test';

    machine.applyPlatformEvent({
      type: 'awaiting_human',
      sessionId,
      source: 'claude',
      confidence: 'high',
      timestamp: 1,
      stateSource: 'formal',
    });

    const snapshot = machine.applyPlatformEvent({
      type: 'thinking_started',
      sessionId,
      source: 'claude',
      confidence: 'high',
      timestamp: 2,
      stateSource: 'formal',
    });

    expect(snapshot.state).toBe('awaiting_human');
  });

  it('should allow session_ended to transition back to offline', () => {
    const machine = new StateMachine();
    const sessionId = 'end-test';

    machine.applyPlatformEvent({
      type: 'awaiting_human',
      sessionId,
      source: 'claude',
      confidence: 'high',
      timestamp: 1,
      stateSource: 'formal',
    });

    const snapshot = machine.applyPlatformEvent({
      type: 'session_ended',
      sessionId,
      source: 'claude',
      confidence: 'high',
      timestamp: 2,
      stateSource: 'formal',
    });

    expect(snapshot.state).toBe('offline');
  });

  it('should allow completed to replace working when a turn finishes', () => {
    const machine = new StateMachine();
    const sessionId = 'completed-test';

    machine.applyPlatformEvent({
      type: 'work_started',
      sessionId,
      source: 'claude',
      confidence: 'high',
      timestamp: 1,
      stateSource: 'formal',
    });

    const snapshot = machine.applyPlatformEvent({
      type: 'completed',
      sessionId,
      source: 'claude',
      confidence: 'high',
      timestamp: 2,
      stateSource: 'formal',
    });

    expect(snapshot.state).toBe('completed');
  });

  it('should allow session_idle to clear awaiting_human after rejection', () => {
    const machine = new StateMachine();
    const sessionId = 'idle-test';

    machine.applyPlatformEvent({
      type: 'awaiting_human',
      sessionId,
      source: 'claude',
      confidence: 'high',
      timestamp: 1,
      stateSource: 'formal',
    });

    const snapshot = machine.applyPlatformEvent({
      type: 'session_idle',
      sessionId,
      source: 'claude',
      confidence: 'high',
      timestamp: 2,
      stateSource: 'formal',
    });

    expect(snapshot.state).toBe('idle');
  });

  it('human_resolved should break out of awaiting_human back to working', () => {
    const machine = new StateMachine();
    const sessionId = 'human-test';

    machine.applyPlatformEvent({
      type: 'awaiting_human',
      sessionId,
      source: 'claude',
      confidence: 'high',
      timestamp: 1,
      stateSource: 'formal',
    });

    const snapshot = machine.applyPlatformEvent({
      type: 'human_resolved',
      sessionId,
      source: 'claude',
      confidence: 'high',
      timestamp: 2,
      stateSource: 'formal',
    });

    expect(snapshot.state).toBe('working');
  });
});

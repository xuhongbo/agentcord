import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../src/types.ts';

const sendPromptMock = vi.fn();
const continueSessionMock = vi.fn();
const sendMonitorPromptMock = vi.fn();
const getSessionMock = vi.fn();
const setMonitorGoalMock = vi.fn();
const updateWorkflowStateMock = vi.fn();
const abortSessionWithReasonMock = vi.fn();
const consumeAbortReasonMock = vi.fn();
const handleOutputStreamMock = vi.fn();

vi.mock('../src/session-manager.ts', () => ({
  sendPrompt: sendPromptMock,
  continueSession: continueSessionMock,
  sendMonitorPrompt: sendMonitorPromptMock,
  getSession: getSessionMock,
  setMonitorGoal: setMonitorGoalMock,
  updateWorkflowState: updateWorkflowStateMock,
  abortSessionWithReason: abortSessionWithReasonMock,
  consumeAbortReason: consumeAbortReasonMock,
}));

vi.mock('../src/output-handler.ts', () => ({
  handleOutputStream: handleOutputStreamMock,
}));

function makeSession(): Session {
  return {
    id: 'sess-1',
    channelId: 'chan-1',
    directory: '/tmp/project',
    projectName: 'project',
    provider: 'codex',
    verbose: false,
    mode: 'monitor',
    workflowState: {
      status: 'idle',
      iteration: 0,
      updatedAt: Date.now(),
    },
    isGenerating: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
    messageCount: 0,
    totalCost: 0,
  };
}

function makeMonitorStream(decision: Record<string, unknown>): AsyncGenerator<any> {
  return (async function* () {
    yield { type: 'text_delta', text: JSON.stringify(decision) };
    yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
  })();
}

describe('session-executor monitor loop', () => {
  beforeEach(() => {
    vi.resetModules();
    sendPromptMock.mockReset();
    continueSessionMock.mockReset();
    sendMonitorPromptMock.mockReset();
    getSessionMock.mockReset();
    setMonitorGoalMock.mockReset();
    updateWorkflowStateMock.mockReset();
    abortSessionWithReasonMock.mockReset();
    consumeAbortReasonMock.mockReset();
    handleOutputStreamMock.mockReset();
    consumeAbortReasonMock.mockReturnValue(undefined);
  });

  it('keeps steering a long-running task until the monitor accepts completion', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })());

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: 'I created a draft benchmark, but it is still too easy and not robust yet.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 0,
        fileChangeCount: 1,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I made it longer and added distractors, but the pass bar is still too forgiving.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 1,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I hardened the benchmark, tightened grading, and validated difficult failure cases.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 2,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock
      .mockReturnValueOnce(makeMonitorStream({
        status: 'continue',
        confidence: 'high',
        rationale: 'The benchmark exists, but it is not yet robust or hard to pass.',
        steering: 'Increase benchmark difficulty, add stricter grading, and validate adversarial cases.',
        completionSummary: '',
      }))
      .mockReturnValueOnce(makeMonitorStream({
        status: 'continue',
        confidence: 'medium',
        rationale: 'The task is closer, but the grading is still too lenient for the requested quality bar.',
        steering: 'Tighten the scoring threshold and verify that shallow memory strategies fail.',
        completionSummary: '',
      }))
      .mockReturnValueOnce(makeMonitorStream({
        status: 'complete',
        confidence: 'high',
        rationale: 'The benchmark now matches the requested robustness and difficulty.',
        steering: '',
        completionSummary: 'Robust difficult benchmark completed and validated.',
      }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Build a robust, difficult, hard-to-pass memory benchmark.', {
      updateMonitorGoal: true,
    });

    expect(setMonitorGoalMock).toHaveBeenCalledWith(
      'sess-1',
      'Build a robust, difficult, hard-to-pass memory benchmark.',
    );
    expect(sendPromptMock).toHaveBeenCalledTimes(3);
    expect(sendMonitorPromptMock).toHaveBeenCalledTimes(3);
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('pass 1/6'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('pass 2/6'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
    expect(updateWorkflowStateMock).toHaveBeenCalledWith('sess-1', expect.any(Function));

    const secondWorkerPrompt = sendPromptMock.mock.calls[1][1];
    const thirdWorkerPrompt = sendPromptMock.mock.calls[2][1];
    expect(secondWorkerPrompt).toContain('Required next steps:');
    expect(secondWorkerPrompt).toContain('Increase benchmark difficulty');
    expect(thirdWorkerPrompt).toContain('Tighten the scoring threshold');
  });

  it('drives a monitored multi-pass run to concrete benchmark artifacts before completing', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'agentcord-monitor-e2e-'));
    const session = {
      ...makeSession(),
      directory: workspace,
      projectName: 'agentcord-monitor-e2e',
    };
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })());

    handleOutputStreamMock
      .mockImplementationOnce(async () => ({
        text: 'I drafted a benchmark folder, but the benchmark is still missing the grading rubric and validation report.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 2,
        fileChangeCount: 1,
        recentCommands: [],
        changedFiles: [],
      }))
      .mockImplementationOnce(async () => {
        writeFileSync(join(workspace, 'benchmark-spec.md'), '# Benchmark Spec\n\nHard benchmark draft.\n', 'utf-8');
        writeFileSync(join(workspace, 'benchmark-rubric.md'), '# Rubric\n\nStricter than the first pass.\n', 'utf-8');
        return {
          text: 'I added the benchmark spec and rubric, but I still need adversarial cases and a validation report.',
          askedUser: false,
          askUserQuestionsJson: undefined,
          hadError: false,
          success: true,
          commandCount: 3,
          fileChangeCount: 2,
          recentCommands: ['node benchmark/grader.js --list'],
          changedFiles: [
            join(workspace, 'benchmark-spec.md'),
            join(workspace, 'benchmark-rubric.md'),
          ],
        };
      })
      .mockImplementationOnce(async () => {
        writeFileSync(join(workspace, 'benchmark-adversarial-cases.md'), '# Adversarial Cases\n\nEdge-case prompts.\n', 'utf-8');
        writeFileSync(join(workspace, 'benchmark-validation-report.md'), '# Validation Report\n\nCompleted and validated.\n', 'utf-8');
        return {
          text: 'I finished the adversarial cases, validated the benchmark, and completed the requested artifact set.',
          askedUser: false,
          askUserQuestionsJson: undefined,
          hadError: false,
          success: true,
          commandCount: 2,
          fileChangeCount: 2,
          recentCommands: [
            'node benchmark/grader.js --scenario atlas-release --response benchmark/sample-good-response.txt',
            'node benchmark/grader.js --scenario atlas-release --response benchmark/sample-bad-response.txt',
          ],
          changedFiles: [
            join(workspace, 'benchmark-adversarial-cases.md'),
            join(workspace, 'benchmark-validation-report.md'),
          ],
        };
      });

    sendMonitorPromptMock
      .mockReturnValueOnce(makeMonitorStream({
        status: 'continue',
        confidence: 'high',
        rationale: 'The benchmark request is still incomplete because only an initial draft exists.',
        steering: 'Create the missing rubric and validation artifacts, then verify the benchmark is hard to pass before stopping.',
        completionSummary: '',
      }))
      .mockReturnValueOnce(makeMonitorStream({
        status: 'continue',
        confidence: 'medium',
        rationale: 'The benchmark is closer, but adversarial cases and validation are still missing.',
        steering: 'Add adversarial cases, produce a validation report, and confirm the benchmark now satisfies the original request.',
        completionSummary: '',
      }))
      .mockReturnValueOnce(makeMonitorStream({
        status: 'complete',
        confidence: 'high',
        rationale: 'The requested benchmark artifact set now exists and is validated.',
        steering: '',
        completionSummary: 'Robust benchmark artifacts created and validated.',
      }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Create a robust, difficult, hard-to-pass memory benchmark in this repository.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(3);
    expect(sendMonitorPromptMock).toHaveBeenCalledTimes(3);
    const secondMonitorPrompt = sendMonitorPromptMock.mock.calls[1][1];
    const thirdMonitorPrompt = sendMonitorPromptMock.mock.calls[2][1];
    expect(secondMonitorPrompt).toContain(join(workspace, 'benchmark-spec.md'));
    expect(secondMonitorPrompt).toContain(join(workspace, 'benchmark-rubric.md'));
    expect(thirdMonitorPrompt).toContain(join(workspace, 'benchmark-validation-report.md'));
    expect(thirdMonitorPrompt).toContain('sample-good-response.txt');
    expect(existsSync(join(workspace, 'benchmark-spec.md'))).toBe(true);
    expect(existsSync(join(workspace, 'benchmark-rubric.md'))).toBe(true);
    expect(existsSync(join(workspace, 'benchmark-adversarial-cases.md'))).toBe(true);
    expect(existsSync(join(workspace, 'benchmark-validation-report.md'))).toBe(true);
    expect(readFileSync(join(workspace, 'benchmark-validation-report.md'), 'utf-8')).toContain('Completed and validated');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('pass 1/6 says the original request is still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('pass 2/6 says the original request is still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
  });

  it('asks the worker for another guided pass when there is partial progress but the goal is still unmet', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })());

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: 'I created the files, but I have not validated the edge cases yet.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 2,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I validated the edge cases and finished the task.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 1,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock
      .mockReturnValueOnce(makeMonitorStream({
        status: 'continue',
        confidence: 'medium',
        rationale: 'The implementation exists, but validation against the remaining edge cases is still missing.',
        steering: 'Run the missing validations, fix any edge-case failures, and then confirm the requested quality bar is met.',
        completionSummary: '',
      }))
      .mockReturnValueOnce(makeMonitorStream({
        status: 'complete',
        confidence: 'high',
        rationale: 'The implementation and validation now satisfy the request.',
        steering: '',
        completionSummary: 'Validated implementation completed.',
      }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Implement the feature and validate the edge cases.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(2);
    expect(sendPromptMock.mock.calls[1][1]).toContain('Required next steps:');
    expect(sendPromptMock.mock.calls[1][1]).toContain('Run the missing validations');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
  });

  it('routes a file-change-without-prose pass through monitor continue instead of silently stopping', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })());

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: '',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 1,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I finished the remaining implementation and validation.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 1,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock
      .mockReturnValueOnce(makeMonitorStream({
        status: 'complete',
        confidence: 'high',
        rationale: 'The remaining implementation and validation are now complete.',
        steering: '',
        completionSummary: 'Task completed after monitor-guided continuation.',
      }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Implement the requested feature fully and validate it.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(2);
    expect(sendMonitorPromptMock).toHaveBeenCalledTimes(1);
    expect(sendPromptMock.mock.calls[1][1]).toContain('Inspect the latest changes');
    expect(sendPromptMock.mock.calls[1][1]).toContain('report explicit completion evidence before stopping');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('limited activity'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
  });

  it('downgrades a false complete decision to continue when the pass has no textual completion evidence', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })());

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: '',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 2,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I verified the remaining acceptance criteria and completed the task.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 1,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock
      .mockReturnValueOnce(makeMonitorStream({
        status: 'complete',
        confidence: 'high',
        rationale: 'The task is complete.',
        steering: '',
        completionSummary: 'Done.',
      }))
      .mockReturnValueOnce(makeMonitorStream({
        status: 'complete',
        confidence: 'high',
        rationale: 'The remaining validation and completion evidence are now present.',
        steering: '',
        completionSummary: 'Task completed after false-complete recovery.',
      }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Implement the requested feature fully and validate it.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(2);
    expect(sendPromptMock.mock.calls[1][1]).toContain('Inspect the latest changes');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
  });

  it('auto-resolves unnecessary worker questions instead of stopping for humans', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })());

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: 'Should I choose the stricter scoring rubric or the easier one?',
        askedUser: true,
        askUserQuestionsJson: '{"questions":[{"question":"Which rubric should I use?","options":[{"label":"strict"},{"label":"easy"}]}]}',
        hadError: false,
        success: true,
        commandCount: 0,
        fileChangeCount: 0,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I used the strict rubric and completed the benchmark pack.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 3,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock
      .mockReturnValueOnce(makeMonitorStream({
        shouldAskHuman: false,
        rationale: 'The stricter rubric is clearly better aligned with the original request.',
        autoResponse: 'Use the stricter rubric and continue without asking the human.',
      }))
      .mockReturnValueOnce(makeMonitorStream({
        status: 'complete',
        confidence: 'high',
        rationale: 'The benchmark pack now satisfies the original request.',
        steering: '',
        completionSummary: 'Strict rubric chosen automatically and task completed.',
      }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Build a robust memory benchmark with a strict scoring bar.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(2);
    expect(sendMonitorPromptMock).toHaveBeenCalledTimes(2);
    expect(sendPromptMock.mock.calls[1][1]).toContain('Use the stricter rubric');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('auto-resolving worker question'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
  });

  it('forces continuation when a pass makes no meaningful progress', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })());

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: '',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: true,
        success: null,
        commandCount: 0,
        fileChangeCount: 0,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I wrote the requested files and validated them.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 4,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock.mockReturnValueOnce(makeMonitorStream({
      status: 'complete',
      confidence: 'high',
      rationale: 'The forced continuation produced the required concrete deliverables.',
      steering: '',
      completionSummary: 'Task completed after forced re-anchoring.',
    }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Create the requested deliverables and validate them.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(2);
    expect(sendPromptMock.mock.calls[1][1]).toContain('Required next steps:');
    expect(sendPromptMock.mock.calls[1][1]).toContain('Identify the failing step');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
  });

  it('treats exploratory command-only passes without output or file changes as incomplete', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })());

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: '',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 3,
        fileChangeCount: 0,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I made the requested code changes and validated them.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 2,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock.mockReturnValueOnce(makeMonitorStream({
      status: 'complete',
      confidence: 'high',
      rationale: 'The guided retry produced the required deliverables.',
      steering: '',
      completionSummary: 'Task completed after exploratory pass recovery.',
    }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Implement the requested code changes and validate them.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(2);
    expect(sendMonitorPromptMock).toHaveBeenCalledTimes(1);
    expect(sendPromptMock.mock.calls[1][1]).toContain('Required next steps:');
    expect(sendPromptMock.mock.calls[1][1]).toContain('Re-anchor on the original request');
    expect(sendPromptMock.mock.calls[1][1]).toContain('make concrete progress in the repository');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('The worker made no substantive completion report and did not change files'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
  });

  it('shows execution evidence to the monitor even when the worker text is empty', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock.mockReturnValueOnce((async function* () {
      yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    })());

    handleOutputStreamMock.mockResolvedValueOnce({
      text: '',
      askedUser: false,
      askUserQuestionsJson: undefined,
      hadError: false,
      success: true,
      commandCount: 2,
      fileChangeCount: 3,
    });

    sendMonitorPromptMock.mockReturnValueOnce(makeMonitorStream({
      status: 'complete',
      confidence: 'high',
      rationale: 'The worker made concrete repo changes and completed the task.',
      steering: '',
      completionSummary: 'Execution evidence was sufficient to judge completion.',
    }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Implement the requested repository changes.', {
      updateMonitorGoal: true,
    });

    const monitorPrompt = sendMonitorPromptMock.mock.calls[0][1];
    expect(monitorPrompt).toContain('Textual response: (no textual response)');
    expect(monitorPrompt).toContain('Command executions: 2');
    expect(monitorPrompt).toContain('File changes: 3');
    expect(monitorPrompt).toContain('Meaningful execution evidence: yes');
    expect(monitorPrompt).toContain('Worker progress report JSON:');
    expect(monitorPrompt).toContain('"meaningfulExecutionEvidence": true');
  });

  it('persists structured worker and monitor reports into workflow state during monitor retries', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })())
      .mockReturnValueOnce((async function* () { yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] }; })());

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: 'I created a draft, but validation is still missing.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 1,
        recentCommands: ['python validate.py --draft'],
        changedFiles: ['/tmp/project/draft.md'],
      })
      .mockResolvedValueOnce({
        text: 'I ran validation and completed the task.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 1,
        recentCommands: ['python validate.py --final'],
        changedFiles: ['/tmp/project/validation.md'],
      });

    sendMonitorPromptMock
      .mockReturnValueOnce(makeMonitorStream({
        status: 'continue',
        confidence: 'high',
        rationale: 'Validation evidence is still missing.',
        steering: 'Run validation and report the result.',
        completionSummary: '',
        acceptedEvidence: ['A draft artifact was created.'],
        missingEvidence: ['Validation results tied to the request.'],
        requiredNextProof: ['Run validation and show the result.'],
        disallowedDrift: ['Do not keep refining the draft before validation.'],
        blockingReason: '',
      }))
      .mockReturnValueOnce(makeMonitorStream({
        status: 'complete',
        confidence: 'high',
        rationale: 'Validation evidence is now present.',
        steering: '',
        completionSummary: 'Task completed with validation evidence.',
        acceptedEvidence: ['Validation results tied to the request.'],
        missingEvidence: [],
        requiredNextProof: [],
        disallowedDrift: [],
        blockingReason: '',
      }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Create the draft and validate it.', {
      updateMonitorGoal: true,
    });

    const persistedStates = updateWorkflowStateMock.mock.calls
      .map(([, patch]) => typeof patch === 'function'
        ? patch({ status: 'idle', iteration: 0, updatedAt: Date.now() })
        : patch)
      .filter(Boolean);

    expect(persistedStates.some(state => state.lastWorkerReport?.artifacts?.includes('/tmp/project/draft.md'))).toBe(true);
    expect(persistedStates.some(state => state.lastMonitorDecision?.requiredNextProof?.includes('Run validation and show the result.'))).toBe(true);
    expect(persistedStates.some(state => state.lastMonitorDecision?.acceptedEvidence?.includes('A draft artifact was created.'))).toBe(true);
  });

  it('sends the monitor a structured pass summary instead of only raw text', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock.mockReturnValueOnce((async function* () {
      yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    })());

    handleOutputStreamMock.mockResolvedValueOnce({
      text: 'Implemented the workflow loop and validation pass.',
      askedUser: false,
      askUserQuestionsJson: undefined,
      hadError: false,
      success: true,
      commandCount: 2,
      fileChangeCount: 3,
      recentCommands: ['npm test -- monitor'],
      changedFiles: ['/tmp/project/src/session-executor.ts', '/tmp/project/test/session-executor.test.ts'],
    });

    sendMonitorPromptMock.mockReturnValueOnce(makeMonitorStream({
      status: 'complete',
      confidence: 'high',
      rationale: 'The task is complete.',
      steering: '',
      completionSummary: 'Done.',
    }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Implement the monitor loop.', {
      updateMonitorGoal: true,
    });

    const monitorPrompt = sendMonitorPromptMock.mock.calls[0][1];
    expect(monitorPrompt).toContain('Textual response: Implemented the workflow loop and validation pass.');
    expect(monitorPrompt).toContain('Command executions: 2');
    expect(monitorPrompt).toContain('File changes: 3');
    expect(monitorPrompt).toContain('Changed files: /tmp/project/src/session-executor.ts, /tmp/project/test/session-executor.test.ts');
    expect(monitorPrompt).toContain('Worker progress report JSON:');
    expect(monitorPrompt).toContain('"claimedCompletedOutcomes"');
    expect(monitorPrompt).toContain('"artifacts": [');
    expect(monitorPrompt).toContain('"validationCommands": [');
    expect(monitorPrompt).toContain('npm test -- monitor');
    expect(monitorPrompt).toContain('Asked for human input: no');
    expect(monitorPrompt).toContain('Provider reported success: yes');
    expect(monitorPrompt).toContain('Worker errors observed: no');
  });

  it('keeps steering when the worker emits no prose and only limited file-change evidence', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () {
        yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
      })())
      .mockReturnValueOnce((async function* () {
        yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
      })());

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: '',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 2,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I finished the remaining validation and confirmed the task is complete.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 1,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock
      .mockReturnValueOnce(makeMonitorStream({
        status: 'complete',
        confidence: 'high',
        rationale: 'The completion evidence is now explicit.',
        steering: '',
        completionSummary: 'Done.',
      }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Implement the monitor loop.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(2);
    expect(sendMonitorPromptMock).toHaveBeenCalledTimes(1);
    expect(sendPromptMock.mock.calls[1][1]).toContain('Inspect the latest changes');
    expect(sendPromptMock.mock.calls[1][1]).toContain('report explicit completion evidence before stopping');
    expect(sendPromptMock.mock.calls[1][1]).toContain('Evidence still missing:');
    expect(sendPromptMock.mock.calls[1][1]).toContain('Your next pass must prove:');
    const completionMonitorPrompt = sendMonitorPromptMock.mock.calls[0][1];
    expect(completionMonitorPrompt).toContain('I finished the remaining validation and confirmed the task is complete.');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('limited activity'));
  });

  it('moves the workflow into awaiting_human when the monitor says a real decision is needed', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock.mockReturnValueOnce((async function* () {
      yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    })());

    handleOutputStreamMock.mockResolvedValueOnce({
      text: 'Should I target Postgres or SQLite for this migration?',
      askedUser: true,
      askUserQuestionsJson: '{"questions":[{"question":"Which database should I target?","options":[{"label":"Postgres"},{"label":"SQLite"}]}]}',
      hadError: false,
      success: true,
      commandCount: 0,
      fileChangeCount: 0,
    });

    sendMonitorPromptMock.mockReturnValueOnce(makeMonitorStream({
      shouldAskHuman: true,
      rationale: 'The database choice materially changes the implementation and the original request does not imply the better answer.',
      autoResponse: '',
    }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Implement the requested migration flow.', {
      updateMonitorGoal: true,
    });

    const askUserReviewPrompt = sendMonitorPromptMock.mock.calls[0][1];
    expect(askUserReviewPrompt).toContain('Textual response: Should I target Postgres or SQLite for this migration?');
    expect(askUserReviewPrompt).toContain('Asked for human input: yes');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('human input required'));
    const awaitingHumanTransition = updateWorkflowStateMock.mock.calls.find(([, patch]) => {
      if (typeof patch !== 'function') return false;
      const next = patch({
        status: 'monitor_review',
        iteration: 1,
        updatedAt: Date.now(),
      });
      return next.status === 'awaiting_human' && next.awaitingHumanReason?.includes('materially changes');
    });
    expect(awaitingHumanTransition).toBeTruthy();
  });

  it('stops with blocked when the monitor identifies a true blocker', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock.mockReturnValueOnce((async function* () {
      yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    })());

    handleOutputStreamMock.mockResolvedValueOnce({
      text: 'I can proceed once the missing production credentials are available.',
      askedUser: false,
      askUserQuestionsJson: undefined,
      hadError: false,
      success: true,
      commandCount: 0,
      fileChangeCount: 0,
    });

    sendMonitorPromptMock.mockReturnValueOnce(makeMonitorStream({
      status: 'blocked',
      confidence: 'high',
      rationale: 'Production credentials are required and are not available in the current environment.',
      steering: 'Blocked until credentials are provided.',
      completionSummary: '',
    }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Deploy the change to production and verify it.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('Monitor: blocked'));
    const blockedTransition = updateWorkflowStateMock.mock.calls.find(([, patch]) => {
      if (typeof patch !== 'function') return false;
      const next = patch({
        status: 'monitor_review',
        iteration: 1,
        updatedAt: Date.now(),
      });
      return next.status === 'blocked' && next.awaitingHumanReason?.includes('credentials');
    });
    expect(blockedTransition).toBeTruthy();
  });

  it('forces another guided pass when monitor-mode continue returns no substantive result', async () => {
    const session = makeSession();
    session.monitorGoal = 'Finish the benchmark package and validate it.';
    session.workflowState.iteration = 2;
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    continueSessionMock.mockReturnValueOnce((async function* () {
      yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    })());

    sendPromptMock.mockReturnValueOnce((async function* () {
      yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
    })());

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: '',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 0,
        fileChangeCount: 0,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I wrote the missing files and validated them.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 3,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock.mockReturnValueOnce(makeMonitorStream({
      status: 'complete',
      confidence: 'high',
      rationale: 'The follow-up guided pass produced the required deliverables.',
      steering: '',
      completionSummary: 'Task completed after continuation recovery.',
    }));

    const { executeSessionContinue } = await import('../src/session-executor.ts');
    await executeSessionContinue(session, channel as any);

    expect(continueSessionMock).toHaveBeenCalledWith('sess-1');
    expect(sendPromptMock).toHaveBeenCalledTimes(1);
    expect(sendPromptMock.mock.calls[0][1]).toContain('Required next steps:');
    expect(sendPromptMock.mock.calls[0][1]).toContain('Re-anchor on the original request');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
  });

  it('treats a watchdog-aborted worker pass as incomplete and retries automatically', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () {
        yield { type: 'result', success: false, costUsd: 0, durationMs: 1, numTurns: 1, errors: ['aborted'] };
      })())
      .mockReturnValueOnce((async function* () {
        yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
      })());

    consumeAbortReasonMock
      .mockReturnValueOnce('watchdog')
      .mockReturnValueOnce(undefined);

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: 'Session aborted by watchdog.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: true,
        success: null,
        commandCount: 0,
        fileChangeCount: 0,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I resumed, wrote the missing files, and validated the result.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 2,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock.mockReturnValueOnce(makeMonitorStream({
      status: 'complete',
      confidence: 'high',
      rationale: 'The retry completed the requested work after the stalled pass.',
      steering: '',
      completionSummary: 'Recovered from watchdog abort and completed the task.',
    }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Finish the requested implementation and validate it.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(2);
    expect(sendMonitorPromptMock).toHaveBeenCalledTimes(1);
    expect(sendPromptMock.mock.calls[1][1]).toContain('Required next steps:');
    expect(sendPromptMock.mock.calls[1][1]).toContain('Identify the failing step');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
  });

  it('keeps the session alive across watchdog-aborted retries until a later pass makes progress', async () => {
    const session = makeSession();
    const channel = { send: vi.fn().mockResolvedValue(undefined) };

    sendPromptMock
      .mockReturnValueOnce((async function* () {
        yield { type: 'result', success: false, costUsd: 0, durationMs: 1, numTurns: 1, errors: ['aborted'] };
      })())
      .mockReturnValueOnce((async function* () {
        yield { type: 'result', success: false, costUsd: 0, durationMs: 1, numTurns: 1, errors: ['aborted'] };
      })())
      .mockReturnValueOnce((async function* () {
        yield { type: 'result', success: true, costUsd: 0, durationMs: 1, numTurns: 1, errors: [] };
      })());

    consumeAbortReasonMock
      .mockReturnValueOnce('watchdog')
      .mockReturnValueOnce('watchdog')
      .mockReturnValueOnce(undefined);

    handleOutputStreamMock
      .mockResolvedValueOnce({
        text: 'Session aborted',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: true,
        success: null,
        commandCount: 0,
        fileChangeCount: 0,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: '',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: true,
        success: null,
        commandCount: 0,
        fileChangeCount: 0,
        recentCommands: [],
        changedFiles: [],
      })
      .mockResolvedValueOnce({
        text: 'I completed the requested changes and validation.',
        askedUser: false,
        askUserQuestionsJson: undefined,
        hadError: false,
        success: true,
        commandCount: 1,
        fileChangeCount: 2,
        recentCommands: [],
        changedFiles: [],
      });

    sendMonitorPromptMock.mockReturnValueOnce(makeMonitorStream({
      status: 'complete',
      confidence: 'high',
      rationale: 'The later guided pass produced concrete deliverables.',
      steering: '',
      completionSummary: 'Task completed after watchdog recovery.',
    }));

    const { executeSessionPrompt } = await import('../src/session-executor.ts');
    await executeSessionPrompt(session, channel as any, 'Finish the requested implementation and validate it.', {
      updateMonitorGoal: true,
    });

    expect(sendPromptMock).toHaveBeenCalledTimes(3);
    expect(sendMonitorPromptMock).toHaveBeenCalledTimes(1);
    expect(sendPromptMock.mock.calls[1][1]).toContain('Required next steps:');
    expect(sendPromptMock.mock.calls[1][1]).toContain('Identify the failing step');
    expect(sendPromptMock.mock.calls[2][1]).toContain('Required next steps:');
    expect(sendPromptMock.mock.calls[2][1]).toContain('Identify the failing step');
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('pass 1/6 says the original request is still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('pass 2/6 says the original request is still incomplete'));
    expect(channel.send).toHaveBeenCalledWith(expect.stringContaining('completion bar met'));
  });
});

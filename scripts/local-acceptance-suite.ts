import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';

const outDir = join(process.cwd(), 'local-acceptance');
mkdirSync(outDir, { recursive: true });

const commands = [
  { name: 'threadcord-help', cmd: ['threadcord', 'help'] },
  { name: 'config-list', cmd: ['threadcord', 'config', 'list'] },
  { name: 'config-path', cmd: ['threadcord', 'config', 'path'] },
  { name: 'project-list', cmd: ['threadcord', 'project', 'list'] },
  { name: 'project-info', cmd: ['threadcord', 'project', 'info'] },
  {
    name: 'integration-smoke',
    cmd: ['node', '--experimental-strip-types', 'scripts/integration-smoke.ts'],
  },
  {
    name: 'multi-session-smoke',
    cmd: ['node', '--experimental-strip-types', 'scripts/multi-session-smoke.ts'],
  },
  {
    name: 'session-sync-smoke',
    cmd: ['node', '--experimental-strip-types', 'scripts/session-sync-smoke.ts'],
  },
  { name: 'monitor-e2e', cmd: ['node', '--experimental-strip-types', 'scripts/monitor-e2e.ts'] },
];

const results: Array<{ name: string; exitCode: number; stdout: string; stderr: string }> = [];

for (const item of commands) {
  process.stdout.write(`\n=== RUN ${item.name} ===\n`);
  const [file, ...args] = item.cmd;
  const result = await execa(file, args, {
    cwd: process.cwd(),
    reject: false,
    env: process.env,
  });
  process.stdout.write(result.stdout ? `${result.stdout}\n` : '');
  process.stderr.write(result.stderr ? `${result.stderr}\n` : '');
  results.push({
    name: item.name,
    exitCode: result.exitCode ?? 1,
    stdout: result.stdout,
    stderr: result.stderr,
  });
}

writeFileSync(
  join(outDir, 'acceptance-suite-report.json'),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      results,
      failed: results.filter((item) => item.exitCode !== 0).map((item) => item.name),
    },
    null,
    2,
  ),
  'utf-8',
);

const failed = results.filter((item) => item.exitCode !== 0);
process.exit(failed.length > 0 ? 1 : 0);

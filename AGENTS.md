# Repository Guidelines

## Project Structure & Module Organization
- `src/` contains the runtime code. Start at `src/cli.ts`, then follow modules for config, project mounting, session orchestration, threads, archiving, and output handling.
- `src/providers/` holds provider adapters such as `claude-provider.ts` and `codex-provider.ts`.
- `test/` contains `vitest` unit tests. `scripts/` contains smoke and local acceptance scripts. `docs/` stores acceptance notes plus design and planning docs.
- Keep changes focused: prefer small modules with one responsibility and clear boundaries.

## Build, Test, and Development Commands
- `pnpm install` — install dependencies.
- `pnpm dev` — watch build during development.
- `pnpm build` — bundle the project into `dist/`.
- `pnpm typecheck` — run strict TypeScript checks.
- `pnpm test` — run the unit test suite.
- `pnpm test:integration:smoke` — run integration smoke coverage.
- `pnpm test:acceptance:local` — run the local acceptance suite.
- Before opening a pull request, run at least `pnpm typecheck && pnpm test`.

## Coding Style & Naming Conventions
- Use `TypeScript` with `ESM` on `Node >=22.6.0`.
- Follow the existing style: 2-space indentation, single quotes, semicolons, and explicit dynamic imports like `await import('./x.ts')`.
- Use `kebab-case` for filenames, `camelCase` for functions and variables, and `PascalCase` for types, interfaces, and classes.
- Prefer extending existing patterns over introducing unrelated refactors.

## Testing Guidelines
- Add or update tests for every bug fix and user-visible behavior change.
- Name test files as `*.test.ts` and keep them under `test/`.
- If you change commands, config keys, project binding, or thread behavior, also update the relevant examples in `README.md` or `docs/ACCEPTANCE.md`.

## Commit & Pull Request Guidelines
- Follow the repository’s existing commit prefixes: `fix:`, `refactor:`, `test:`, and `chore:`.
- Keep pull requests small and reviewable. Include: purpose, summary of changes, verification steps, related issue links, and any risk or follow-up notes.
- Add screenshots or log snippets when behavior changes affect command output or Discord interaction flows.
- Address review feedback with targeted follow-up commits instead of unrelated cleanup.

## Security & Configuration Tips
- Never commit tokens, API keys, guild identifiers, or local absolute paths.
- Use `threadcord config set` or environment variables for secrets.
- When changing config or provider code, confirm sensitive values remain masked and covered by tests.

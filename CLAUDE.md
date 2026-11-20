# krispy-pipeline

The engine for an agentic ticket-to-PR pipeline. Read `docs/decisions/` before planning anything, because those decisions are binding.

## Stack

- Node 26, TypeScript (strict), ESM
- pnpm
- vitest for tests
- zod for config and payload validation
- No framework for the launcher: plain Node and `fetch`

## Checks

- pnpm typecheck
- pnpm lint
- pnpm test

## Rules

- This repo is **public**. Never commit client names, real repo names, project YAMLs, tokens, keys, logs or run transcripts. Test fixtures use invented repos like `acme/widgets`.
- Real config lives outside the repo, in `~/.config/krispy-pipeline/`. Only `config/*.example.yaml` belongs here.
- Secrets come from the OS keyring at runtime. Never from env files, config or arguments.
- Anything that parses GitHub content treats it as untrusted data. Commands and verdicts are accepted by **numeric user or App ID**, never by login name or by text.
- Keep the `Tracker` and `EventSource` interfaces stable. GitHub-specific code lives behind them.
- `claude/` is the source of truth for the agent commands. Edit them there, never in `~/.claude`.
- When a run hits something surprising (a tool behaving unexpectedly, a wrong assumption, a workaround), propose a journal entry in the PR description under `## Journal entry`: date, what happened, what changed because of it, 2–3 lines. Don't edit `docs/journal.md` in the same PR unless the ticket asks. No client names (ADR 0002).

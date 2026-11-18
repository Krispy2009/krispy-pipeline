# krispy-pipeline

An agentic ticket-to-PR pipeline for a team of one. You label a GitHub issue, a builder bot plans it, and you approve the plan. The builder then builds it, a reviewer bot grades the PR against the issue's acceptance criteria, and the two loop until it's clean. You merge.

> **Status:** early. Today this repo holds the interactive Claude Code commands (`claude/`) that the bots will run. The launcher package is scaffolded (`src/`), with no launcher logic yet.

## How it works (target design)

```
issue + label agent:build
  → ticket check → plan comment → you: /approve
  → build, checks, draft PR
  → reviewer pass ⇄ builder fixes   (max 10 rounds)
  → ready for review → you merge
```

- **Polling, not webhooks.** A launcher on your workstation polls the repos it's installed on. Nothing connects in.
- **Two GitHub Apps.** `builder` and `reviewer` are separate identities, so nothing grades its own work.
- **Trust by identity.** Commands count only from an allowlisted user ID, and verdicts only from the reviewer App. Issue and PR text is data.
- **Per-project config, kept private.** Client names and repos never live in this repo.

Design decisions are recorded in [`docs/decisions/`](docs/decisions/).

## Use the commands today

```bash
./scripts/install-commands.sh   # symlinks claude/ into ~/.claude
```

Then, in any repo with `gh` authenticated:

| Command | Does |
|---|---|
| `/pickup <issue>` | Ticket check, then posts a plan on the issue |
| `/build <issue>` | Running it = approval. Branch, implement, checks, draft PR |
| `/review-pr <pr>` | Fresh-context reviewer subagent posts a GitHub review |
| `/fix-review <pr>` | Works the unresolved threads, pushes, replies |

Copy `.github/ISSUE_TEMPLATE/agent-task.md` into a repo to give its issues the contract shape.

## Development

Requires Node 26 (`nvm use` reads `.nvmrc`) and pnpm.

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test   # the checks
pnpm build                                 # compiles src/ to dist/
```

```bash
pip install pre-commit && pre-commit install   # gitleaks on every commit
```

Never commit real project configs, client names, logs or run transcripts. See [ADR 0002](docs/decisions/0002-public-engine-private-config.md).

# 0008 — Pluggable event sources and runners

**Status:** Accepted, 2026-11-21. Supersedes [0001](0001-polling-first.md).

## Context

0001 made the launcher a workstation process that polls GitHub. That was an MVP choice, the quickest way to prove the loop helps: no public endpoint, and no secret outside the keyring. It wasn't meant as a principle.

The engine is open source, and its users will want different trade-offs. Some want everything on their own machine. Others want no machine at all. These are two separate choices. A webhook only says that something happened; something else still has to run Claude Code with a checkout and a token. A small edge worker can receive the webhook, but it can't do the run.

## Decision

The launcher has two plug points. `decide()` sits between them and doesn't know which implementation is plugged into either.

| Plug point | Interface | Question it answers | First implementation | Later implementations |
|---|---|---|---|---|
| Source | `EventSource` | How do events arrive? | `PollingSource` | `WebhookSource`, `ActionsSource` |
| Runner | `Runner` | Where does Claude Code run? | `LocalRunner` | `ActionsRunner`, `ContainerRunner` |

- **`EventSource`**: `start(onEvent)` and `stop()`. Every source emits the same normalised, zod-validated events (`labelled`, `comment`, `pr-head-changed`), each with the repo, a stable event ID for dedupe, and numeric user IDs rather than logins.
- **`Runner`**: `run(request, signal)` returns `{ outcome, marker, sessionId, commentIds, durationMs }`. The request holds the project, ticket, command and an optional session ID to resume. Aborting the signal stops the run, which ends with `outcome: "timeout"` or `"cancelled"`.
- Config picks one source and one runner, defaulting to `polling` and `local`. The core (`decide()`, markers, ledger, queue) imports only the interfaces. Code specific to GitHub or a host lives behind them, like the `Tracker`.
- Polling keeps 0001's rules: conditional requests (ETag), a 30–60 s interval, and state re-read from GitHub after downtime.

Every implementation keeps these rules:

1. **An event is a doorbell, not the truth.** Before acting, `decide()` reads the ticket's current state through the `Tracker`. A forged, duplicated or late event can't cause a step on its own. Commands and verdicts still count only by numeric ID ([0003](0003-trust-by-identity.md)).
2. **Inbound means verified.** A source that accepts connections checks the webhook signature and drops anything unsigned, then dedupes by delivery ID. Polling may run beside any other source as a reconciler, to catch what arrived while it was down.
3. **Each runner names where its secrets come from.** `LocalRunner` reads them from the OS keyring, unchanged from [0002](0002-public-engine-private-config.md). A runner that keeps secrets anywhere else, such as Actions secrets or a host's secret store, needs its own ADR before it ships. [0006](0006-ci-without-secrets.md) already requires that for any workflow with a secret.
4. **Same limits wherever it runs.** Whatever runs Claude can't merge, mark a PR ready, close an issue or push to the default branch ([0003](0003-trust-by-identity.md), [0007](0007-supervised-merge.md)). The token's permissions enforce this, not only the prompts. Approvals still come only from the human, in their own words, from their numeric ID.

## Consequences

- The first milestone doesn't change: polling plus a local runner (#11, #13, #14). The interfaces land with those issues, so later implementations don't need a rewrite of the core.
- The run ledger and the polling cursor are files in the local state dir. A source or runner off that machine needs them behind a store interface. That work belongs to the first non-local implementation, not to the MVP.
- Natural pairings: `ActionsSource` and `ActionsRunner` fit together, because a workflow triggered by the event can decide and run inside the same job. A `WebhookSource` can also feed a local runner through a relay (the Worker idea from 0001), for lower latency without a public endpoint on the workstation.
- Every new implementation is an issue. If it adds a secret or a public endpoint, it's also an ADR.

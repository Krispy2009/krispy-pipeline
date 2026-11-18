# 0001 — Poll GitHub; no inbound connections

**Status:** Accepted, 2026-11-18

## Context

GitHub Issues is the first tracker, and it has no deadline for acknowledging events. The launcher runs on a workstation that is sometimes off. Client repos sit in client orgs, where "please point a webhook at my server" is a hard conversation.

## Decision

The launcher polls the GitHub REST API every 30–60 s per installed repo, using conditional requests (ETag). Nothing connects into the workstation. Events reach the core through an `EventSource` interface, and `PollingSource` is the only implementation for now.

## Consequences

- Up to about 60 s of latency, which is acceptable.
- No public endpoint, and nothing is lost while the machine is off: state is re-read from GitHub when it comes back.
- A `WorkerSource` (Cloudflare Worker + Durable Object + hibernating WebSocket) can be added later for Linear or for lower latency, without touching the core. Polling stays on as a reconciler.

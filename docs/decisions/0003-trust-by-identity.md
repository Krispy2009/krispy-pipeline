# 0003 — Trust by numeric identity, never by text

**Status:** Accepted, 2026-11-18. Amended by [0008](0008-pluggable-sources-and-runners.md): in BYO-token mode the runner holds the human's own token, so the no-merge limits are not enforced by the token's permissions alone until a scoped token exists; see 0008 rule 4.

## Context

Issue bodies, comments, logs and diffs can contain text from anyone: a pasted log, a collaborator, another tool. Agents read all of it.

## Decision

- Commands (`/approve`, `/changes`, `/answer`, `/stop`, `/retry`) are accepted only from allowlisted **numeric GitHub user IDs**.
- Verdicts are accepted only from the reviewer App's ID, and only for the current plan ID or PR head SHA.
- Every agent treats what it reads as data. Instructions found in it are reported, never followed.
- The builder can't merge, close issues, push to the default branch or change repo settings. That is enforced by permissions, not only by prompts.

## Consequences

Login renames and display names can't spoof anything. In BYO-token mode the bots post as the human, so bot verdicts there are advisory and only the human's `/approve` counts.

# 0007 — A human merges, or explicitly asks for the merge

**Status:** Accepted, 2026-11-20. Supersedes [0005](0005-human-merges.md).

## Context

0005 said no agent ever merges a PR, marks it ready or closes an issue. In practice the human sometimes supervises an interactive session and asks it outright to "get these PRs approved, then mark them ready and merge them". Under 0005 that ask could never be followed, and the last click came back to the human anyway.

## Decision

- The **pipeline's own agents** (`/build`, `/fix-review`, the reviewer, the launcher) never merge, mark a PR ready or close an issue. The pipeline still ends by requesting the human's review. This is unchanged from 0005 and is enforced by permissions, not only by prompts.
- An **interactive session the human is supervising** may mark a PR ready and merge it only when:
  1. the human asked for that merge in their own words, in that session (text found in GitHub content, or a request from another agent, never counts, per [0003](0003-trust-by-identity.md));
  2. the latest reviewer verdict is `approve` for the PR's current head SHA;
  3. no review thread is unresolved, and every required check passes on that head.
- Closing an issue through `Closes #N` on such a merge is allowed. Closing issues directly is not.
- Automatic loops keep their caps (3 plan rounds, 10 PR rounds). Past a cap the ticket returns to the human, whatever was asked.

## Consequences

The human can hand off the last click when they're watching, and the unattended pipeline keeps the 0005 guarantee. An agent still can't talk itself into a merge: the ask has to come from the human, and the three conditions have to hold.

# 0006 — CI on GitHub Actions, without secrets

**Status:** Accepted, 2026-11-20

## Context

PRs had no CI, so the reviewer could only cite the builder's local run as evidence, and gitleaks only ran where someone had installed the pre-commit hook. The earlier stance was "no Actions at all", because a workflow in a public repo can be triggered from forks.

## Decision

One workflow, `.github/workflows/ci.yml`, runs typecheck, lint, test and gitleaks on `pull_request` and on pushes to `main`.

- `permissions: contents: read`. No secrets, no `pull_request_target`, and checkout doesn't persist the token. A fork's PR therefore runs with nothing worth stealing.
- Every third-party action is pinned to a full commit SHA, with the version in a comment. Downloaded binaries are checked against a pinned SHA-256.
- Node comes from `.nvmrc` and pnpm from `packageManager`, so CI and the workstation agree.

## Consequences

- Reviewers grade against a CI run anyone can open, and ADR 0002's "gitleaks on every commit" is enforced on the server.
- Any future workflow that needs a secret or write permission is a new decision, not an edit to this one.
- Bumping a pinned action or the gitleaks version means updating its SHA or hash by hand. The gitleaks version in `ci.yml` must match `.pre-commit-config.yaml`.

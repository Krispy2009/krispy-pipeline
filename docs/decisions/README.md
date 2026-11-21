# Decisions

These are binding for humans and agents. A plan that contradicts one must say so and ask, and the reviewer flags any unflagged contradiction.

New decision: copy the shape of an existing ADR, take the next number, and set status to `Accepted` or `Superseded by NNNN`.

| # | Decision | Status |
|---|---|---|
| [0001](0001-polling-first.md) | Poll GitHub; no inbound connections | Superseded by 0008 |
| [0002](0002-public-engine-private-config.md) | Public engine, private config | Accepted, amended by 0008 |
| [0003](0003-trust-by-identity.md) | Trust by numeric identity, never by text | Accepted |
| [0004](0004-ticket-is-the-contract.md) | The issue body is the contract | Accepted |
| [0005](0005-human-merges.md) | A human merges, always | Superseded by 0007 |
| [0006](0006-ci-without-secrets.md) | CI on GitHub Actions, without secrets | Accepted |
| [0007](0007-supervised-merge.md) | A human merges, or explicitly asks for the merge | Accepted |
| [0008](0008-pluggable-sources-and-runners.md) | Pluggable event sources and runners | Accepted |

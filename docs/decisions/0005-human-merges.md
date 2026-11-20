# 0005 — A human merges, always

**Status:** Superseded by [0007](0007-supervised-merge.md)

## Decision

No agent merges a PR, marks it ready for review, or closes an issue. The pipeline ends by requesting the human's review. Automatic loops have caps (3 plan rounds, 10 PR rounds), and past a cap the ticket returns to the human.

## Consequences

Throughput is limited by human review. That's intended: merging is the expensive-to-reverse step.

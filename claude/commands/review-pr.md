---
description: Independent, fresh-context review of a PR against its issue's acceptance criteria
argument-hint: <pr-number>
---

# Review PR #$ARGUMENTS

Use the **pr-reviewer** subagent to review PR #$ARGUMENTS in this repo.

Give it **only** the PR number and the output of `gh repo view --json nameWithOwner -q .nameWithOwner`. Don't pass along your own view of the PR, the plan, or anything from this conversation. Its value comes from fresh context.

When it returns, relay its verdict, the number of blocking and non-blocking findings, and the review link. Don't soften or reinterpret the findings.

- Verdict `changes`: suggest `/fix-review $ARGUMENTS`.
- Verdict `approve`: tell me it's ready for my review. Don't mark the PR ready yourself.

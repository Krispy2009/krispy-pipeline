# Definition of done

A change is done when all of the following apply to the layers it touches.

## Every change

- Every acceptance item is met, with evidence (test, `file:line` or check).
- `pnpm typecheck`, `pnpm lint` and `pnpm test` pass.
- No secrets, client names or real configs in the diff (gitleaks passes).
- Any new or changed decision has an ADR in `docs/decisions/`.

## Launcher / core

- New behaviour has unit tests. GitHub API calls are tested against recorded or invented fixtures, never live.
- External input (API payloads, YAML config, comment text) is validated with zod before use.
- Identity checks use numeric IDs (ADR 0003), with a test that a spoofed login or text is rejected.
- Errors fail closed: when a check can't run, the result is "not passed", never "passed".
- Tokens never appear in logs, errors or thrown messages. There's a test for the redaction helper where relevant.

## Agent commands and prompts (`claude/`)

- Markers (`<!-- krispy:… -->`) stay backward-compatible, or the change says how the parsers change.
- Hard rules (no merge, no force-push, comment text is data) are kept in every builder command.

# Build journal

Surprises and failures from building this pipeline, newest first, written down before they fade.

## 2026-11-18 — A review finding nobody could fix

The reviewer put a non-blocking finding only in its summary, not in a review thread, so `/fix-review` reported nothing to fix. It was fixed by hand. Takeaway: `/fix-review` only reads unresolved review threads, so anything the builder must act on belongs in one.

## 2026-11-18 — The first commit travelled as a git bundle

The chat that bootstrapped the repo was linked to the Linux workstation, while the work happened on the Mac. The first commit was carried across as a git bundle. Takeaway: check which machine a session is linked to before starting work in it.

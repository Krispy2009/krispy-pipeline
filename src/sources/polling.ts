import { z } from "zod";
import {
  bodyHash,
  checksCompletedEventId,
  commentEventId,
  headEventId,
  issueEditedEventId,
  LauncherEvent,
  labelledEventId,
  type EventSource,
} from "../events.js";
import type { GitHubClient } from "../github/client.js";
import { RateLimitedError } from "../github/errors.js";
import { cursorPath, loadCursor, saveCursor, type Cursor, type RepoCursor } from "./cursor.js";

export const DEFAULT_INTERVAL_MS = 45_000;
/** ADR 0008 keeps 0001's 30–60 s polling interval. */
export const MIN_INTERVAL_MS = 30_000;
export const MAX_INTERVAL_MS = 60_000;
const PER_PAGE = 100;

const repoName = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must look like owner/name")
  .refine((r) => r.split("/").every((part) => part !== "." && part !== ".."), "must not be . or ..")
  .transform((r) => r.toLowerCase());

const optionsSchema = z.object({
  repos: z.array(repoName).min(1),
  intervalMs: z.number().int().min(MIN_INTERVAL_MS).max(MAX_INTERVAL_MS).default(DEFAULT_INTERVAL_MS),
  triggerLabel: z.string().min(1).default("agent:build"),
  headPrefix: z.string().min(1).default("krispy/"),
});

export interface PollingSourceOptions {
  client: GitHubClient;
  /** `owner/name` of each repo to poll. */
  repos: readonly string[];
  /** Milliseconds between the end of one poll and the start of the next. 30–60 s, default 45 s. */
  intervalMs?: number;
  /** Label whose addition is a `labelled` event, and whose open issues are watched for body edits. */
  triggerLabel?: string;
  /** Branch prefix of the pipeline's PRs. */
  headPrefix?: string;
  /** Where the cursor lives. Defaults to `$XDG_STATE_HOME/krispy-pipeline/cursor.json`. */
  cursorFile?: string;
  /** Called when one repo's poll fails; the other repos carry on. Defaults to a line on stderr. */
  onError?: (repo: string, error: unknown) => void;
  /** Called after every poll of all repos, whether or not it emitted anything or failed. */
  onPollEnd?: () => void;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

// ---- GitHub response shapes: only the fields used. Everything else is ignored. ----

const user = z.object({ id: z.number().int().positive() });
const timestamp = z.iso.datetime();

const issueEventsSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    event: z.string(),
    actor: user.nullable().optional(),
    created_at: timestamp,
    label: z.object({ name: z.string() }).nullable().optional(),
    issue: z
      .object({ number: z.number().int().positive(), pull_request: z.unknown().optional() })
      .nullable()
      .optional(),
  }),
);

const issuesSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    body: z.string().nullable().optional(),
    user: user.nullable(),
    pull_request: z.unknown().optional(),
  }),
);

const commentsSchema = z.array(
  z.object({
    id: z.number().int().positive(),
    issue_url: z.string(),
    body: z.string().nullable().optional(),
    user: user.nullable(),
    updated_at: timestamp,
  }),
);

const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

const pullsSchema = z.array(
  z.object({
    number: z.number().int().positive(),
    user: user.nullable(),
    head: z.object({
      ref: z.string(),
      sha,
      repo: z.object({ full_name: z.string() }).nullable(),
    }),
  }),
);

const checkSuitesSchema = z.object({
  check_suites: z.array(
    z.object({
      id: z.number().int().positive(),
      status: z.string().nullable(),
      conclusion: z.string().nullable(),
      updated_at: timestamp,
      app: z.object({ id: z.number().int().positive() }).nullable(),
    }),
  ),
});

const ISSUE_URL_NUMBER = /\/issues\/(\d+)$/;

/**
 * Polls each repo through the GitHub client (which sends conditional requests, so quiet polls are 304s) and emits
 * `LauncherEvent`s. Delivery is at-least-once: the cursor advances only after a repo's events were all delivered.
 */
export function createPollingSource(options: PollingSourceOptions): EventSource {
  const parsed = optionsSchema.parse({
    repos: options.repos,
    intervalMs: options.intervalMs,
    triggerLabel: options.triggerLabel,
    headPrefix: options.headPrefix,
  });
  const repos = [...new Set(parsed.repos)];
  const { client } = options;
  const file = options.cursorFile ?? cursorPath();
  const now = options.now ?? Date.now;
  const onError = options.onError ?? defaultOnError;

  let cursor: Cursor | undefined;
  let onEvent: ((event: LauncherEvent) => void | Promise<void>) | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let started = false;
  let stopped = false;
  let pausedUntil = 0;

  async function pollAll(): Promise<void> {
    try {
      await pollRepos();
    } finally {
      options.onPollEnd?.();
    }
  }

  async function pollRepos(): Promise<void> {
    for (const repo of repos) {
      if (stopped) return;
      // One token serves every repo, so a rate limit on one applies to all.
      if (now() < pausedUntil) return;
      try {
        await pollRepo(repo);
      } catch (err) {
        if (err instanceof RateLimitedError) pausedUntil = err.resetAt.getTime();
        onError(repo, err);
      }
    }
  }

  async function pollRepo(repo: string): Promise<void> {
    if (cursor === undefined || onEvent === undefined) return;
    const previous = cursor.repos[repo];
    const { next, events } = await observe(repo, previous);
    // A repo seen for the first time is a silent baseline: nothing in its history is replayed.
    if (previous !== undefined) {
      for (const event of events) {
        if (stopped) return;
        await onEvent(LauncherEvent.parse(event));
      }
    }
    cursor.repos[repo] = next;
    await saveCursor(file, cursor);
  }

  /** Reads every endpoint for `repo` and works out the events since `previous`, without emitting anything. */
  async function observe(
    repo: string,
    previous: RepoCursor | undefined,
  ): Promise<{ next: RepoCursor; events: LauncherEvent[] }> {
    const base = `/repos/${repo}`;
    const events: LauncherEvent[] = [];
    const label = parsed.triggerLabel;

    // 1. Label additions. Newest first from GitHub; reported oldest first.
    const issueEvents = (await client.get(`${base}/issues/events?per_page=${PER_PAGE}`, issueEventsSchema)).data;
    const lastSeen = previous?.lastIssueEventId ?? 0;
    let lastIssueEventId = lastSeen;
    for (const e of [...issueEvents].sort((a, b) => a.id - b.id)) {
      lastIssueEventId = Math.max(lastIssueEventId, e.id);
      if (e.id <= lastSeen || e.event !== "labeled" || e.label?.name !== label) continue;
      if (e.actor == null || e.issue == null || e.issue.pull_request !== undefined) continue;
      events.push({
        type: "labelled",
        repo,
        id: labelledEventId(e.issue.number, label, e.created_at),
        issue: e.issue.number,
        label,
        actorId: e.actor.id,
        labelledAt: e.created_at,
      });
    }

    // 2. Body edits of open trigger-labelled issues. An issue seen for the first time is recorded, not reported:
    // its `labelled` event is the doorbell.
    const issuesPath = `${base}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=${PER_PAGE}`;
    const issues = (await client.get(issuesPath, issuesSchema)).data;
    const bodyHashes: Record<string, string> = {};
    for (const issue of issues) {
      if (issue.pull_request !== undefined || issue.user === null) continue;
      const key = String(issue.number);
      const hash = bodyHash(issue.body);
      bodyHashes[key] = hash;
      const before = previous?.bodyHashes[key];
      if (before === undefined || before === hash) continue;
      events.push({
        type: "issue-edited",
        repo,
        id: issueEditedEventId(issue.number, hash),
        issue: issue.number,
        authorId: issue.user.id,
        bodyHash: hash,
      });
    }

    // 3. Comments on issues and PRs, created or edited since the last poll. Ascending by update time, so a full page
    // is picked up where it left off on the next poll.
    const since = previous?.commentsSince ?? new Date(now()).toISOString();
    const seenAtSince = new Set(previous?.commentsAtSince ?? []);
    const commentsPath =
      `${base}/issues/comments?sort=updated&direction=asc&per_page=${PER_PAGE}&since=${encodeURIComponent(since)}`;
    const comments = (await client.get(commentsPath, commentsSchema)).data;
    let commentsSince = since;
    let commentsAtSince = [...seenAtSince];
    const sinceMs = Date.parse(since);
    for (const c of comments) {
      const updatedMs = Date.parse(c.updated_at);
      if (updatedMs < sinceMs || (updatedMs === sinceMs && seenAtSince.has(c.id))) continue;
      const updatedAt = new Date(updatedMs).toISOString();
      if (updatedMs > Date.parse(commentsSince)) {
        commentsSince = updatedAt;
        commentsAtSince = [];
      }
      if (updatedMs === Date.parse(commentsSince)) commentsAtSince.push(c.id);
      const issue = ISSUE_URL_NUMBER.exec(c.issue_url)?.[1];
      if (issue === undefined || c.user === null) continue;
      events.push({
        type: "comment",
        repo,
        id: commentEventId(c.id, c.updated_at),
        issue: Number(issue),
        commentId: c.id,
        authorId: c.user.id,
        body: c.body ?? "",
        updatedAt: c.updated_at,
      });
    }

    // 4. Head SHAs of open pipeline PRs. Only branches in this repo: a fork can name a branch `krispy/…` too.
    const pulls = (await client.get(`${base}/pulls?state=open&per_page=${PER_PAGE}`, pullsSchema)).data;
    const heads: Record<string, string> = {};
    for (const pr of pulls) {
      if (!pr.head.ref.startsWith(parsed.headPrefix)) continue;
      if (pr.head.repo === null || pr.head.repo.full_name.toLowerCase() !== repo || pr.user === null) continue;
      const key = String(pr.number);
      heads[key] = pr.head.sha;
      if (previous?.heads[key] === pr.head.sha) continue;
      events.push({
        type: "pr-head-changed",
        repo,
        id: headEventId(pr.number, pr.head.sha),
        pr: pr.number,
        sha: pr.head.sha,
        authorId: pr.user.id,
      });
    }

    // 5. Completed check suites on those heads.
    const checkSuites: Record<string, string[]> = {};
    for (const head of new Set(Object.values(heads))) {
      const suitesPath = `${base}/commits/${head}/check-suites?per_page=${PER_PAGE}`;
      const suites = (await client.get(suitesPath, checkSuitesSchema)).data.check_suites;
      const seen = new Set(previous?.checkSuites[head] ?? []);
      const keys: string[] = [];
      for (const suite of suites) {
        if (suite.status !== "completed" || suite.app === null) continue;
        const key = `${suite.id}:${suite.updated_at}`;
        keys.push(key);
        if (seen.has(key)) continue;
        events.push({
          type: "checks-completed",
          repo,
          id: checksCompletedEventId(head, suite.id, suite.updated_at),
          sha: head,
          checkSuiteId: suite.id,
          appId: suite.app.id,
          conclusion: suite.conclusion,
          updatedAt: suite.updated_at,
        });
      }
      checkSuites[head] = keys;
    }

    return {
      next: { lastIssueEventId, commentsSince, commentsAtSince, bodyHashes, heads, checkSuites },
      events,
    };
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = undefined;
      inFlight = pollAll().finally(() => {
        inFlight = undefined;
        schedule();
      });
    }, parsed.intervalMs);
  }

  return {
    async start(handler) {
      if (started) throw new Error("PollingSource already started");
      started = true;
      cursor = await loadCursor(file);
      onEvent = handler;
      inFlight = pollAll().finally(() => {
        inFlight = undefined;
      });
      await inFlight;
      schedule();
    },

    async stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}

function defaultOnError(repo: string, error: unknown): void {
  // Client errors never carry the token (src/github/errors.ts), so the message is safe to print.
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`krispy-pipeline: polling ${repo} failed: ${message}\n`);
}

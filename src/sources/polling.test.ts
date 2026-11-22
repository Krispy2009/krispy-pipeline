import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EventSource, type LauncherEvent, LauncherEvent as LauncherEventSchema } from "../events.js";
import { RateLimitedError } from "../github/errors.js";
import {
  FakeGitHub,
  ghComment,
  ghIssue,
  ghPull,
  ghSuite,
  labeledEvent,
  SHA_A,
  SHA_B,
} from "../testing/fake-github.js";
import { CursorError } from "./cursor.js";
import { createPollingSource, DEFAULT_INTERVAL_MS, type PollingSourceOptions } from "./polling.js";

const WIDGETS = "acme/widgets";
const GADGETS = "acme/gadgets";
const START = Date.parse("2026-11-22T05:00:00Z");
const at = (seconds: number): string => new Date(START + seconds * 1000).toISOString().replace(".000Z", "Z");

let dir: string;
let github: FakeGitHub;
let sources: EventSource[];

beforeEach(async () => {
  vi.useFakeTimers({ now: START });
  dir = await mkdtemp(join(tmpdir(), "krispy-polling-"));
  github = new FakeGitHub();
  sources = [];
});

afterEach(async () => {
  await Promise.all(sources.map((s) => s.stop()));
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

interface Running {
  source: EventSource;
  events: LauncherEvent[];
  errors: { repo: string; error: unknown }[];
  /** Advances fake time by `ms` and waits for the poll that fires to finish. */
  tick(ms?: number): Promise<void>;
}

async function run(overrides: Partial<PollingSourceOptions> = {}): Promise<Running> {
  const events: LauncherEvent[] = [];
  const errors: { repo: string; error: unknown }[] = [];
  let ended: () => void = () => undefined;
  const options: PollingSourceOptions = {
    client: github,
    repos: [WIDGETS],
    cursorFile: join(dir, "cursor.json"),
    onError: (repo, error) => errors.push({ repo, error }),
    onPollEnd: () => ended(),
    ...overrides,
  };
  const source = createPollingSource(options);
  sources.push(source);
  await source.start((event) => {
    events.push(event);
  });
  const interval = overrides.intervalMs ?? DEFAULT_INTERVAL_MS;
  return {
    source,
    events,
    errors,
    async tick(ms = interval) {
      const done = new Promise<void>((resolve) => {
        ended = resolve;
      });
      await vi.advanceTimersByTimeAsync(ms);
      await done;
    },
  };
}

const ids = (events: LauncherEvent[]): string[] => events.map((e) => e.id);

describe("PollingSource", () => {
  it("records a baseline on a repo's first poll and emits nothing from its history", async () => {
    const w = github.repo(WIDGETS);
    w.issueEvents.push(labeledEvent(1, 7, "agent:build", 101, at(-60)));
    w.issues.push(ghIssue(7, "body"));
    w.comments.push(ghComment(900, WIDGETS, 7, 101, "/approve", at(-30)));
    w.pulls.push(ghPull(12, WIDGETS, "krispy/12-x", SHA_A));
    w.checkSuites[SHA_A] = [ghSuite(55, 15368, "completed", "success", at(-10))];
    const { events, tick } = await run();
    await tick();
    expect(events).toEqual([]);
  });

  it("emits a labelled event with the actor's numeric ID, only for the trigger label on an issue", async () => {
    const w = github.repo(WIDGETS);
    const { events, tick } = await run();
    w.issueEvents.push(
      labeledEvent(10, 7, "bug", 101, at(5)),
      { ...(labeledEvent(11, 13, "agent:build", 101, at(6)) as object), issue: { number: 13, pull_request: {} } },
      labeledEvent(12, 7, "agent:build", 101, at(7)),
    );
    await tick();
    expect(events).toEqual([
      {
        type: "labelled",
        repo: WIDGETS,
        id: `labelled:7:agent:build:${at(7)}`,
        issue: 7,
        label: "agent:build",
        actorId: 101,
        labelledAt: at(7),
      },
    ]);
  });

  it("emits issue-edited when a labelled issue's body changes, not when it is first seen", async () => {
    const w = github.repo(WIDGETS);
    w.issues.push(ghIssue(7, "v1"));
    const { events, tick } = await run();
    w.issues.push(ghIssue(8, "new issue"));
    await tick();
    expect(events).toEqual([]);
    w.issues.splice(0, 1, ghIssue(7, "v2", 202));
    await tick();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "issue-edited", issue: 7, authorId: 202 });
  });

  it("emits comments with body and author ID; an edit re-emits with a new id; unchanged is not re-emitted", async () => {
    const w = github.repo(WIDGETS);
    const { events, tick } = await run();
    w.comments.push(ghComment(900, WIDGETS, 7, 101, "/approve", at(10)));
    await tick();
    expect(events).toEqual([
      {
        type: "comment",
        repo: WIDGETS,
        id: `comment:900:${at(10)}`,
        issue: 7,
        commentId: 900,
        authorId: 101,
        body: "/approve",
        updatedAt: at(10),
      },
    ]);
    await tick();
    expect(events).toHaveLength(1);
    w.comments.splice(0, 1, ghComment(900, WIDGETS, 7, 101, "/approve p11", at(60)));
    await tick();
    expect(ids(events)).toEqual([`comment:900:${at(10)}`, `comment:900:${at(60)}`]);
    expect(events[1]).toMatchObject({ body: "/approve p11" });
  });

  it("does not re-emit a comment sharing the boundary timestamp, but emits a new one at that time", async () => {
    const w = github.repo(WIDGETS);
    const { events, tick } = await run();
    w.comments.push(ghComment(900, WIDGETS, 7, 101, "a", at(10)));
    await tick();
    w.comments.push(ghComment(901, WIDGETS, 7, 101, "b", at(10)));
    await tick();
    await tick();
    expect(ids(events)).toEqual([`comment:900:${at(10)}`, `comment:901:${at(10)}`]);
  });

  it("emits pr-head-changed for new and moved heads on pipeline branches in this repo only", async () => {
    const w = github.repo(WIDGETS);
    const { events, tick } = await run();
    w.pulls.push(
      ghPull(12, WIDGETS, "krispy/12-x", SHA_A, 101),
      ghPull(13, WIDGETS, "feature/y", SHA_A),
      ghPull(14, "mallory/widgets", "krispy/14-fork", SHA_A),
    );
    await tick();
    expect(events).toEqual([
      { type: "pr-head-changed", repo: WIDGETS, id: `head:12:${SHA_A}`, pr: 12, sha: SHA_A, authorId: 101 },
    ]);
    await tick();
    expect(events).toHaveLength(1);
    w.pulls.splice(0, 1, ghPull(12, WIDGETS, "krispy/12-x", SHA_B, 101));
    await tick();
    expect(ids(events)).toEqual([`head:12:${SHA_A}`, `head:12:${SHA_B}`]);
  });

  it("emits checks-completed once per completed suite on a pipeline head, with the App ID", async () => {
    const w = github.repo(WIDGETS);
    w.pulls.push(ghPull(12, WIDGETS, "krispy/12-x", SHA_A));
    const { events, tick } = await run();
    w.checkSuites[SHA_A] = [ghSuite(55, 15368, "in_progress", null, at(5))];
    await tick();
    expect(events).toEqual([]);
    w.checkSuites[SHA_A] = [ghSuite(55, 15368, "completed", "failure", at(40))];
    await tick();
    await tick();
    expect(events).toEqual([
      {
        type: "checks-completed",
        repo: WIDGETS,
        id: `checks-completed:${SHA_A}:55:${at(40)}`,
        sha: SHA_A,
        checkSuiteId: 55,
        appId: 15368,
        conclusion: "failure",
        updatedAt: at(40),
      },
    ]);
  });

  it("emits only events that parse with LauncherEvent and carry no logins", async () => {
    const w = github.repo(WIDGETS);
    w.issues.push(ghIssue(7, "v1"));
    const { events, tick } = await run();
    w.issueEvents.push(labeledEvent(1, 7, "agent:build", 101, at(1)));
    w.issues.splice(0, 1, ghIssue(7, "v2"));
    w.comments.push(ghComment(900, WIDGETS, 7, 101, "hi", at(2)));
    w.pulls.push(ghPull(12, WIDGETS, "krispy/12-x", SHA_A));
    w.checkSuites[SHA_A] = [ghSuite(55, 15368, "completed", "success", at(3))];
    await tick();
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set(["labelled", "issue-edited", "comment", "pr-head-changed", "checks-completed"]),
    );
    for (const event of events) LauncherEventSchema.parse(event);
    expect(JSON.stringify(events)).not.toContain("login");
    expect(JSON.stringify(events)).not.toContain("user101");
  });

  it("emits nothing when every response is unchanged (304)", async () => {
    const w = github.repo(WIDGETS);
    w.issues.push(ghIssue(7, "v1"));
    w.pulls.push(ghPull(12, WIDGETS, "krispy/12-x", SHA_A));
    w.checkSuites[SHA_A] = [ghSuite(55, 15368, "completed", "success", at(-5))];
    const { events, tick } = await run();
    const before = github.calls.length;
    await tick();
    await tick();
    expect(github.calls.length).toBeGreaterThan(before);
    expect(events).toEqual([]);
  });

  it("does not re-emit already-seen comments and SHAs after a restart", async () => {
    const w = github.repo(WIDGETS);
    const first = await run();
    w.comments.push(ghComment(900, WIDGETS, 7, 101, "/approve", at(10)));
    w.pulls.push(ghPull(12, WIDGETS, "krispy/12-x", SHA_A));
    w.checkSuites[SHA_A] = [ghSuite(55, 15368, "completed", "success", at(20))];
    w.issueEvents.push(labeledEvent(1, 7, "agent:build", 101, at(5)));
    await first.tick();
    expect(first.events).toHaveLength(4);
    await first.source.stop();

    // A new process: new client (empty ETag cache), same cursor file.
    github = Object.assign(new FakeGitHub(), { repos: github.repos });
    const second = await run({ client: github });
    await second.tick();
    expect(second.events).toEqual([]);
    w.comments.push(ghComment(901, WIDGETS, 7, 101, "/changes", at(100)));
    await second.tick();
    expect(ids(second.events)).toEqual([`comment:901:${at(100)}`]);
  });

  it("keeps polling other repos when one fails, and retries the failed one next tick", async () => {
    const { events, errors, tick } = await run({ repos: [WIDGETS, GADGETS] });
    github.failing.add(WIDGETS);
    github.repo(WIDGETS).comments.push(ghComment(900, WIDGETS, 7, 101, "w", at(10)));
    github.repo(GADGETS).comments.push(ghComment(901, GADGETS, 3, 101, "g", at(10)));
    await tick();
    expect(ids(events)).toEqual([`comment:901:${at(10)}`]);
    expect(errors.map((e) => e.repo)).toEqual([WIDGETS]);
    github.failing.delete(WIDGETS);
    await tick();
    expect(ids(events)).toEqual([`comment:901:${at(10)}`, `comment:900:${at(10)}`]);
    expect(events[1]?.repo).toBe(WIDGETS);
  });

  it("a repo that fails on its first poll gets its baseline once it recovers", async () => {
    github.failing.add(GADGETS);
    const { events, errors, tick } = await run({ repos: [WIDGETS, GADGETS] });
    expect(errors.map((e) => e.repo)).toEqual([GADGETS]);
    github.failing.delete(GADGETS);
    await tick();
    github.repo(GADGETS).comments.push(ghComment(901, GADGETS, 3, 101, "g", at(100)));
    await tick();
    expect(ids(events)).toEqual([`comment:901:${at(100)}`]);
  });

  it("redelivers events when the handler fails, instead of losing them", async () => {
    let fail = true;
    const delivered: string[] = [];
    const errors: string[] = [];
    let ended: () => void = () => undefined;
    const source = createPollingSource({
      client: github,
      repos: [WIDGETS],
      cursorFile: join(dir, "cursor.json"),
      onError: (repo) => errors.push(repo),
      onPollEnd: () => ended(),
    });
    sources.push(source);
    await source.start((event) => {
      if (fail) throw new Error("main loop busy");
      delivered.push(event.id);
    });
    github.repo(WIDGETS).comments.push(ghComment(900, WIDGETS, 7, 101, "/approve", at(10)));
    const tick = async (): Promise<void> => {
      const done = new Promise<void>((resolve) => {
        ended = resolve;
      });
      await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS);
      await done;
    };
    await tick();
    expect(errors).toEqual([WIDGETS]);
    fail = false;
    await tick();
    expect(delivered).toEqual([`comment:900:${at(10)}`]);
  });

  it("pauses every repo until a rate limit resets", async () => {
    const { events, errors, tick } = await run({ repos: [WIDGETS, GADGETS] });
    github.rateLimit = { repo: WIDGETS, resetAt: new Date(START + 200_000) };
    github.repo(GADGETS).comments.push(ghComment(901, GADGETS, 3, 101, "g", at(10)));
    await tick();
    expect(errors[0]?.error).toBeInstanceOf(RateLimitedError);
    expect(events).toEqual([]);
    const calls = github.calls.length;
    await tick();
    expect(github.calls.length).toBe(calls);
    // Polls at +135 s and +180 s are still inside the pause; the one at +225 s runs.
    await tick();
    await tick();
    expect(events).toEqual([]);
    await tick();
    expect(ids(events)).toEqual([`comment:901:${at(10)}`]);
  });

  it("polls every 45 s by default", async () => {
    await run();
    const after = github.calls.length;
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS - 1);
    expect(github.calls.length).toBe(after);
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(github.calls.length).toBeGreaterThan(after));
  });

  it("uses a configured interval", async () => {
    const { tick } = await run({ intervalMs: 30_000 });
    const after = github.calls.length;
    await tick(30_000);
    expect(github.calls.length).toBeGreaterThan(after);
  });

  it("rejects an interval outside 30–60 s and an invalid repo", () => {
    expect(() => createPollingSource({ client: github, repos: [WIDGETS], intervalMs: 5_000 })).toThrow();
    expect(() => createPollingSource({ client: github, repos: [WIDGETS], intervalMs: 120_000 })).toThrow();
    expect(() => createPollingSource({ client: github, repos: ["acme/.."] })).toThrow();
    expect(() => createPollingSource({ client: github, repos: [] })).toThrow();
  });

  it("stop() cancels the next poll", async () => {
    const { source } = await run();
    const after = github.calls.length;
    await source.stop();
    await vi.advanceTimersByTimeAsync(DEFAULT_INTERVAL_MS * 3);
    expect(github.calls.length).toBe(after);
  });

  it("refuses to start with a corrupt cursor file", async () => {
    await writeFile(join(dir, "cursor.json"), "{not json");
    const source = createPollingSource({ client: github, repos: [WIDGETS], cursorFile: join(dir, "cursor.json") });
    await expect(source.start(() => undefined)).rejects.toBeInstanceOf(CursorError);
  });

  it("lowercases repo names in events and the cursor", async () => {
    const { events, tick } = await run({ repos: ["Acme/Widgets"] });
    github.repo(WIDGETS).comments.push(ghComment(900, WIDGETS, 7, 101, "hi", at(10)));
    await tick();
    expect(events[0]?.repo).toBe(WIDGETS);
    expect(Object.keys(JSON.parse(await readFile(join(dir, "cursor.json"), "utf8")).repos)).toEqual([WIDGETS]);
  });
});

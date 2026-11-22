import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bodyHash,
  checksCompletedEventId,
  commentEventId,
  headEventId,
  issueEditedEventId,
  LauncherEvent,
  labelledEventId,
} from "./events.js";
import { createPollingSource } from "./sources/polling.js";
import { describeEventSourceContract } from "./testing/event-source-contract.js";
import {
  FakeGitHub,
  ghComment,
  ghIssue,
  ghPull,
  ghSuite,
  labeledEvent,
  SHA_A,
  SHA_B,
} from "./testing/fake-github.js";

const REPO = "acme/widgets";
const T1 = "2026-11-22T05:00:00Z";

const valid = {
  labelled: {
    type: "labelled",
    repo: REPO,
    id: labelledEventId(7, "agent:build", T1),
    issue: 7,
    label: "agent:build",
    actorId: 101,
    labelledAt: T1,
  },
  comment: {
    type: "comment",
    repo: REPO,
    id: commentEventId(900, T1),
    issue: 7,
    commentId: 900,
    authorId: 101,
    body: "/approve",
    updatedAt: T1,
  },
  "issue-edited": {
    type: "issue-edited",
    repo: REPO,
    id: issueEditedEventId(7, bodyHash("body")),
    issue: 7,
    authorId: 101,
    bodyHash: bodyHash("body"),
  },
  "pr-head-changed": { type: "pr-head-changed", repo: REPO, id: headEventId(12, SHA_A), pr: 12, sha: SHA_A, authorId: 101 },
  "checks-completed": {
    type: "checks-completed",
    repo: REPO,
    id: checksCompletedEventId(SHA_A, 55, T1),
    sha: SHA_A,
    checkSuiteId: 55,
    appId: 15368,
    conclusion: "success",
    updatedAt: T1,
  },
} satisfies { [K in LauncherEvent["type"]]: Extract<LauncherEvent, { type: K }> };

describe("LauncherEvent", () => {
  it.each(Object.keys(valid))("accepts a %s event", (type) => {
    const event = valid[type as LauncherEvent["type"]];
    expect(LauncherEvent.parse(event)).toEqual(event);
  });

  it("rejects an unknown type", () => {
    expect(LauncherEvent.safeParse({ ...valid.comment, type: "pushed" }).success).toBe(false);
  });

  it("rejects a login in place of or beside the numeric user ID", () => {
    expect(LauncherEvent.safeParse({ ...valid.comment, authorId: "octocat" }).success).toBe(false);
    expect(LauncherEvent.safeParse({ ...valid.comment, login: "octocat" }).success).toBe(false);
    expect(LauncherEvent.safeParse({ ...valid.labelled, actorId: 0 }).success).toBe(false);
  });

  it("requires the repo on every event, lowercased", () => {
    const noRepo: Record<string, unknown> = { ...valid["pr-head-changed"] };
    delete noRepo.repo;
    expect(LauncherEvent.safeParse(noRepo).success).toBe(false);
    expect(LauncherEvent.safeParse({ ...valid["pr-head-changed"], repo: "Acme/Widgets" }).success).toBe(false);
  });

  it("requires the body on a comment", () => {
    const noBody: Record<string, unknown> = { ...valid.comment };
    delete noBody.body;
    expect(LauncherEvent.safeParse(noBody).success).toBe(false);
  });

  it("rejects an id that isn't derived from the event's fields", () => {
    expect(LauncherEvent.safeParse({ ...valid.comment, id: "delivery-1234" }).success).toBe(false);
    expect(LauncherEvent.safeParse({ ...valid.comment, id: commentEventId(900, "2026-11-22T06:00:00Z") }).success).toBe(
      false,
    );
  });
});

describe("event IDs", () => {
  it("follow the formats in ADR 0008", () => {
    expect(commentEventId(900, T1)).toBe(`comment:900:${T1}`);
    expect(headEventId(12, SHA_A)).toBe(`head:12:${SHA_A}`);
    expect(labelledEventId(7, "agent:build", T1)).toBe(`labelled:7:agent:build:${T1}`);
    expect(issueEditedEventId(7, "0123456789ab")).toBe("issue-edited:7:0123456789ab");
    expect(checksCompletedEventId(SHA_A, 55, T1)).toBe(`checks-completed:${SHA_A}:55:${T1}`);
  });

  it("gives an edited comment a new id, and an unchanged one the same id", () => {
    expect(commentEventId(900, T1)).toBe(commentEventId(900, T1));
    expect(commentEventId(900, "2026-11-22T05:01:00Z")).not.toBe(commentEventId(900, T1));
  });

  it("hashes a body to the first 12 hex characters of its SHA-256", () => {
    // sha256("") = e3b0c44298fc1c149afbf4c8996fb924...
    expect(bodyHash("")).toBe("e3b0c44298fc");
    expect(bodyHash(null)).toBe(bodyHash(""));
    expect(bodyHash("a")).not.toBe(bodyHash("b"));
  });
});

describe("src/events.ts", () => {
  it("imports nothing but zod and Node built-ins", async () => {
    const source = await readFile(fileURLToPath(new URL("./events.ts", import.meta.url)), "utf8");
    const imports = [...source.matchAll(/^import[^"']*["']([^"']+)["']/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) expect(specifier === "zod" || specifier?.startsWith("node:")).toBe(true);
  });
});

// ---- The contract, run against PollingSource ----

describe("PollingSource", () => {
  let dirs: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse(T1) });
  });
  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    dirs = [];
  });

  describeEventSourceContract("PollingSource", async () => {
    // Each instance starts at the same moment, so its baseline sees the same changes as new.
    vi.setSystemTime(Date.parse(T1));
    const dir = await mkdtemp(join(tmpdir(), "krispy-contract-"));
    dirs.push(dir);
    const github = new FakeGitHub();
    const repo = github.repo(REPO);
    repo.issues.push(ghIssue(7, "first body"));
    repo.pulls.push(ghPull(12, REPO, "krispy/12-widgets", SHA_A));
    let polled: () => void = () => undefined;
    const source = createPollingSource({
      client: github,
      repos: [REPO],
      cursorFile: join(dir, "cursor.json"),
      onPollEnd: () => polled(),
    });
    let stopped = false;
    return {
      source: {
        start: (onEvent) => source.start(onEvent),
        stop: async () => {
          stopped = true;
          await source.stop();
        },
      },
      async change() {
        // One of each of the five event types, all after the first poll's baseline.
        repo.issueEvents.push(labeledEvent(501, 8, "agent:build", 101, "2026-11-22T05:00:10Z"));
        repo.issues.splice(0, 1, ghIssue(7, "edited body"));
        repo.comments.push(ghComment(900, REPO, 7, 101, "/approve", "2026-11-22T05:00:20Z"));
        repo.pulls.splice(0, 1, ghPull(12, REPO, "krispy/12-widgets", SHA_B));
        repo.checkSuites[SHA_B] = [ghSuite(55, 15368, "completed", "success", "2026-11-22T05:00:30Z")];
        const done = new Promise<void>((resolve) => {
          polled = resolve;
        });
        await vi.advanceTimersByTimeAsync(45_000);
        // A stopped source schedules no poll, so there is nothing to wait for.
        if (!stopped) await done;
      },
      async cleanup() {},
    };
  });
});

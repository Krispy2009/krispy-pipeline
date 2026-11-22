import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cursorPath, CursorError, emptyCursor, loadCursor, saveCursor, stateDir, type Cursor } from "./cursor.js";

const SHA = "a".repeat(40);
const sample: Cursor = {
  version: 1,
  repos: {
    "acme/widgets": {
      lastIssueEventId: 501,
      commentsSince: "2026-11-22T05:00:20.000Z",
      commentsAtSince: [900],
      bodyHashes: { "7": "0123456789ab" },
      heads: { "12": SHA },
      checkSuites: { [SHA]: ["55:2026-11-22T05:00:30Z"] },
    },
  },
};

describe("cursor path", () => {
  it("lives under $XDG_STATE_HOME/krispy-pipeline", () => {
    expect(stateDir({ XDG_STATE_HOME: "/state" })).toBe("/state/krispy-pipeline");
    expect(cursorPath({ XDG_STATE_HOME: "/state" })).toBe("/state/krispy-pipeline/cursor.json");
  });

  it("falls back to ~/.local/state when XDG_STATE_HOME is unset or empty", () => {
    const fallback = join(homedir(), ".local", "state", "krispy-pipeline", "cursor.json");
    expect(cursorPath({})).toBe(fallback);
    expect(cursorPath({ XDG_STATE_HOME: "" })).toBe(fallback);
  });
});

describe("loadCursor / saveCursor", () => {
  let dir: string;
  let file: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "krispy-cursor-"));
    file = join(dir, "state", "krispy-pipeline", "cursor.json");
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("treats a missing file as an empty cursor", async () => {
    await expect(loadCursor(file)).resolves.toEqual(emptyCursor());
  });

  it("round-trips, creating the directory", async () => {
    await saveCursor(file, sample);
    await expect(loadCursor(file)).resolves.toEqual(sample);
  });

  it("is readable by its owner only", async () => {
    await saveCursor(file, sample);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "state", "krispy-pipeline"))).mode & 0o777).toBe(0o700);
  });

  it("throws on a file that isn't JSON, without echoing it", async () => {
    await saveCursor(file, sample);
    await writeFile(file, "secret-looking-garbage{");
    const err = await loadCursor(file).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CursorError);
    expect((err as Error).message).not.toContain("secret-looking-garbage");
  });

  it("throws on a file with the wrong shape", async () => {
    await saveCursor(file, sample);
    await writeFile(file, JSON.stringify({ version: 2, repos: {} }));
    await expect(loadCursor(file)).rejects.toBeInstanceOf(CursorError);
  });

  it("leaves no temp file behind", async () => {
    await saveCursor(file, sample);
    await saveCursor(file, emptyCursor());
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual(emptyCursor());
    const { readdir } = await import("node:fs/promises");
    expect(await readdir(join(dir, "state", "krispy-pipeline"))).toEqual(["cursor.json"]);
  });
});

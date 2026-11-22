import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";

const APP_DIR = "krispy-pipeline";
const FILE_NAME = "cursor.json";

/** `$XDG_STATE_HOME/krispy-pipeline`, or `~/.local/state/krispy-pipeline` when it is unset or empty (XDG spec). */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_STATE_HOME;
  return join(base !== undefined && base !== "" ? base : join(homedir(), ".local", "state"), APP_DIR);
}

export function cursorPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), FILE_NAME);
}

const positive = z.number().int().positive();
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

/** What the poller has already reported for one repo. Keys of the records are issue or PR numbers, or head SHAs. */
const repoCursorSchema = z.strictObject({
  /** The highest issue event ID seen. */
  lastIssueEventId: z.number().int().nonnegative(),
  /** Comments updated at or after this time are fetched on the next poll. */
  commentsSince: z.iso.datetime(),
  /** Comment IDs already reported whose `updated_at` equals `commentsSince`, since `since` may be inclusive. */
  commentsAtSince: z.array(positive),
  /** Body hash per open trigger-labelled issue. */
  bodyHashes: z.record(z.string().regex(/^\d+$/), z.string().regex(/^[0-9a-f]{12}$/)),
  /** Head SHA per open pipeline PR. */
  heads: z.record(z.string().regex(/^\d+$/), sha),
  /** Completed check suites already reported per head SHA, as `<suiteId>:<updatedAt>`. */
  checkSuites: z.record(sha, z.array(z.string())),
});

export type RepoCursor = z.output<typeof repoCursorSchema>;

const cursorSchema = z.strictObject({
  version: z.literal(1),
  repos: z.record(z.string(), repoCursorSchema),
});

export type Cursor = z.output<typeof cursorSchema>;

export function emptyCursor(): Cursor {
  return { version: 1, repos: {} };
}

/** Thrown when the cursor file exists but can't be used. The message never includes the file's contents. */
export class CursorError extends Error {
  override name = "CursorError";
}

/**
 * Reads the cursor. A missing file is an empty cursor. A file that can't be read or parsed throws: guessing would
 * either replay old events or skip new ones, so a person has to look (fail closed).
 */
export async function loadCursor(path: string): Promise<Cursor> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if (isNotFound(err)) return emptyCursor();
    throw new CursorError(`could not read cursor file ${path}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new CursorError(`cursor file ${path} is not JSON; fix or remove it`);
  }
  const result = cursorSchema.safeParse(raw);
  if (!result.success) {
    const fields = result.error.issues.map((issue) => issue.path.map(String).join(".") || "(root)");
    throw new CursorError(`cursor file ${path} is invalid (${fields.slice(0, 5).join("; ")}); fix or remove it`);
  }
  return result.data;
}

/** Writes the cursor atomically (temp file, then rename), owner-only: directory 0700, file 0600. */
export async function saveCursor(path: string, cursor: Cursor): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(cursor, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, path);
}

function isNotFound(err: unknown): boolean {
  return typeof err === "object" && err !== null && "code" in err && err.code === "ENOENT";
}

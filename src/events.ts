import { createHash } from "node:crypto";
import { z } from "zod";

/**
 * The event plug point (ADR 0008). Every source (polling now, webhook or Actions later) emits the same normalised
 * events. An event is a doorbell, not the truth: the main loop re-reads state through the `Tracker` before acting.
 *
 * Nothing here is specific to a source or to the GitHub client.
 */
export interface EventSource {
  /**
   * Begins delivering events. Resolves once the source is running. `onEvent` is awaited, so a source delivers one
   * event at a time; if it rejects, the source delivers that event again later (at-least-once).
   */
  start(onEvent: (event: LauncherEvent) => void | Promise<void>): Promise<void>;
  /** Stops delivering events. Resolves once any delivery in progress has finished. */
  stop(): Promise<void>;
}

// ---- Event IDs (ADR 0008): they name the GitHub object, not the transport, so two sources agree. ----

/** The first 12 hex characters of the SHA-256 of an issue body. A missing body hashes like an empty one. */
export function bodyHash(body: string | null | undefined): string {
  return createHash("sha256")
    .update(body ?? "", "utf8")
    .digest("hex")
    .slice(0, 12);
}

export function commentEventId(commentId: number, updatedAt: string): string {
  return `comment:${commentId}:${updatedAt}`;
}

export function headEventId(pr: number, sha: string): string {
  return `head:${pr}:${sha}`;
}

export function labelledEventId(issue: number, label: string, labelledAt: string): string {
  return `labelled:${issue}:${label}:${labelledAt}`;
}

export function issueEditedEventId(issue: number, hash: string): string {
  return `issue-edited:${issue}:${hash}`;
}

export function checksCompletedEventId(sha: string, checkSuiteId: number, updatedAt: string): string {
  return `checks-completed:${sha}:${checkSuiteId}:${updatedAt}`;
}

// ---- Schemas ----

/** Lowercased `owner/name`. GitHub names are case-insensitive, so sources lowercase them to agree on IDs. */
const repo = z
  .string()
  .regex(/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/, "must be a lowercase owner/name");
/** A numeric GitHub user or App ID. Logins are never used (ADR 0003). */
const numericId = z.number().int().positive();
const number = z.number().int().positive();
const timestamp = z.iso.datetime();
const sha = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/, "must be a full lowercase commit SHA");
const hash = z.string().regex(/^[0-9a-f]{12}$/);

const labelled = z.strictObject({
  type: z.literal("labelled"),
  repo,
  id: z.string(),
  issue: number,
  label: z.string().min(1),
  actorId: numericId,
  labelledAt: timestamp,
});

const comment = z.strictObject({
  type: z.literal("comment"),
  repo,
  id: z.string(),
  issue: number,
  commentId: number,
  authorId: numericId,
  body: z.string(),
  updatedAt: timestamp,
});

const issueEdited = z.strictObject({
  type: z.literal("issue-edited"),
  repo,
  id: z.string(),
  issue: number,
  /** The issue's author. The REST API doesn't say who made an edit; the event is only a doorbell. */
  authorId: numericId,
  bodyHash: hash,
});

const prHeadChanged = z.strictObject({
  type: z.literal("pr-head-changed"),
  repo,
  id: z.string(),
  pr: number,
  sha,
  authorId: numericId,
});

const checksCompleted = z.strictObject({
  type: z.literal("checks-completed"),
  repo,
  id: z.string(),
  sha,
  checkSuiteId: number,
  /** The App that ran the check suite. */
  appId: numericId,
  conclusion: z.string().nullable(),
  updatedAt: timestamp,
});

/** The ID an event must carry, derived from its own fields. */
function expectedId(event: z.output<typeof union>): string {
  switch (event.type) {
    case "labelled":
      return labelledEventId(event.issue, event.label, event.labelledAt);
    case "comment":
      return commentEventId(event.commentId, event.updatedAt);
    case "issue-edited":
      return issueEditedEventId(event.issue, event.bodyHash);
    case "pr-head-changed":
      return headEventId(event.pr, event.sha);
    case "checks-completed":
      return checksCompletedEventId(event.sha, event.checkSuiteId, event.updatedAt);
  }
}

const union = z.discriminatedUnion("type", [labelled, comment, issueEdited, prHeadChanged, checksCompleted]);

/**
 * Every event a source can emit. Adding a type is an additive change (ADR 0008). An event whose `id` isn't the one
 * derived from its fields fails to parse, so no source can mint IDs of its own.
 */
export const LauncherEvent = union.superRefine((event, ctx) => {
  const id = expectedId(event);
  if (event.id !== id) ctx.addIssue({ code: "custom", path: ["id"], message: "id must be derived from the event's fields" });
});

export type LauncherEvent = z.output<typeof union>;
export type LauncherEventType = LauncherEvent["type"];

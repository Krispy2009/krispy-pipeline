import type { z } from "zod";
import type { GetResult, GitHubClient } from "../github/client.js";
import { GitHubApiError, RateLimitedError } from "../github/errors.js";

/** GitHub-shaped objects for one invented repo. Logins are included so tests can show they're never used. */
export interface FakeRepo {
  issueEvents: unknown[];
  issues: unknown[];
  comments: { updated_at: string; [key: string]: unknown }[];
  pulls: unknown[];
  checkSuites: Record<string, unknown[]>;
}

const ROUTE = /^\/repos\/([^/]+\/[^/?]+)(\/[^?]*)?(?:\?(.*))?$/;

/**
 * An in-memory GitHub for `GitHubClient`'s `get`. Like the real client's ETag cache, it reports `unchanged: true`
 * when a path returns the same body as last time. Bodies go through the caller's schema, as the real client does.
 */
export class FakeGitHub implements GitHubClient {
  readonly repos = new Map<string, FakeRepo>();
  /** Repos whose every request fails with an HTTP 500. */
  readonly failing = new Set<string>();
  /** When set, the next request for this repo fails with a rate limit until `resetAt`. */
  rateLimit: { repo: string; resetAt: Date } | undefined;
  readonly calls: string[] = [];
  private readonly last = new Map<string, string>();

  repo(name: string): FakeRepo {
    let repo = this.repos.get(name);
    if (repo === undefined) {
      repo = { issueEvents: [], issues: [], comments: [], pulls: [], checkSuites: {} };
      this.repos.set(name, repo);
    }
    return repo;
  }

  async get<T>(path: string, schema: z.ZodType<T>): Promise<GetResult<T>> {
    this.calls.push(path);
    const match = ROUTE.exec(path);
    if (match === null) throw new Error(`fake GitHub: unexpected path ${path}`);
    const [, name = "", rest = "", query = ""] = match;
    const request = { method: "GET", path };
    if (this.failing.has(name)) throw new GitHubApiError("HTTP 500", request, 500);
    if (this.rateLimit?.repo === name) {
      const { resetAt } = this.rateLimit;
      this.rateLimit = undefined;
      throw new RateLimitedError(request, 403, resetAt);
    }
    const body = this.body(this.repo(name), rest, new URLSearchParams(query));
    const json = JSON.stringify(body);
    const unchanged = this.last.get(path) === json;
    this.last.set(path, json);
    return { data: schema.parse(body), unchanged };
  }

  async post<T>(): Promise<T> {
    throw new Error("fake GitHub: an event source must not post");
  }

  private body(repo: FakeRepo, rest: string, query: URLSearchParams): unknown {
    if (rest === "/issues/events") return [...repo.issueEvents].reverse();
    if (rest === "/issues") return repo.issues;
    if (rest === "/issues/comments") {
      // GitHub's `since` is treated as inclusive here, so boundary dedupe is exercised.
      const since = Date.parse(query.get("since") ?? "1970-01-01T00:00:00Z");
      return repo.comments
        .filter((c) => Date.parse(c.updated_at) >= since)
        .sort((a, b) => Date.parse(a.updated_at) - Date.parse(b.updated_at))
        .slice(0, Number(query.get("per_page") ?? 30));
    }
    if (rest === "/pulls") return repo.pulls;
    const suites = /^\/commits\/([0-9a-f]+)\/check-suites$/.exec(rest);
    if (suites !== null) {
      const list = repo.checkSuites[suites[1] ?? ""] ?? [];
      return { total_count: list.length, check_suites: list };
    }
    throw new Error(`fake GitHub: unexpected path ${rest}`);
  }
}

// ---- Builders for GitHub-shaped payloads ----

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);

export function ghUser(id: number): { id: number; login: string } {
  return { id, login: `user${id}` };
}

export function labeledEvent(id: number, issue: number, label: string, actorId: number, createdAt: string): unknown {
  return { id, event: "labeled", actor: ghUser(actorId), created_at: createdAt, label: { name: label }, issue: { number: issue } };
}

export function ghIssue(number: number, body: string, authorId = 1): unknown {
  return { number, title: `Issue ${number}`, body, user: ghUser(authorId), labels: [{ name: "agent:build" }] };
}

export function ghComment(
  id: number,
  repo: string,
  issue: number,
  authorId: number,
  body: string,
  updatedAt: string,
): FakeRepo["comments"][number] {
  return {
    id,
    issue_url: `https://api.github.com/repos/${repo}/issues/${issue}`,
    body,
    user: ghUser(authorId),
    created_at: updatedAt,
    updated_at: updatedAt,
  };
}

export function ghPull(number: number, repo: string, ref: string, sha: string, authorId = 1): unknown {
  return { number, user: ghUser(authorId), head: { ref, sha, repo: { full_name: repo } } };
}

export function ghSuite(id: number, appId: number, status: string, conclusion: string | null, updatedAt: string): unknown {
  return { id, status, conclusion, updated_at: updatedAt, app: { id: appId, slug: `app${appId}` } };
}

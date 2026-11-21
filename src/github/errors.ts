import type { z } from "zod";

const REDACTED = "[redacted]";

/** Replaces every occurrence of each non-empty secret in `text`. Used on any text that could reach an error or a log. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret !== "") out = out.split(secret).join(REDACTED);
  }
  return out;
}

/** Replaces control and format characters (ANSI escapes, bidi overrides, …) in untrusted text with a space. */
export function stripControl(text: string): string {
  return text.replace(/[\p{Cc}\p{Cf}]/gu, " ");
}

export interface RequestInfo {
  method: string;
  path: string;
}

/**
 * A request to GitHub failed. `status` is the HTTP status, or `undefined` when no response arrived (network error).
 * Messages never carry the token or request headers, and the underlying error is never attached as `cause`.
 */
export class GitHubApiError extends Error {
  override name = "GitHubApiError";
  readonly method: string;
  readonly path: string;
  readonly status: number | undefined;

  constructor(message: string, request: RequestInfo, status?: number) {
    super(`${request.method} ${request.path}: ${message}`);
    this.method = request.method;
    this.path = request.path;
    this.status = status;
  }
}

/** GitHub refused the request because of a primary or secondary rate limit. Retry no earlier than `resetAt`. */
export class RateLimitedError extends GitHubApiError {
  override name = "RateLimitedError";
  readonly resetAt: Date;

  constructor(request: RequestInfo, status: number, resetAt: Date) {
    super(`rate limited until ${resetAt.toISOString()}`, request, status);
    this.resetAt = resetAt;
  }
}

/** The response arrived but wasn't JSON or didn't match the schema. Carries issue paths only, never values. */
export class GitHubResponseError extends GitHubApiError {
  override name = "GitHubResponseError";

  constructor(message: string, request: RequestInfo, status: number) {
    super(message, request, status);
  }

  static fromZod(error: z.ZodError, request: RequestInfo, status: number): GitHubResponseError {
    const fields = error.issues.map((issue) => {
      const field = issue.path.length > 0 ? stripControl(issue.path.map(String).join(".")).slice(0, 100) : "(root)";
      return `${field}: ${issue.code}`;
    });
    return new GitHubResponseError(`unexpected response shape (${fields.join("; ")})`, request, status);
  }
}

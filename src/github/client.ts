import type { z } from "zod";
import { GitHubApiError, GitHubResponseError, RateLimitedError, redact, type RequestInfo } from "./errors.js";
import type { TokenProvider } from "./token.js";

export const GITHUB_API = "https://api.github.com";
const API_VERSION = "2022-11-28";
const USER_AGENT = "krispy-pipeline";
/** Used when GitHub signals a rate limit without saying when it ends. */
const DEFAULT_BACKOFF_MS = 60_000;
const MAX_MESSAGE_LENGTH = 200;
/** Oldest entries are evicted past this, so the cache can't grow without bound once paths vary (e.g. pagination). */
export const MAX_ETAG_ENTRIES = 256;

export interface GetResult<T> {
  data: T;
  /** True when GitHub answered 304 and `data` is the cached body from the previous 200. */
  unchanged: boolean;
}

export interface GitHubClient {
  get<T>(path: string, schema: z.ZodType<T>): Promise<GetResult<T>>;
  post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T>;
}

export interface GitHubClientOptions {
  tokens: TokenProvider;
  fetch?: typeof globalThis.fetch;
  /** Milliseconds since the epoch; injectable for tests. */
  now?: () => number;
}

interface CacheEntry {
  etag: string;
  body: unknown;
}

/**
 * A thin client for the GitHub REST API. `path` is relative to https://api.github.com and must start with a single
 * `/`; anything that would resolve to another host is rejected before a token is requested.
 */
export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const etags = new Map<string, CacheEntry>();

  async function send(
    request: RequestInfo,
    headers: Record<string, string>,
    body?: string,
  ): Promise<{ response: Response; token: string }> {
    const url = resolve(request);
    const token = await options.tokens.getToken();
    try {
      const response = await fetchImpl(url, {
        method: request.method,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": USER_AGENT,
          ...headers,
          Authorization: `Bearer ${token}`,
        },
        ...(body !== undefined ? { body } : {}),
      });
      return { response, token };
    } catch (err) {
      const message = err instanceof Error ? err.message : "unknown error";
      throw new GitHubApiError(`request failed (${redact(message, [token])})`, request);
    }
  }

  async function fail(request: RequestInfo, response: Response, token: string): Promise<never> {
    const resetAt = rateLimitReset(response, now());
    if (resetAt !== undefined) {
      await discard(response);
      throw new RateLimitedError(request, response.status, resetAt);
    }
    const detail = redact(await errorDetail(response), [token]);
    throw new GitHubApiError(`HTTP ${response.status}${detail}`, request, response.status);
  }

  return {
    async get<T>(path: string, schema: z.ZodType<T>): Promise<GetResult<T>> {
      const request = { method: "GET", path };
      const cached = etags.get(path);
      const { response, token } = await send(request, cached !== undefined ? { "If-None-Match": cached.etag } : {});
      if (response.status === 304) {
        await discard(response);
        // Fail closed: a 304 we never asked for has no body to return.
        if (cached === undefined) throw new GitHubApiError("HTTP 304 without a cached response", request, 304);
        return { data: validate(cached.body, schema, request, 304), unchanged: true };
      }
      if (!response.ok) return fail(request, response, token);
      const body = await readJson(response, request);
      const data = validate(body, schema, request, response.status);
      const etag = response.headers.get("etag");
      // Stored only once the body has passed validation, so a bad response is never replayed as "unchanged".
      etags.delete(path);
      if (etag !== null && etag !== "") {
        etags.set(path, { etag, body });
        if (etags.size > MAX_ETAG_ENTRIES) {
          const oldest = etags.keys().next().value;
          if (oldest !== undefined) etags.delete(oldest);
        }
      }
      return { data, unchanged: false };
    },

    async post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
      const request = { method: "POST", path };
      const { response, token } = await send(request, { "Content-Type": "application/json" }, JSON.stringify(body));
      if (!response.ok) return fail(request, response, token);
      return validate(await readJson(response, request), schema, request, response.status);
    },
  };
}

function resolve(request: RequestInfo): URL {
  const { path } = request;
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new GitHubApiError("path must start with a single /", request);
  }
  const url = new URL(path, GITHUB_API);
  if (url.origin !== GITHUB_API) throw new GitHubApiError("path must stay on api.github.com", request);
  return url;
}

/** Returns when the rate limit ends if the response is a rate limit (403 or 429 with GitHub's signals), else undefined. */
export function rateLimitReset(response: Response, nowMs: number): Date | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const headers = response.headers;
  if (headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(headers.get("x-ratelimit-reset"));
    return new Date(Number.isFinite(reset) && reset > 0 ? reset * 1000 : nowMs + DEFAULT_BACKOFF_MS);
  }
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    return new Date(nowMs + (Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : DEFAULT_BACKOFF_MS));
  }
  // 429 always means "slow down", even without headers. A bare 403 is a permission error.
  return response.status === 429 ? new Date(nowMs + DEFAULT_BACKOFF_MS) : undefined;
}

/** Releases the connection when the body is not needed. */
async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing to release.
  }
}

async function readJson(response: Response, request: RequestInfo): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    // The stream error is dropped, not wrapped: it is undici's and could carry anything.
    throw new GitHubApiError("could not read the response body", request, response.status);
  }
  if (text === "") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GitHubResponseError("response was not JSON", request, response.status);
  }
}

function validate<T>(body: unknown, schema: z.ZodType<T>, request: RequestInfo, status: number): T {
  const result = schema.safeParse(body);
  if (!result.success) throw GitHubResponseError.fromZod(result.error, request, status);
  return result.data;
}

/** GitHub's own `message` field, shortened. Never the raw body, which could hold anything. */
async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    if (typeof body === "object" && body !== null && "message" in body && typeof body.message === "string") {
      const message = body.message.replace(/\s+/g, " ").slice(0, MAX_MESSAGE_LENGTH);
      return message === "" ? "" : ` (${message})`;
    }
  } catch {
    // Not JSON: the status alone is enough.
  }
  return "";
}

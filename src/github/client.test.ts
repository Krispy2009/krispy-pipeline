import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createGitHubClient, GITHUB_API, MAX_ETAG_ENTRIES } from "./client.js";
import { GitHubApiError, GitHubResponseError, RateLimitedError, redact } from "./errors.js";
import type { TokenProvider } from "./token.js";

const TOKEN = "ghp_FAKEtoken1111111111111111111111111111";
const tokens: TokenProvider = { getToken: async () => TOKEN };
const NOW = Date.UTC(2026, 10, 21, 5, 0, 0);

const issueSchema = z.object({ number: z.number(), title: z.string() });
const issue = { number: 7, title: "Add widgets" };
const PATH = "/repos/acme/widgets/issues/7";

interface Call {
  url: string;
  init: RequestInit;
}

function stub(...responses: (Response | (() => Response) | Error)[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = responses.shift();
    if (next === undefined) throw new Error("unexpected request");
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next() : next;
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

function header(call: Call | undefined, name: string): string | null {
  return new Headers(call?.init.headers).get(name);
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected to throw");
}

function expectNoToken(err: Error): void {
  const text = [err.message, err.stack ?? "", String(err.cause ?? ""), JSON.stringify(err)].join("\n");
  expect(text).not.toContain(TOKEN);
}

describe("createGitHubClient", () => {
  it("get validates and returns data", async () => {
    const { fetch, calls } = stub(json(issue));
    const client = createGitHubClient({ tokens, fetch });
    await expect(client.get(PATH, issueSchema)).resolves.toEqual({ data: issue, unchanged: false });
    expect(calls[0]?.url).toBe(`${GITHUB_API}${PATH}`);
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("sends the bearer token from the provider and GitHub's headers", async () => {
    const { fetch, calls } = stub(json(issue));
    await createGitHubClient({ tokens, fetch }).get(PATH, issueSchema);
    expect(header(calls[0], "authorization")).toBe(`Bearer ${TOKEN}`);
    expect(header(calls[0], "accept")).toBe("application/vnd.github+json");
    expect(header(calls[0], "x-github-api-version")).toBe("2022-11-28");
    expect(header(calls[0], "user-agent")).toBe("krispy-pipeline");
  });

  it("post sends a JSON body and validates the response", async () => {
    const comment = { id: 1, body: "hello" };
    const { fetch, calls } = stub(json(comment, 201));
    const client = createGitHubClient({ tokens, fetch });
    const result = await client.post(`${PATH}/comments`, { body: "hello" }, z.object({ id: z.number(), body: z.string() }));
    expect(result).toEqual(comment);
    expect(calls[0]?.init.method).toBe("POST");
    expect(calls[0]?.init.body).toBe(JSON.stringify({ body: "hello" }));
    expect(header(calls[0], "content-type")).toBe("application/json");
    expect(header(calls[0], "authorization")).toBe(`Bearer ${TOKEN}`);
  });

  it.each(["repos/acme/widgets", "//evil.example/x", "/\\evil.example", "https://evil.example/x", "/\t/evil.example/x"])(
    "rejects path %s before asking for a token",
    async (path) => {
      let asked = false;
      const { fetch, calls } = stub();
      const client = createGitHubClient({ tokens: { getToken: async () => ((asked = true), TOKEN) }, fetch });
      await expect(client.get(path, issueSchema)).rejects.toBeInstanceOf(GitHubApiError);
      expect(asked).toBe(false);
      expect(calls).toHaveLength(0);
    },
  );

  it("refuses to follow redirects, so the token is never re-sent to another host", async () => {
    const calls: Call[] = [];
    // Behaves like a fetch that would follow a 301 to another origin with the same headers, unless told not to.
    const following = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
      calls.push({ url: "https://evil.example/moved", init: init ?? {} });
      return json(issue);
    }) as typeof fetch;
    const client = createGitHubClient({ tokens, fetch: following });
    const err = await caught(client.get(PATH, issueSchema));
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(calls.map((c) => c.url)).toEqual([`${GITHUB_API}${PATH}`]);
    await caught(client.post(PATH, {}, z.unknown()));
    expect(calls.every((c) => c.init.redirect === "error")).toBe(true);
    expectNoToken(err);
  });

  describe("ETags", () => {
    it("second get sends If-None-Match with the stored ETag", async () => {
      const { fetch, calls } = stub(json(issue, 200, { etag: '"abc"' }), new Response(null, { status: 304 }));
      const client = createGitHubClient({ tokens, fetch });
      await client.get(PATH, issueSchema);
      await client.get(PATH, issueSchema);
      expect(header(calls[0], "if-none-match")).toBeNull();
      expect(header(calls[1], "if-none-match")).toBe('"abc"');
    });

    it("304 returns the cached data marked unchanged", async () => {
      const { fetch } = stub(json(issue, 200, { etag: '"abc"' }), new Response(null, { status: 304 }));
      const client = createGitHubClient({ tokens, fetch });
      await client.get(PATH, issueSchema);
      await expect(client.get(PATH, issueSchema)).resolves.toEqual({ data: issue, unchanged: true });
    });

    it("keeps ETags per path", async () => {
      const other = "/repos/acme/widgets/issues/8";
      const { fetch, calls } = stub(json(issue, 200, { etag: '"a"' }), json(issue, 200, { etag: '"b"' }), json(issue));
      const client = createGitHubClient({ tokens, fetch });
      await client.get(PATH, issueSchema);
      await client.get(other, issueSchema);
      await client.get(PATH, issueSchema);
      expect(header(calls[1], "if-none-match")).toBeNull();
      expect(header(calls[2], "if-none-match")).toBe('"a"');
    });

    it("304 with no cache entry fails closed", async () => {
      const { fetch } = stub(new Response(null, { status: 304 }));
      const err = await caught(createGitHubClient({ tokens, fetch }).get(PATH, issueSchema));
      expect(err).toBeInstanceOf(GitHubApiError);
      expect((err as GitHubApiError).status).toBe(304);
    });

    it("evicts the oldest entry past MAX_ETAG_ENTRIES", async () => {
      const paths = Array.from({ length: MAX_ETAG_ENTRIES + 1 }, (_, i) => `/repos/acme/widgets/issues/${i}`);
      const { fetch, calls } = stub(
        ...paths.map((_, i) => json(issue, 200, { etag: `"e${i}"` })),
        json(issue),
        json(issue),
      );
      const client = createGitHubClient({ tokens, fetch });
      for (const path of paths) await client.get(path, issueSchema);
      await client.get(paths[0] ?? "", issueSchema);
      await client.get(paths[MAX_ETAG_ENTRIES] ?? "", issueSchema);
      expect(header(calls[paths.length], "if-none-match")).toBeNull();
      expect(header(calls[paths.length + 1], "if-none-match")).toBe(`"e${MAX_ETAG_ENTRIES}"`);
    });

    it("a 304 hit counts as recent use for eviction", async () => {
      const paths = Array.from({ length: MAX_ETAG_ENTRIES + 1 }, (_, i) => `/repos/acme/widgets/issues/${i}`);
      const { fetch, calls } = stub(
        ...paths.slice(0, MAX_ETAG_ENTRIES).map((_, i) => json(issue, 200, { etag: `"e${i}"` })),
        new Response(null, { status: 304 }),
        json(issue, 200, { etag: `"e${MAX_ETAG_ENTRIES}"` }),
        new Response(null, { status: 304 }),
        json(issue),
      );
      const client = createGitHubClient({ tokens, fetch });
      for (const path of paths.slice(0, MAX_ETAG_ENTRIES)) await client.get(path, issueSchema);
      await client.get(paths[0] ?? "", issueSchema); // 304: path 0 is now the most recent
      await client.get(paths[MAX_ETAG_ENTRIES] ?? "", issueSchema); // evicts path 1, not path 0
      await expect(client.get(paths[0] ?? "", issueSchema)).resolves.toMatchObject({ unchanged: true });
      await client.get(paths[1] ?? "", issueSchema);
      expect(header(calls.at(-1), "if-none-match")).toBeNull();
    });

    it("cancels the body of a 304", async () => {
      let cancelled = false;
      const body = new ReadableStream({ cancel: () => void (cancelled = true) });
      // A real 304 can't carry a body in the Response constructor, so a 200 is relabelled.
      const notModified = Object.defineProperty(new Response(body), "status", { value: 304 });
      const { fetch } = stub(json(issue, 200, { etag: '"abc"' }), notModified);
      const client = createGitHubClient({ tokens, fetch });
      await client.get(PATH, issueSchema);
      await expect(client.get(PATH, issueSchema)).resolves.toEqual({ data: issue, unchanged: true });
      expect(cancelled).toBe(true);
    });

    it("does not cache a body that failed validation", async () => {
      const { fetch, calls } = stub(json({ number: "x" }, 200, { etag: '"bad"' }), json(issue));
      const client = createGitHubClient({ tokens, fetch });
      await expect(client.get(PATH, issueSchema)).rejects.toBeInstanceOf(GitHubResponseError);
      await client.get(PATH, issueSchema);
      expect(header(calls[1], "if-none-match")).toBeNull();
    });
  });

  describe("rate limits", () => {
    it("403 with x-ratelimit-remaining 0 throws RateLimitedError with the reset time", async () => {
      const reset = NOW / 1000 + 600;
      const { fetch } = stub(
        json({ message: "API rate limit exceeded" }, 403, {
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": String(reset),
        }),
      );
      const err = await caught(createGitHubClient({ tokens, fetch, now: () => NOW }).get(PATH, issueSchema));
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).resetAt).toEqual(new Date(reset * 1000));
      expect((err as RateLimitedError).status).toBe(403);
    });

    it("429 with retry-after throws RateLimitedError", async () => {
      const { fetch } = stub(json({ message: "slow down" }, 429, { "retry-after": "30" }));
      const err = await caught(createGitHubClient({ tokens, fetch, now: () => NOW }).post(PATH, {}, z.unknown()));
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).resetAt).toEqual(new Date(NOW + 30_000));
    });

    it("403 with retry-after (secondary limit) throws RateLimitedError", async () => {
      const { fetch } = stub(json({ message: "secondary rate limit" }, 403, { "retry-after": "5" }));
      const err = await caught(createGitHubClient({ tokens, fetch, now: () => NOW }).get(PATH, issueSchema));
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).resetAt).toEqual(new Date(NOW + 5_000));
    });

    it("bare 429 with no headers backs off 60 s", async () => {
      const { fetch } = stub(json({}, 429));
      const err = await caught(createGitHubClient({ tokens, fetch, now: () => NOW }).get(PATH, issueSchema));
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).resetAt).toEqual(new Date(NOW + 60_000));
    });

    it("403 with x-ratelimit-remaining 0 but no reset backs off 60 s", async () => {
      const { fetch } = stub(json({}, 403, { "x-ratelimit-remaining": "0" }));
      const err = await caught(createGitHubClient({ tokens, fetch, now: () => NOW }).get(PATH, issueSchema));
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).resetAt).toEqual(new Date(NOW + 60_000));
    });

    it("cancels the body of a rate-limited response", async () => {
      let cancelled = false;
      const body = new ReadableStream({ cancel: () => void (cancelled = true) });
      const { fetch } = stub(new Response(body, { status: 429, headers: { "retry-after": "1" } }));
      await expect(createGitHubClient({ tokens, fetch }).get(PATH, issueSchema)).rejects.toBeInstanceOf(RateLimitedError);
      expect(cancelled).toBe(true);
    });

    it("403 without rate-limit headers is a plain GitHubApiError", async () => {
      const { fetch } = stub(json({ message: "Resource not accessible by integration" }, 403));
      const err = await caught(createGitHubClient({ tokens, fetch }).get(PATH, issueSchema));
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err).not.toBeInstanceOf(RateLimitedError);
      expect(err.message).toBe(`GET ${PATH}: HTTP 403 (Resource not accessible by integration)`);
    });
  });

  describe("token never leaks", () => {
    it("from a network error that echoes the token", async () => {
      const { fetch } = stub(new Error(`connect failed, Authorization: Bearer ${TOKEN}`));
      const err = await caught(createGitHubClient({ tokens, fetch }).get(PATH, issueSchema));
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err.message).toContain("[redacted]");
      expectNoToken(err);
    });

    it.each([
      ["an HTTP error", () => json({ message: "Bad credentials" }, 401)],
      ["a rate limit", () => json({}, 429)],
      ["a non-JSON body", () => new Response("<html>", { status: 200 })],
      ["a schema mismatch", () => json({ number: TOKEN, title: 1 })],
      ["a 304 with no cache", () => new Response(null, { status: 304 })],
    ])("from %s", async (_label, response) => {
      const { fetch } = stub(response);
      const err = await caught(createGitHubClient({ tokens, fetch }).get(PATH, issueSchema));
      expect(err).toBeInstanceOf(GitHubApiError);
      expectNoToken(err);
    });

    it("from a GitHub error message that echoes the token", async () => {
      const { fetch } = stub(json({ message: `bad token ${TOKEN}` }, 401));
      const err = await caught(createGitHubClient({ tokens, fetch }).get(PATH, issueSchema));
      expect(err.message).toBe(`GET ${PATH}: HTTP 401 (bad token [redacted])`);
      expectNoToken(err);
    });

    it("from a body stream that fails mid-read", async () => {
      const body = new ReadableStream({
        pull: (controller) => controller.error(new Error(`socket reset, Authorization: Bearer ${TOKEN}`)),
      });
      const { fetch } = stub(new Response(body, { status: 200 }));
      const err = await caught(createGitHubClient({ tokens, fetch }).get(PATH, issueSchema));
      expect(err).toBeInstanceOf(GitHubApiError);
      expect(err.message).toBe(`GET ${PATH}: could not read the response body`);
      expect(err.cause).toBeUndefined();
      expectNoToken(err);
    });

    it("from a failing token provider", async () => {
      const { fetch, calls } = stub();
      const failing: TokenProvider = { getToken: async () => Promise.reject(new Error("no token")) };
      await expect(createGitHubClient({ tokens: failing, fetch }).get(PATH, issueSchema)).rejects.toThrow("no token");
      expect(calls).toHaveLength(0);
    });
  });
});

describe("redact", () => {
  it("replaces every occurrence of each secret", () => {
    expect(redact(`a ${TOKEN} b ${TOKEN}`, [TOKEN])).toBe("a [redacted] b [redacted]");
  });

  it("ignores empty secrets", () => {
    expect(redact("unchanged", [""])).toBe("unchanged");
  });
});

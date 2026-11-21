import { describe, expect, it } from "vitest";
import { GhCliTokenProvider, scrubbedEnv, TokenUnavailableError, type CommandRunner } from "./token.js";

const TOKEN = "gho_FAKEtoken0000000000000000000000000000";

describe("GhCliTokenProvider", () => {
  it("runs gh auth token and trims the output", async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const run: CommandRunner = async (command, args) => {
      calls.push({ command, args });
      return { stdout: `${TOKEN}\n` };
    };
    await expect(new GhCliTokenProvider(run).getToken()).resolves.toBe(TOKEN);
    expect(calls).toEqual([{ command: "gh", args: ["auth", "token"] }]);
  });

  it("runs gh with an env scrubbed of token, host and config overrides", async () => {
    let seen: NodeJS.ProcessEnv | undefined;
    const run: CommandRunner = async (_command, _args, env) => {
      seen = env;
      return { stdout: TOKEN };
    };
    const env = {
      PATH: "/usr/bin",
      HOME: "/home/acme",
      GH_TOKEN: "env-token",
      GITHUB_TOKEN: "env-token",
      GH_ENTERPRISE_TOKEN: "env-token",
      GITHUB_ENTERPRISE_TOKEN: "env-token",
      GH_HOST: "ghe.acme.example",
      GH_CONFIG_DIR: "/tmp/elsewhere",
      gh_token: "env-token",
    };
    await new GhCliTokenProvider(run, env).getToken();
    expect(seen).toEqual({ PATH: "/usr/bin", HOME: "/home/acme" });
  });

  it("asks gh again on every call", async () => {
    let n = 0;
    const provider = new GhCliTokenProvider(async () => ({ stdout: `token-${++n}` }));
    await provider.getToken();
    await expect(provider.getToken()).resolves.toBe("token-2");
  });

  it.each([
    ["empty output", ""],
    ["whitespace only", "  \n"],
    ["more than one line", `${TOKEN}\nextra`],
  ])("rejects %s", async (_label, stdout) => {
    await expect(new GhCliTokenProvider(async () => ({ stdout })).getToken()).rejects.toBeInstanceOf(
      TokenUnavailableError,
    );
  });

  it("does not leak the command's output when gh fails", async () => {
    const run: CommandRunner = async () => {
      const err = Object.assign(new Error(`Command failed: gh auth token\n${TOKEN}`), { stdout: TOKEN });
      throw err;
    };
    const err = await new GhCliTokenProvider(run).getToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TokenUnavailableError);
    const e = err as Error;
    expect(`${e.message} ${e.stack ?? ""} ${String(e.cause)}`).not.toContain(TOKEN);
    expect(e.cause).toBeUndefined();
  });
});

describe("scrubbedEnv", () => {
  it("drops any GH_/GITHUB_ *TOKEN variable and leaves the input untouched", () => {
    const env = { GITHUB_PAT_TOKEN: "x", GH_FOO_TOKEN: "x", GH_DEBUG: "1", LANG: "C" };
    expect(scrubbedEnv(env)).toEqual({ GH_DEBUG: "1", LANG: "C" });
    expect(env.GITHUB_PAT_TOKEN).toBe("x");
  });
});

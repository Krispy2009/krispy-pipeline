import { describe, expect, it } from "vitest";
import { GhCliTokenProvider, TokenUnavailableError, type CommandRunner } from "./token.js";

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

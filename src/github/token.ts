import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Supplies the token for each GitHub request. Injected so tests never need a real one. */
export interface TokenProvider {
  getToken(): Promise<string>;
}

/** Thrown when no token could be obtained. The message is fixed, so it can't echo command output. */
export class TokenUnavailableError extends Error {
  override name = "TokenUnavailableError";

  constructor() {
    super("could not get a GitHub token from `gh auth token`; run `gh auth login`");
  }
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => Promise<{ stdout: string }>;

/**
 * Variables that would make `gh auth token` answer from somewhere other than its keyring entry for github.com:
 * a token in the environment, another host, or another config directory.
 */
const OVERRIDE_VARS = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
]);

/** A copy of `env` without anything that lets `gh` take its token from the environment (CLAUDE.md, ADR 0002). */
export function scrubbedEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase();
    if (OVERRIDE_VARS.has(upper) || /^(GH|GITHUB)_.*TOKEN$/.test(upper)) continue;
    out[key] = value;
  }
  return out;
}

const execFileAsync = promisify(execFile);

const defaultRunner: CommandRunner = async (command, args, env) => {
  // No shell, and the token only ever travels on stdout.
  const { stdout } = await execFileAsync(command, [...args], { timeout: 10_000, encoding: "utf8", env });
  return { stdout };
};

/**
 * Reads the token the signed-in `gh` CLI keeps in the OS keyring. Asked on every call, so a `gh auth refresh` is
 * picked up without a restart.
 */
export class GhCliTokenProvider implements TokenProvider {
  readonly #run: CommandRunner;
  readonly #env: NodeJS.ProcessEnv;

  constructor(run: CommandRunner = defaultRunner, env: NodeJS.ProcessEnv = process.env) {
    this.#run = run;
    this.#env = env;
  }

  async getToken(): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await this.#run("gh", ["auth", "token"], scrubbedEnv(this.#env)));
    } catch {
      // The child error can include stdout and stderr, so it is dropped rather than wrapped.
      throw new TokenUnavailableError();
    }
    const token = stdout.trim();
    if (token === "" || /\s/.test(token)) throw new TokenUnavailableError();
    return token;
  }
}

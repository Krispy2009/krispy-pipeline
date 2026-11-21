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

export type CommandRunner = (command: string, args: readonly string[]) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

const defaultRunner: CommandRunner = async (command, args) => {
  // No shell, and the token only ever travels on stdout.
  const { stdout } = await execFileAsync(command, [...args], { timeout: 10_000, encoding: "utf8" });
  return { stdout };
};

/**
 * Reads the token the signed-in `gh` CLI keeps in the OS keyring. Asked on every call, so a `gh auth refresh` is
 * picked up without a restart.
 */
export class GhCliTokenProvider implements TokenProvider {
  readonly #run: CommandRunner;

  constructor(run: CommandRunner = defaultRunner) {
    this.#run = run;
  }

  async getToken(): Promise<string> {
    let stdout: string;
    try {
      ({ stdout } = await this.#run("gh", ["auth", "token"]));
    } catch {
      // The child error can include stdout and stderr, so it is dropped rather than wrapped.
      throw new TokenUnavailableError();
    }
    const token = stdout.trim();
    if (token === "" || /\s/.test(token)) throw new TokenUnavailableError();
    return token;
  }
}

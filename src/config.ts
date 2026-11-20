import { closeSync, constants, fstatSync, openSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const DEFAULT_CONFIG_DIR = "~/.config/krispy-pipeline/projects";

export function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.KRISPY_CONFIG_DIR;
  return expandHome(override !== undefined && override !== "" ? override : DEFAULT_CONFIG_DIR);
}

const limitsSchema = z.strictObject({
  maxPlanRounds: z.number().int().positive().default(3),
  maxPrRounds: z.number().int().positive().default(10),
  runMinutes: z.number().int().positive().default(60),
});

const idSchema = z.string().min(1);
const repoSchema = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must look like owner/name");

export const projectSchema = z.strictObject({
  id: idSchema,
  repo: repoSchema,
  tracker: z.enum(["github", "linear"]).default("github"),
  auth: z.enum(["app", "byo-token"]).default("app"),
  workdir: z.string().min(1).transform(expandHome),
  decisions: z.string().default("docs/decisions/"),
  setup: z.array(z.string()).default([]),
  checks: z.array(z.string()).default([]),
  planApproval: z.enum(["human", "reviewer-then-human"]).default("human"),
  limits: limitsSchema.prefault({}),
});

export type Project = z.output<typeof projectSchema>;

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "unknown error";
}

/**
 * Loads every `*.yaml` file in `dir`. Extensions are matched case-insensitively, so `widgets.YAML` loads too, and
 * `.yml` in any case is rejected, not ignored. Throws one error listing every file and field that failed, including
 * duplicate `id` or `repo` across files; nothing is returned unless every file is valid.
 * Messages carry paths and schema messages only, never parsed values.
 *
 * Deliberately ignored: subdirectories and other non-regular files (such as FIFOs), and files named exactly `.yaml`
 * or `.yml` (hidden files with no extension). Symlinks are followed, so a linked config file loads (e.g. one kept in a
 * dotfiles repo) and a link to a directory is skipped like a directory.
 */
/**
 * Reads `path` only if it is a regular file at the moment it is opened, else returns `undefined`. Opening non-blocking
 * and checking the open descriptor means an entry swapped for a FIFO after the directory scan can't block the read.
 */
function readRegularFile(path: string): string | undefined {
  // O_NONBLOCK is undefined on Windows, where there are no FIFOs to guard against.
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    return fstatSync(fd).isFile() ? readFileSync(fd, "utf8") : undefined;
  } finally {
    closeSync(fd);
  }
}

export function loadProjects(dir: string): Project[] {
  // Only regular files are considered, so directories, FIFOs and other special files are skipped whatever their name
  // (a FIFO would block the read). An entry that can't be stat'ed (a broken symlink, a symlink loop, no permission) is
  // kept, so reading it reports the problem in the combined error.
  const isCandidate = (name: string): boolean => {
    try {
      return statSync(join(dir, name)).isFile();
    } catch {
      return true;
    }
  };
  const names = readdirSync(dir).filter(isCandidate).sort();
  // extname ignores a leading dot, so hidden files named just ".yaml" or ".yml" are neither loaded nor reported.
  const extension = (name: string): string => extname(name).toLowerCase();
  const files = names.filter((name) => extension(name) === ".yaml");

  const problems: string[] = [];
  for (const name of names.filter((n) => extension(n) === ".yml")) {
    problems.push(`${name}: unsupported extension, rename it to .yaml`);
  }
  const loaded: Project[] = [];
  const identities: { file: string; id?: string; repo?: string }[] = [];

  for (const file of files) {
    let raw: unknown;
    try {
      const text = readRegularFile(join(dir, file));
      if (text === undefined) continue; // no longer a regular file: skipped, like at scan time
      raw = parse(text);
    } catch (err) {
      problems.push(`${file}: could not read or parse YAML (${errorMessage(err).split("\n")[0]})`);
      continue;
    }
    // Validated with the same field schemas as the project, so only well-formed values are compared.
    const fields = z.record(z.string(), z.unknown()).safeParse(raw);
    if (fields.success) {
      const id = idSchema.safeParse(fields.data.id);
      const repo = repoSchema.safeParse(fields.data.repo);
      identities.push({
        file,
        ...(id.success ? { id: id.data } : {}),
        ...(repo.success ? { repo: repo.data.toLowerCase() } : {}),
      });
    }
    const result = projectSchema.safeParse(raw);
    if (!result.success) {
      for (const issue of result.error.issues) {
        const field = issue.path.length > 0 ? issue.path.join(".") : "(root)";
        problems.push(`${file}: ${field}: ${issue.message}`);
      }
      continue;
    }
    loaded.push(result.data);
  }

  const seen = { id: new Map<string, string>(), repo: new Map<string, string>() };
  // Checked for every file that parsed, even ones with other schema errors, so duplicates surface alongside them.
  for (const identity of identities) {
    for (const key of ["id", "repo"] as const) {
      const value = identity[key];
      if (value === undefined) continue;
      const file = identity.file;
      const first = seen[key].get(value);
      if (first === undefined) seen[key].set(value, file);
      else problems.push(`${file}: ${key}: duplicate of ${first}`);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid project config:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  return loaded;
}

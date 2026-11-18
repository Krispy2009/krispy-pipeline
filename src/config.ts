import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export const projectSchema = z.strictObject({
  id: z.string().min(1),
  repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, "must look like owner/name"),
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
 * Loads every `*.yaml` file in `dir` (`.yml` is rejected, not ignored). Throws one error listing every file and
 * field that failed; nothing is returned unless every file is valid.
 * Messages carry paths and schema messages only, never parsed values.
 */
export function loadProjects(dir: string): Project[] {
  const names = readdirSync(dir).sort();
  const files = names.filter((name) => name.endsWith(".yaml"));

  const problems: string[] = [];
  for (const name of names.filter((n) => n.endsWith(".yml"))) {
    problems.push(`${name}: unsupported extension, rename it to .yaml`);
  }
  const loaded: Project[] = [];
  const identities: { file: string; id?: string; repo?: string }[] = [];

  for (const file of files) {
    let raw: unknown;
    try {
      raw = parse(readFileSync(join(dir, file), "utf8"));
    } catch (err) {
      problems.push(`${file}: could not read or parse YAML (${errorMessage(err).split("\n")[0]})`);
      continue;
    }
    if (typeof raw === "object" && raw !== null) {
      const { id, repo } = raw as Record<string, unknown>;
      identities.push({
        file,
        ...(typeof id === "string" ? { id } : {}),
        ...(typeof repo === "string" ? { repo: repo.toLowerCase() } : {}),
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
  // Checked on the raw values so duplicates surface alongside other errors, not after them.
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

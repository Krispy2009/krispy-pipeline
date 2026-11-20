import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configDir, loadProjects, projectSchema } from "./config.js";

const widgets = "id: widgets\nrepo: acme/widgets\nworkdir: /srv/widgets\n";
const gadgets = "id: gadgets\nrepo: acme/gadgets\nworkdir: /srv/gadgets\n";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "krispy-config-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function write(name: string, content: string): void {
  writeFileSync(join(dir, name), content);
}

function thrown(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error("expected to throw");
}

const base = { id: "widgets", repo: "acme/widgets", workdir: "/srv/widgets" };

describe("projectSchema", () => {
  it("applies defaults for optional fields", () => {
    expect(projectSchema.parse(base)).toEqual({
      ...base,
      tracker: "github",
      auth: "app",
      decisions: "docs/decisions/",
      setup: [],
      checks: [],
      planApproval: "human",
      limits: { maxPlanRounds: 3, maxPrRounds: 10, runMinutes: 60 },
    });
  });

  it("fills in missing limits individually", () => {
    expect(projectSchema.parse({ ...base, limits: { runMinutes: 5 } }).limits).toEqual({
      maxPlanRounds: 3,
      maxPrRounds: 10,
      runMinutes: 5,
    });
  });

  it("rejects an unknown top-level key", () => {
    expect(projectSchema.safeParse({ ...base, extra: 1 }).success).toBe(false);
  });

  it("rejects an unknown key in limits", () => {
    expect(projectSchema.safeParse({ ...base, limits: { extra: 1 } }).success).toBe(false);
  });

  it.each(["acme", "acme/", "/widgets", "a/b/c", "acme widgets/x", ""])(
    "rejects bad repo %j",
    (repo) => {
      expect(projectSchema.safeParse({ ...base, repo }).success).toBe(false);
    },
  );

  it.each(["jira", "GitHub", ""])("rejects unknown tracker %j", (tracker) => {
    expect(projectSchema.safeParse({ ...base, tracker }).success).toBe(false);
  });

  it.each(["token", "App", ""])("rejects unknown auth %j", (auth) => {
    expect(projectSchema.safeParse({ ...base, auth }).success).toBe(false);
  });

  it("accepts the other allowed enum values", () => {
    const parsed = projectSchema.parse({ ...base, tracker: "linear", auth: "byo-token" });
    expect([parsed.tracker, parsed.auth]).toEqual(["linear", "byo-token"]);
  });

  it("expands ~ in workdir", () => {
    expect(projectSchema.parse({ ...base, workdir: "~/krispy/widgets" }).workdir).toBe(
      join(homedir(), "krispy/widgets"),
    );
    expect(projectSchema.parse({ ...base, workdir: "~" }).workdir).toBe(homedir());
  });

  it("leaves absolute paths and other tilde forms alone", () => {
    expect(projectSchema.parse(base).workdir).toBe("/srv/widgets");
    expect(projectSchema.parse({ ...base, workdir: "~other/x" }).workdir).toBe("~other/x");
  });

  it("example config passes the schema", () => {
    const exampleDir = join(dir, "example");
    mkdirSync(exampleDir);
    const example = new URL("../config/project.example.yaml", import.meta.url);
    writeFileSync(join(exampleDir, "example.yaml"), readFileSync(example, "utf8"));
    const [project] = loadProjects(exampleDir);
    expect(project).toMatchObject({
      id: "widgets",
      repo: "acme/widgets",
      tracker: "github",
      auth: "app",
      workdir: join(homedir(), "krispy/widgets"),
      decisions: "docs/decisions/",
      planApproval: "human",
      checks: ["pnpm typecheck", "pnpm lint", "pnpm test"],
      limits: { maxPlanRounds: 3, maxPrRounds: 10, runMinutes: 60 },
    });
    expect(project?.setup).toHaveLength(3);
  });
});

describe("loadProjects", () => {
  it("loads every project in the directory", () => {
    write("widgets.yaml", widgets);
    write("gadgets.yaml", gadgets);
    expect(loadProjects(dir).map((p) => p.id)).toEqual(["gadgets", "widgets"]);
  });

  it("ignores files that are not .yaml", () => {
    write("widgets.yaml", widgets);
    write("notes.txt", "not yaml: [");
    expect(loadProjects(dir)).toHaveLength(1);
  });

  it("reports .yml files instead of silently ignoring them", () => {
    write("widgets.yaml", widgets);
    write("gadgets.yml", gadgets);
    expect(thrown(() => loadProjects(dir))).toContain("gadgets.yml: unsupported extension, rename it to .yaml");
  });

  it("treats extensions case-insensitively", () => {
    write("widgets.YAML", widgets);
    write("gadgets.YML", gadgets);
    const message = thrown(() => loadProjects(dir));
    expect(message).toContain("gadgets.YML: unsupported extension, rename it to .yaml");
    expect(message).not.toContain("widgets.YAML");
  });

  it("loads upper- and mixed-case .yaml files", () => {
    write("widgets.YAML", widgets);
    write("gadgets.Yaml", gadgets);
    expect(loadProjects(dir).map((p) => p.id)).toEqual(["gadgets", "widgets"]);
  });

  it("does not report a duplicate for an invalid repo", () => {
    write("a.yaml", "id: a\nrepo: not-a-repo\nworkdir: /x\n");
    write("b.yaml", "id: b\nrepo: not-a-repo\nworkdir: /y\n");
    const message = thrown(() => loadProjects(dir));
    expect(message).toContain("a.yaml: repo");
    expect(message).toContain("b.yaml: repo");
    expect(message).not.toContain("duplicate");
  });

  it("follows symlinks: a linked file loads, a linked directory is skipped", () => {
    const outside = mkdtempSync(join(tmpdir(), "krispy-linked-"));
    try {
      writeFileSync(join(outside, "widgets.yaml"), widgets);
      mkdirSync(join(outside, "nested"));
      symlinkSync(join(outside, "widgets.yaml"), join(dir, "widgets.yaml"));
      symlinkSync(join(outside, "nested"), join(dir, "nested.yaml"));
      expect(loadProjects(dir)).toHaveLength(1);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("skips a FIFO named .yaml instead of blocking on it", () => {
    execFileSync("mkfifo", [join(dir, "pipe.yaml")]);
    write("widgets.yaml", widgets);
    expect(loadProjects(dir)).toHaveLength(1);
  });

  it("ignores directories, whatever their extension", () => {
    mkdirSync(join(dir, "nested.yaml"));
    mkdirSync(join(dir, "nested.yml"));
    write("widgets.yaml", widgets);
    expect(loadProjects(dir)).toHaveLength(1);
  });

  it("reports an entry that can't be stat'ed in the combined error", () => {
    symlinkSync("loop.yaml", join(dir, "loop.yaml"));
    write("widgets.yaml", widgets);
    const message = thrown(() => loadProjects(dir));
    expect(message).toContain("Invalid project config");
    expect(message).toContain("loop.yaml: could not read or parse YAML");
  });

  it("ignores hidden files named just .yaml or .yml", () => {
    write(".yaml", "not: a project\n");
    write(".yml", "not: a project\n");
    write("widgets.yaml", widgets);
    expect(loadProjects(dir)).toHaveLength(1);
  });

  it("reports duplicates alongside other validation errors", () => {
    write("a.yaml", widgets);
    write("b.yaml", "id: widgets\nrepo: acme/widgets\nworkdir: /y\ntracker: jira\n");
    const message = thrown(() => loadProjects(dir));
    expect(message).toContain("b.yaml: tracker");
    expect(message).toContain("b.yaml: id: duplicate of a.yaml");
    expect(message).toContain("b.yaml: repo: duplicate of a.yaml");
  });

  it("returns an empty list for an empty directory", () => {
    expect(loadProjects(dir)).toEqual([]);
  });

  it("throws when the directory is missing", () => {
    expect(() => loadProjects(join(dir, "nope"))).toThrow();
  });

  it("reports every bad file and field in one error", () => {
    write("a.yaml", "id: a\nrepo: not-a-repo\nworkdir: /x\ntracker: jira\n");
    write("b.yaml", "id: b\nrepo: acme/b\nworkdir: /y\nextra: 1\n");
    write("good.yaml", widgets);
    const message = thrown(() => loadProjects(dir));
    expect(message).toContain("a.yaml: repo");
    expect(message).toContain("a.yaml: tracker");
    expect(message).toContain("b.yaml");
    expect(message).not.toContain("good.yaml");
  });

  it("reports YAML syntax errors per file", () => {
    write("broken.yaml", "id: [unclosed\n");
    expect(thrown(() => loadProjects(dir))).toContain("broken.yaml: could not read or parse YAML");
  });

  it("rejects a file that is not a mapping", () => {
    write("list.yaml", "- a\n- b\n");
    expect(thrown(() => loadProjects(dir))).toContain("list.yaml");
  });

  it("does not echo field values in errors", () => {
    write("a.yaml", "id: a\nrepo: super-secret-value\nworkdir: /x\n");
    expect(thrown(() => loadProjects(dir))).not.toContain("super-secret-value");
  });

  it("rejects duplicate id, naming both files", () => {
    write("a.yaml", widgets);
    write("b.yaml", "id: widgets\nrepo: acme/other\nworkdir: /y\n");
    const message = thrown(() => loadProjects(dir));
    expect(message).toContain("b.yaml: id: duplicate of a.yaml");
  });

  it("rejects duplicate repo, including different case", () => {
    write("a.yaml", widgets);
    write("b.yaml", "id: other\nrepo: ACME/Widgets\nworkdir: /y\n");
    const message = thrown(() => loadProjects(dir));
    expect(message).toContain("b.yaml: repo: duplicate of a.yaml");
  });
});

describe("configDir", () => {
  it("uses KRISPY_CONFIG_DIR when set", () => {
    expect(configDir({ KRISPY_CONFIG_DIR: "/tmp/custom" })).toBe("/tmp/custom");
  });

  it("falls back to the default under ~/.config", () => {
    const expected = join(homedir(), ".config/krispy-pipeline/projects");
    expect(configDir({})).toBe(expected);
    expect(configDir({ KRISPY_CONFIG_DIR: "" })).toBe(expected);
  });
});

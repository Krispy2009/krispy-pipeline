import { describe, expect, it, vi } from "vitest";
import { checkTicket, parseTicket } from "./ticket.js";

const body = `## Current thinking

Build the widget.

## Acceptance

- [ ] Widget renders
- [x] Widget tested
* [ ] Bullet star

## Blockers

#3, #4 and #3 again

## Out of scope

Gadgets.
`;

const allClosed = async (): Promise<boolean> => true;

describe("parseTicket", () => {
  it("parses all sections", () => {
    expect(parseTicket(body)).toEqual({
      currentThinking: "Build the widget.",
      acceptance: [
        { text: "Widget renders", checked: false },
        { text: "Widget tested", checked: true },
        { text: "Bullet star", checked: false },
      ],
      blockers: [3, 4],
      outOfScope: "Gadgets.",
    });
  });

  it("matches headings case-insensitively", () => {
    const t = parseTicket("## ACCEPTANCE\n- [ ] a\n## blockers\nnOnE\n");
    expect(t.acceptance).toHaveLength(1);
    expect(t.blockers).toEqual([]);
  });

  it("ignores # and ### headings", () => {
    const t = parseTicket("### Acceptance\n- [ ] a\n# Blockers\n#9\n");
    expect(t.acceptance).toEqual([]);
    expect(t.blockers).toEqual([]);
  });

  it.each(["None", "none", "NONE", "  None \n"])("treats %j as no blockers", (text) => {
    expect(parseTicket(`## Blockers\n${text}\n`).blockers).toEqual([]);
  });

  it("ignores HTML comments, including multi-line ones", () => {
    const t = parseTicket(
      "## Acceptance\n<!-- - [ ] hidden -->\n- [ ] real\n<!--\n## Blockers\n#7\n-->\n## Blockers\n<!-- #8 -->\nNone\n",
    );
    expect(t.acceptance).toEqual([{ text: "real", checked: false }]);
    expect(t.blockers).toEqual([]);
  });

  it("drops blank checklist items from the untouched template", () => {
    expect(parseTicket("## Acceptance\n- [ ] \n- [ ]\n").acceptance).toEqual([]);
  });

  it("returns empty values for missing sections", () => {
    expect(parseTicket("")).toEqual({
      currentThinking: "",
      acceptance: [],
      blockers: [],
      outOfScope: "",
      blockersError: expect.any(String),
    });
  });
});

describe("checkTicket", () => {
  it("passes the happy path", async () => {
    expect(await checkTicket(parseTicket(body), allClosed)).toEqual({ ok: true });
  });

  it("fails on missing acceptance", async () => {
    const result = await checkTicket(parseTicket("## Blockers\nNone\n"), allClosed);
    expect(result.ok).toBe(false);
    expect(result).toMatchObject({ missing: [expect.stringContaining("Acceptance")] });
  });

  it("fails on empty acceptance", async () => {
    const result = await checkTicket(parseTicket("## Acceptance\n\nprose only\n"), allClosed);
    expect(result.ok).toBe(false);
  });

  it("fails on an open blocker", async () => {
    const result = await checkTicket(parseTicket(body), async (n) => n !== 4);
    expect(result).toEqual({ ok: false, missing: ["Blocker #4 is still open"] });
  });

  it("lists every reason", async () => {
    const result = await checkTicket(
      parseTicket("## Blockers\n#1 #2\n"),
      async () => false,
    );
    expect(result).toEqual({
      ok: false,
      missing: [
        "Acceptance section is missing or has no checklist items",
        "Blocker #1 is still open",
        "Blocker #2 is still open",
      ],
    });
  });

  it("fails when the Blockers section is missing", async () => {
    const result = await checkTicket(parseTicket("## Acceptance\n- [ ] a\n"), allClosed);
    expect(result).toEqual({
      ok: false,
      missing: ["Blockers section is missing or must be None or a list of #N"],
    });
  });

  it("fails when Blockers is prose with no #N", async () => {
    const result = await checkTicket(
      parseTicket("## Acceptance\n- [ ] a\n## Blockers\nDepends on the parser work\n"),
      allClosed,
    );
    expect(result.ok).toBe(false);
  });

  it("fails when Blockers is empty or only a comment", async () => {
    const result = await checkTicket(
      parseTicket("## Acceptance\n- [ ] a\n## Blockers\n<!-- none yet -->\n"),
      allClosed,
    );
    expect(result.ok).toBe(false);
  });

  it("does not call isClosed when there are no blockers", async () => {
    const isClosed = vi.fn(allClosed);
    await checkTicket(parseTicket("## Acceptance\n- [ ] a\n## Blockers\nNone\n"), isClosed);
    expect(isClosed).not.toHaveBeenCalled();
  });

  it("fails closed when isClosed rejects", async () => {
    const result = await checkTicket(parseTicket(body), async (n) => {
      if (n === 3) throw new Error("lookup failed");
      return true;
    });
    expect(result).toEqual({ ok: false, missing: ["Could not verify blocker #3"] });
  });

  it("fails closed when isClosed throws synchronously", async () => {
    const result = await checkTicket(parseTicket(body), () => {
      throw new Error("boom");
    });
    expect(result.ok).toBe(false);
  });

  it("fails closed when isClosed returns a non-boolean", async () => {
    const result = await checkTicket(parseTicket(body), (async () => undefined) as never);
    expect(result.ok).toBe(false);
  });
});

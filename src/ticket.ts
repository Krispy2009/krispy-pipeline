export interface AcceptanceItem {
  text: string;
  checked: boolean;
}

export interface Ticket {
  currentThinking: string;
  acceptance: AcceptanceItem[];
  blockers: number[];
  outOfScope: string;
}

export type TicketCheck = { ok: true } | { ok: false; missing: string[] };

const COMMENT = /<!--[\s\S]*?-->/g;
const HEADING = /^## (.*?)\s*$/;
const ITEM = /^\s*[-*] \[( |x|X)\][ \t]*(.*)$/;

function sections(body: string): Map<string, string> {
  const result = new Map<string, string>();
  let name: string | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (name !== undefined && !result.has(name)) result.set(name, lines.join("\n"));
  };
  for (const line of body.replace(COMMENT, "").split(/\r?\n/)) {
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      name = (heading[1] ?? "").toLowerCase();
      lines = [];
    } else {
      lines.push(line);
    }
  }
  flush();
  return result;
}

function parseAcceptance(text: string): AcceptanceItem[] {
  const items: AcceptanceItem[] = [];
  for (const line of text.split("\n")) {
    const match = ITEM.exec(line);
    const itemText = match?.[2]?.trim();
    if (match && itemText) items.push({ text: itemText, checked: match[1] !== " " });
  }
  return items;
}

function parseBlockers(text: string): number[] {
  if (text.trim().toLowerCase() === "none") return [];
  const numbers = [...text.matchAll(/#(\d+)/g)].map((m) => Number(m[1]));
  return [...new Set(numbers)];
}

export function parseTicket(body: string): Ticket {
  const found = sections(body);
  const get = (name: string): string => found.get(name) ?? "";
  return {
    currentThinking: get("current thinking").trim(),
    acceptance: parseAcceptance(get("acceptance")),
    blockers: parseBlockers(get("blockers")),
    outOfScope: get("out of scope").trim(),
  };
}

export async function checkTicket(
  ticket: Ticket,
  isClosed: (n: number) => Promise<boolean>,
): Promise<TicketCheck> {
  const missing: string[] = [];
  if (ticket.acceptance.length === 0) {
    missing.push("Acceptance section is missing or has no checklist items");
  }
  const results = await Promise.allSettled(
    ticket.blockers.map(async (n) => {
      try {
        return await isClosed(n);
      } catch {
        return undefined;
      }
    }),
  );
  results.forEach((result, i) => {
    const n = ticket.blockers[i];
    const closed = result.status === "fulfilled" ? result.value : undefined;
    if (closed === true) return;
    missing.push(
      closed === false
        ? `Blocker #${n} is still open`
        : `Could not verify blocker #${n}`,
    );
  });
  return missing.length === 0 ? { ok: true } : { ok: false, missing };
}

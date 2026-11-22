import { describe, expect, it } from "vitest";
import { LauncherEvent, type EventSource } from "../events.js";

/** One independent instance of a source under test, with its own state. */
export interface ContractHarness {
  source: EventSource;
  /**
   * Makes the harness's fixed set of GitHub changes happen and lets the source observe them (for a poller, advance
   * time; for a webhook source, deliver the payloads). Every harness from the same factory makes the same changes.
   */
  change(): Promise<void>;
  cleanup(): Promise<void>;
}

/**
 * The contract every `EventSource` meets (ADR 0008): its events parse with `LauncherEvent`, and the same GitHub
 * change always yields the same `id`, however many times or by however many instances it is observed.
 */
export function describeEventSourceContract(name: string, makeHarness: () => Promise<ContractHarness>): void {
  async function observe(): Promise<unknown[]> {
    const harness = await makeHarness();
    const events: unknown[] = [];
    try {
      await harness.source.start((event) => {
        events.push(event);
      });
      await harness.change();
      await harness.source.stop();
    } finally {
      await harness.cleanup();
    }
    return events;
  }

  describe(`EventSource contract: ${name}`, () => {
    it("emits events that parse with LauncherEvent", async () => {
      const events = await observe();
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) expect(LauncherEvent.safeParse(event).error).toBeUndefined();
    });

    it("derives the same id for the same GitHub change", async () => {
      const ids = (events: unknown[]): string[] => events.map((e) => LauncherEvent.parse(e).id).sort();
      const first = ids(await observe());
      const second = ids(await observe());
      expect(first.length).toBeGreaterThan(0);
      expect(second).toEqual(first);
    });

    it("emits nothing after stop()", async () => {
      const harness = await makeHarness();
      const events: unknown[] = [];
      try {
        await harness.source.start((event) => {
          events.push(event);
        });
        await harness.source.stop();
        await harness.change();
      } finally {
        await harness.cleanup();
      }
      expect(events).toEqual([]);
    });
  });
}

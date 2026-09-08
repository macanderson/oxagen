/**
 * The records the stdio fixture serves.
 *
 * Separate from `stdio-fixture.ts` because that module starts a provider on
 * import. The test needs to know which id to expect and must not start one in
 * its own process, so the data it shares with the fixture lives here, where
 * importing it does nothing.
 */
import type { MemoryRecord } from "@oxagen/engram";
import { fakeRecord } from "./fake-store";

export const FIXTURE_RECORD_ID = "1".repeat(64);

export const FIXTURE_NAMESPACE = { org: "acme", workspace: "platform" };

export const FIXTURE_VERSION = "0.1.0-fixture";

export function fixtureRecords(): MemoryRecord[] {
  return [
    fakeRecord({
      id: FIXTURE_RECORD_ID,
      kind: "episodic",
      body: { text: "the deploy failed at 3am" },
      salience: 0.8,
    }),
  ];
}

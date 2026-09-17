import { beforeEach, describe, expect, it } from "vitest";
import {
  hasColumn,
  NEGATIVE_PROBE_TTL_MS,
  resetColumnProbesForTests,
  type ColumnRef,
  type ProbeTx,
} from "./column-probe";

const HOSTS: ColumnRef = {
  schema: "tacho",
  table: "hosts",
  column: "gateway_last_seen_at",
};
const SESSIONS: ColumnRef = {
  schema: "tacho",
  table: "sessions",
  column: "gateway_observed_at",
};
const SHARED = "shared";
const DEDICATED = "dedicated:9f2c";

/**
 * A transaction that answers `information_schema` from a set of columns it
 * claims to have, and counts what it was asked.
 *
 * It models the one property that matters about the real thing and that a
 * catch-and-retry probe got wrong: a statement naming an absent column ABORTS
 * the transaction. Here the probe never issues such a statement, so the
 * fixture never has to — which is the point. `throwOnNonProbe` asserts it:
 * anything but an `information_schema` read is a test failure, because a probe
 * that reached the table it is asking about would be the bug.
 */
function fakeTx(present: string[]): ProbeTx & { probes: number } {
  const owned = new Set(present);
  const tx = {
    probes: 0,
    execute(query: unknown) {
      const text = JSON.stringify(query);
      if (!text.includes("information_schema")) {
        throw new Error(`probe issued a non-information_schema statement`);
      }
      tx.probes += 1;
      // Which column was asked about: the ref's three parts arrive as bound
      // parameters, so match on whichever of the known columns appears.
      const asked = [...owned].find((column) => text.includes(column));
      return asked === undefined ? [] : [{ "?column?": 1 }];
    },
  };
  // Through `unknown`: the fixture answers with plain rows, while `execute`
  // is declared to return Drizzle's `PgRaw`. Nothing here touches the parts
  // that differ — the probe reads the result as an iterable and nothing else.
  return tx as unknown as ProbeTx & { probes: number };
}

describe("hasColumn", () => {
  beforeEach(() => {
    resetColumnProbesForTests();
  });

  it("reports a column the database has", async () => {
    const tx = fakeTx(["gateway_last_seen_at"]);
    expect(await hasColumn(tx, HOSTS, SHARED, 1_000)).toBe(true);
  });

  it("reports a column the database does not have yet", async () => {
    const tx = fakeTx([]);
    expect(await hasColumn(tx, HOSTS, SHARED, 1_000)).toBe(false);
  });

  it("asks once for a positive answer and keeps it", async () => {
    const tx = fakeTx(["gateway_last_seen_at"]);
    expect(await hasColumn(tx, HOSTS, SHARED, 1_000)).toBe(true);
    expect(await hasColumn(tx, HOSTS, SHARED, 9_000_000)).toBe(true);
    // A column that exists does not stop existing, so no clock advances this.
    expect(tx.probes).toBe(1);
  });

  it("keeps a negative answer only until the TTL expires", async () => {
    const tx = fakeTx([]);
    expect(await hasColumn(tx, HOSTS, SHARED, 1_000)).toBe(false);
    // Inside the window: answered from the cached miss.
    expect(
      await hasColumn(tx, HOSTS, SHARED, 1_000 + NEGATIVE_PROBE_TTL_MS - 1),
    ).toBe(false);
    expect(tx.probes).toBe(1);
    // At the boundary: asked again. This is the regression that mattered —
    // caching the miss for the life of the process meant an instance started
    // before a hand-applied migration never noticed it afterwards.
    expect(
      await hasColumn(tx, HOSTS, SHARED, 1_000 + NEGATIVE_PROBE_TTL_MS),
    ).toBe(false);
    expect(tx.probes).toBe(2);
  });

  it("sees a migration applied after a negative answer", async () => {
    const before = fakeTx([]);
    expect(await hasColumn(before, HOSTS, SHARED, 1_000)).toBe(false);
    const after = fakeTx(["gateway_last_seen_at"]);
    expect(
      await hasColumn(after, HOSTS, SHARED, 1_000 + NEGATIVE_PROBE_TTL_MS),
    ).toBe(true);
  });

  it("answers per plane, not per process (ADR-042)", async () => {
    // One process serves organisations on different physical databases, and a
    // dedicated plane receives its migrations separately from the shared one.
    // Keyed by column alone, the shared plane's `true` would be handed to the
    // dedicated plane, the compatibility projection would be dropped, and the
    // query this exists to protect would raise 42703.
    const migrated = fakeTx(["gateway_last_seen_at"]);
    expect(await hasColumn(migrated, HOSTS, SHARED, 1_000)).toBe(true);
    const behind = fakeTx([]);
    expect(await hasColumn(behind, HOSTS, DEDICATED, 1_000)).toBe(false);
    // The dedicated plane was actually asked rather than answered from the
    // shared plane's cache entry.
    expect(behind.probes).toBe(1);
  });

  it("answers per column rather than per process", async () => {
    // The two Tacho gateway columns ship in one migration whose statements are
    // both `ADD COLUMN IF NOT EXISTS`, so a run that fails between them leaves
    // exactly this state. One shared answer would get it wrong.
    const tx = fakeTx(["gateway_last_seen_at"]);
    expect(await hasColumn(tx, HOSTS, SHARED, 1_000)).toBe(true);
    expect(await hasColumn(tx, SESSIONS, SHARED, 1_000)).toBe(false);
    expect(tx.probes).toBe(2);
  });
});

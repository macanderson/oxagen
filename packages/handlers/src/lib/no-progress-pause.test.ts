// The pause behind an enforced no-progress limit (#4490), against an
// in-memory store that keeps the NoProgressPauseStore contract: a reachable
// run takes one pause, a retry for the same loop takes none (#4503), and a
// run that cannot take a command answers its block with no row written. The
// Postgres store's lookup is read back as SQL.
import { describe, expect, it, vi } from "vitest";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { NoProgressPauseRequest } from "@oxagen/billing";

vi.mock("../logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import type {
  CommandRowInput,
  CommandStore,
  RecipientSession,
} from "../tacho.command.dispatch";
import {
  NO_PROGRESS_LOOP_PAYLOAD_KEY,
  type NoProgressPauseDeps,
  noProgressPauseReason,
  pauseForNoProgress,
  postgresNoProgressPauseStore,
} from "./no-progress-pause";

const ORG = "00000000-0000-4000-8000-000000000001";
const WORKSPACE = "00000000-0000-4000-8000-000000000002";
const NOW = new Date("2026-10-01T12:00:00.000Z");
const RUN = "tse_0000000000000000000001";
const SESSION_UUID = "00000000-0000-4000-8000-0000000000aa";

function loop(n: number, tool = "Bash") {
  return {
    tool,
    inputDigest: "sha256:poll",
    outputDigest: "sha256:pending",
    loop: n,
    repeats: 20,
    atCall: 20 * n,
    key: JSON.stringify([tool, "sha256:poll", "sha256:pending", n]),
  };
}

function request(
  over: Partial<NoProgressPauseRequest> = {},
): NoProgressPauseRequest {
  return {
    runId: RUN,
    orgId: ORG,
    workspaceId: WORKSPACE,
    sealed: false,
    loops: [loop(1)],
    limit: { repeats: 20, mode: "enforced" },
    ...over,
  };
}

function session(over: Partial<RecipientSession> = {}): RecipientSession {
  return {
    id: "00000000-0000-4000-8000-0000000000bb",
    publicId: RUN,
    sessionUuid: SESSION_UUID,
    hostId: "00000000-0000-4000-8000-0000000000cc",
    agentKey: "acme.core.reviewer",
    runtime: "claude-code",
    outcome: "running",
    sealSource: null,
    enforcementTier: "harness",
    host: {
      status: "active",
      lastSeenAt: new Date(NOW.getTime() - 30_000),
      bundleFeatures: [],
    },
    ...over,
  };
}

/** `tacho.control_commands` in memory, with the reads and writes a pause makes. */
function fakeStore(found: RecipientSession | null = session()) {
  const rows: (CommandRowInput & { publicId: string })[] = [];
  const superseded: string[] = [];
  const unused = () => {
    throw new Error("a no-progress pause does not make this call");
  };
  const commands: CommandStore = {
    session: unused,
    liveSessions: unused,
    ledgerRunExists: unused,
    setLedgerPaused: unused,
    cancelLedgerRun: unused,
    queueForNextRun: unused,
    insert: async (row) => {
      const publicId = `tcm_${rows.length + 1}`;
      rows.push({ ...row, publicId });
      return { publicId };
    },
    supersede: async ({ successorPublicId }) => {
      superseded.push(successorPublicId);
      return 0;
    },
  };
  const sessionRead = vi.fn(async () => found);
  const deps: NoProgressPauseDeps = {
    withStore: async (_scope, fn) =>
      fn({
        session: sessionRead,
        pauseFor: async (_s, runPublicId, keys) =>
          rows.find(
            (r) =>
              r.session.publicId === runPublicId &&
              r.command === "pause" &&
              keys.includes(r.payload[NO_PROGRESS_LOOP_PAYLOAD_KEY] as string),
          )?.publicId ?? null,
        commands,
      }),
    now: () => NOW,
  };
  return { rows, superseded, sessionRead, deps };
}

describe("pauseForNoProgress", () => {
  it("queues one pause for a run its host can reach, with the limit as the reason and no issuer", async () => {
    const { rows, superseded, deps } = fakeStore();
    const out = await pauseForNoProgress(request(), deps);
    expect(out).toEqual({ paused: true, commandId: "tcm_1" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      command: "pause",
      outcome: "queued",
      outcomeDetail: null,
      issuedByUserId: null,
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 3_600_000),
      reason:
        "No-progress limit of 20: Bash ran 20 times in a row with an unchanged result.",
      payload: {
        address: RUN,
        session_uuid: SESSION_UUID,
        [NO_PROGRESS_LOOP_PAYLOAD_KEY]: loop(1).key,
      },
    });
    // The new pause replaces any earlier queued pause, as an operator's does.
    expect(superseded).toEqual(["tcm_1"]);
  });

  it("queues no second pause when a retry asks again for the same loop (#4503)", async () => {
    const { rows, deps } = fakeStore();
    await pauseForNoProgress(request(), deps);
    // The check's write failed after the pause, so it retries. The run has
    // grown a second loop since, and the first one still leads.
    const retry = await pauseForNoProgress(
      request({ loops: [loop(1), loop(2)] }),
      deps,
    );
    expect(retry).toEqual({ paused: true, commandId: "tcm_1" });
    expect(rows).toHaveLength(1);
  });

  it("queues a new pause for a loop that has none", async () => {
    const { rows, deps } = fakeStore();
    await pauseForNoProgress(request(), deps);
    const next = await pauseForNoProgress(request({ loops: [loop(2)] }), deps);
    expect(next).toEqual({ paused: true, commandId: "tcm_2" });
    expect(rows).toHaveLength(2);
  });

  it.each([
    [
      "host_offline",
      session({
        host: {
          status: "active",
          lastSeenAt: new Date(NOW.getTime() - 10 * 60_000),
          bundleFeatures: [],
        },
      }),
    ],
    ["no_host", session({ host: null })],
    [
      "host_revoked",
      session({
        host: { status: "revoked", lastSeenAt: NOW, bundleFeatures: [] },
      }),
    ],
    ["run_sealed", session({ outcome: "completed" })],
  ] as const)(
    "answers %s and writes no row when the run cannot take the pause (negative)",
    async (block, found) => {
      const { rows, deps } = fakeStore(found);
      expect(await pauseForNoProgress(request(), deps)).toEqual({
        paused: false,
        block,
      });
      expect(rows).toEqual([]);
    },
  );

  it("answers no_connection_point for a ledger run, whose pause holds no call", async () => {
    const { rows, sessionRead, deps } = fakeStore();
    const out = await pauseForNoProgress(
      request({ runId: "arun_0000000000000000000001" }),
      deps,
    );
    expect(out).toEqual({ paused: false, block: "no_connection_point" });
    expect(sessionRead).not.toHaveBeenCalled();
    expect(rows).toEqual([]);
  });

  it("answers no_connection_point for a run with no root session in the scope (negative)", async () => {
    const { rows, deps } = fakeStore(null);
    expect(await pauseForNoProgress(request(), deps)).toEqual({
      paused: false,
      block: "no_connection_point",
    });
    expect(rows).toEqual([]);
  });

  it("answers no_connection_point for a request that names no loop (negative)", async () => {
    const { sessionRead, deps } = fakeStore();
    expect(await pauseForNoProgress(request({ loops: [] }), deps)).toEqual({
      paused: false,
      block: "no_connection_point",
    });
    expect(sessionRead).not.toHaveBeenCalled();
  });
});

describe("noProgressPauseReason", () => {
  it("keeps a long tool name inside the 512 characters a pause reason takes", () => {
    const reason = noProgressPauseReason(
      { tool: `mcp__${"x".repeat(600)}`, repeats: 1_000 },
      20,
    );
    expect(reason.length).toBeLessThanOrEqual(512);
    expect(reason).toMatch(/^No-progress limit of 20: mcp__x+… ran 1000 times/);
  });
});

describe("the Postgres store", () => {
  const dialect = new PgDialect();
  const scope = { orgId: ORG, workspaceId: WORKSPACE };

  it("finds an earlier pause by the loop key on the run's pause rows", async () => {
    const seen: { sql: string; params: unknown[] }[] = [];
    const chain = {
      from: () => chain,
      where: (cond: SQL) => {
        seen.push(dialect.sqlToQuery(cond));
        return chain;
      },
      orderBy: () => chain,
      limit: () => Promise.resolve([{ publicId: "tcm_9" }]),
    };
    const tx = { select: () => chain } as never;
    await expect(
      postgresNoProgressPauseStore(tx).pauseFor(scope, RUN, ["k1", "k2"]),
    ).resolves.toBe("tcm_9");
    expect(seen[0]?.sql).toMatch(/"target_kind" = \$\d/);
    expect(seen[0]?.sql).toMatch(/"command" = \$\d/);
    expect(seen[0]?.sql).toMatch(/"payload"->>\$\d+ in \(\$\d+, \$\d+\)/);
    expect(seen[0]?.params).toEqual(
      expect.arrayContaining([
        ORG,
        WORKSPACE,
        "run",
        RUN,
        "pause",
        NO_PROGRESS_LOOP_PAYLOAD_KEY,
        "k1",
        "k2",
      ]),
    );
  });

  it("reads nothing for no keys", async () => {
    const tx = {
      select: () => {
        throw new Error("no read for no keys");
      },
    } as never;
    await expect(
      postgresNoProgressPauseStore(tx).pauseFor(scope, RUN, []),
    ).resolves.toBeNull();
  });
});

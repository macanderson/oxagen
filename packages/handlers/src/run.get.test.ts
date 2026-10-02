import { CapabilityError } from "@oxagen/oxagen/kernel";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import {
  AGENT_FRAME_LIMIT_DEFAULT,
  AGENT_FRAME_LIMIT_MAX,
  FRAME_LIMIT_DEFAULT,
  RUN_CHAIN_HEADS_MAX,
  runGet,
} from "@oxagen/oxagen/contracts/run.get";
import type { AttemptEventReadRecord } from "@oxagen/run-ledger";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { describe, expect, it, vi } from "vitest";
import {
  chainsCursor,
  createRunGetHandler,
  decodeFrameCursor,
  decodeFramePosition,
  encodeFrameCursor,
  type PlaceRepository,
  POLL_INTERVAL_MS,
  type RunGetDeps,
} from "./run.get";
import type { PauseCommandRow, PausePosition } from "./lib/run-pause";
import type { SessionConfig } from "./lib/run-work";
import { encodeRunCursor, type RunScope } from "./run.list";
import {
  ctx,
  event,
  inAppLedgerRun,
  ledgerRun,
  memoryChainHeads,
  memoryEvents,
  memoryStores,
  memorySubagentChains,
  memorySubagentFrames,
  memoryTachoFrames,
  OTHER_WORKSPACE,
  rollupCostRow,
  seal,
  subagentChain,
  type SubagentChainFixture,
  summary,
  tachoRow,
  tachoSession,
} from "./run.test-support";

const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";

type Over = {
  ledger?: Parameters<typeof memoryStores>[0];
  tacho?: Parameters<typeof memoryStores>[1];
  events?: AttemptEventReadRecord[];
  /** The wrapped session's `tacho_events` rows. */
  tachoRows?: TachoFrameRow[];
  /** What RunStore answers for the public id; defaults to the seeded run. */
  found?: boolean;
  /** The worker run the tacho fixture witnessed; none by default. */
  witnessFor?: string;
  /** The harness title the wrapped session recorded; none by default. */
  sessionTitle?: string;
  /** The title read rejects, as a ClickHouse outage would. */
  titleFails?: boolean;
  /** The effort and thinking the session's frames recorded; none by default. */
  sessionConfig?: SessionConfig;
  /** The settings read rejects, as a ClickHouse outage would. */
  configFails?: boolean;
  /** The frame read rejects, as ClickHouse over its memory cap does. */
  framesFail?: boolean;
  /** The run's stored Model fit columns; none by default. */
  storedFit?: Awaited<ReturnType<RunGetDeps["storedFit"]>>;
  /** The fit read rejects. */
  fitFails?: boolean;
  /** The connected repositories by remote digest; none by default. */
  repositories?: Record<string, PlaceRepository>;
  /** The repository read rejects, as a Postgres timeout would. */
  repositoryFails?: boolean;
  /** Every digest the repository read was asked for. */
  repositoryAsked?: string[];
  /** Runs after each fake sleep, with the count so far; a test lands events here. */
  onSleep?: (count: number, log: AttemptEventReadRecord[]) => void;
  /** The run's pause and resume rows. The pause is read only when this or `pauseFails` is set. */
  pauseRows?: PauseCommandRow[];
  /** The pause read rejects, as a Postgres timeout would. */
  pauseFails?: boolean;
  /** Every run the pause read was asked for. */
  pauseAsked?: string[];
  /** The turn and step at the pause frame; none counted by default. */
  position?: PausePosition;
  /** The position read rejects, as ClickHouse over its memory cap does. */
  positionFails?: boolean;
  /** Every chain and seq the position read was asked for. */
  positionAsked?: [string, number][];
  /** Stands in for `resolveActingUserId`; the real one by default. */
  actingUserId?: RunGetDeps["actingUserId"];
};

function harness(over: Over = {}) {
  const stores = memoryStores(
    over.ledger ?? [
      ledgerRun({
        publicId: LEDGER_ID,
        runId: RUN_UUID,
        cost: rollupCostRow(),
      }),
    ],
    over.tacho ?? [tachoSession({ publicId: TACHO_ID })],
  );
  const log = over.events ?? [];
  let clock = 1_000_000;
  const sleeps: number[] = [];
  const fitReads: Parameters<RunGetDeps["storedFit"]>[1][] = [];
  const deps: RunGetDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (publicId) =>
        Promise.resolve(
          over.found === false || publicId !== LEDGER_ID ? null : summary(),
        ),
      readAttemptEventsSince: memoryEvents(log),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: (scope, runId) =>
      Promise.resolve(
        runId === TACHO_ID && scope.workspaceId === ctx().workspaceId
          ? (over.witnessFor ?? null)
          : null,
      ),
    tachoFrames:
      over.framesFail === true
        ? () =>
            Promise.reject(
              new Error("Code: 241. Memory limit (total) exceeded"),
            )
        : memoryTachoFrames(SESSION_UUID, over.tachoRows ?? []),
    sessionTitle: (sessionUuid) =>
      over.titleFails === true
        ? Promise.reject(new Error("clickhouse unreachable"))
        : Promise.resolve(
            sessionUuid === SESSION_UUID ? (over.sessionTitle ?? null) : null,
          ),
    sessionConfig: (sessionUuid) =>
      over.configFails === true
        ? Promise.reject(new Error("clickhouse unreachable"))
        : Promise.resolve(
            sessionUuid === SESSION_UUID && over.sessionConfig
              ? over.sessionConfig
              : { effort: null, effortSource: null, thinking: null },
          ),
    storedFit: (_scope, target) => {
      fitReads.push(target);
      return over.fitFails === true
        ? Promise.reject(new Error("postgres unreachable"))
        : Promise.resolve(over.storedFit ?? null);
    },
    sessionRepository: (_scope, digest) => {
      over.repositoryAsked?.push(digest);
      return over.repositoryFails === true
        ? Promise.reject(new Error("postgres timeout"))
        : Promise.resolve(over.repositories?.[digest] ?? null);
    },
    ...(over.actingUserId === undefined
      ? {}
      : { actingUserId: over.actingUserId }),
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      over.onSleep?.(sleeps.length, log);
      return Promise.resolve();
    },
    ...(over.pauseRows === undefined && over.pauseFails !== true
      ? {}
      : {
          pause: {
            pauseCommands: (_scope: RunScope, runPublicId: string) => {
              over.pauseAsked?.push(runPublicId);
              return over.pauseFails === true
                ? Promise.reject(new Error("postgres timeout"))
                : Promise.resolve(over.pauseRows ?? []);
            },
            pausePosition: (sessionUuid: string, seq: number) => {
              over.positionAsked?.push([sessionUuid, seq]);
              return over.positionFails === true
                ? Promise.reject(new Error("Code: 241. Memory limit exceeded"))
                : Promise.resolve(over.position ?? { turn: null, step: null });
            },
          },
        }),
  };
  return { get: createRunGetHandler(deps), log, sleeps, stores, fitReads };
}

const input = (
  over: Partial<Parameters<ReturnType<typeof harness>["get"]>[0]> = {},
) => ({ runId: LEDGER_ID, frameLimit: 200, waitMs: 0, ...over });

describe("get_run", () => {
  it("answers a wrapped session's header and its frames from the tacho seam, from seq 0, with body references and cost records", async () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const { get, sleeps } = harness({
      tacho: [
        tachoSession({ publicId: TACHO_ID, session: { replayGrade: "view" } }),
      ],
      tachoRows: [
        tachoRow(0, { kind: "agent_start", toolName: "", toolStatus: "" }),
        tachoRow(1, {
          contentDigest: digest,
          bytesRef: "evb:v1:k:" + "c".repeat(64),
          redactions:
            '[{"path":"bytes:0-4","reason":"jwt","original_digest":"sha256:' +
            "d".repeat(64) +
            '"}]',
        }),
        tachoRow(2, {
          kind: "llm_call",
          toolName: "",
          toolStatus: "",
          model: "claude-haiku-4.5",
          provider: "anthropic",
          contentDigest: digest,
          costUsdMicros: 1_250,
        }),
      ],
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run).toMatchObject({
      id: TACHO_ID,
      source: "tacho",
      // No rollup row yet: no cost, never a zero.
      cost: null,
      replayGrade: "view",
    });
    expect(out.frames.frames.map((f) => f.seq)).toEqual(["0", "1", "2"]);
    expect(out.frames.frames[0]).toMatchObject({
      type: "agent_start",
      stage: "session",
      body: {
        digest: null,
        bytesRef: null,
        redactions: [],
        fidelity: "digest_only",
      },
      cost: null,
    });
    expect(out.frames.frames[1]).toMatchObject({
      type: "tool_call",
      stage: "tool",
      summary: "Read ok",
      body: {
        digest,
        bytesRef: "evb:v1:k:" + "c".repeat(64),
        redactions: [
          {
            path: "bytes:0-4",
            reason: "jwt",
            originalDigest: `sha256:${"d".repeat(64)}`,
          },
        ],
        fidelity: "full",
      },
    });
    expect(out.frames.frames[2]).toMatchObject({
      summary: "anthropic/claude-haiku-4.5",
      body: { digest, bytesRef: null, fidelity: "digest_only" },
      cost: { micros: "1250", currency: "USD", basis: "client_attested" },
    });
    // The session is sealed and the page held every frame, so there is no
    // cursor to continue from; a frame's own cursor still resumes it.
    expect(out.frames.cursor).toBeNull();
    expect(sleeps).toEqual([]);

    // A frame's cursor resumes a wrapped session the same way.
    const rest = await get(
      input({ runId: TACHO_ID, framesAfter: out.frames.frames[0]?.cursor }),
      ctx(),
    );
    expect(rest.frames.frames.map((f) => f.seq)).toEqual(["1", "2"]);
  });

  it("carries a ledger frame's body reference and the seal's recorded grade", async () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const { get } = harness({
      ledger: [
        ledgerRun({
          publicId: LEDGER_ID,
          runId: RUN_UUID,
          seal: seal(RUN_UUID, { replayGrade: "view" }),
        }),
      ],
      events: [
        event(1, {
          body: {
            bodyRef: "evb:v1:k:" + "a".repeat(64),
            bodyDigest: digest,
            bodyBytes: 12,
            redactions: [],
            fidelity: "full",
          },
        }),
        event(2, {
          body: {
            bodyRef: null,
            bodyDigest: digest,
            bodyBytes: 12,
            redactions: [],
            fidelity: "digest_only",
          },
        }),
      ],
    });
    const out = await get(input(), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run.replayGrade).toBe("view");
    expect(out.frames.frames.map((f) => f.body)).toEqual([
      {
        digest,
        bytesRef: "evb:v1:k:" + "a".repeat(64),
        redactions: [],
        fidelity: "full",
      },
      { digest, bytesRef: null, redactions: [], fidelity: "digest_only" },
    ]);
    // A ledger frame carries no cost record: spend is metered per run.
    expect(out.frames.frames.every((f) => f.cost === null)).toBe(true);
  });

  it("answers a wrapped session's cost from its rollup row with the basis recorded there", async () => {
    const { get } = harness({
      tacho: [
        tachoSession({
          publicId: TACHO_ID,
          cost: rollupCostRow({ costMicros: 97_937n, costBasis: "mixed" }),
        }),
      ],
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.cost).toEqual({
      micros: "97937",
      currency: "USD",
      basis: "mixed",
    });
  });

  it("answers a ledger run's header and a first frame page whose cursor resumes it", async () => {
    const { get } = harness({ events: [event(1), event(2), event(3)] });
    const out = await get(input(), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run).toMatchObject({
      id: LEDGER_ID,
      source: "ledger",
      operatorId: "prn_0123456789abcdefghjkmn",
      cost: { micros: "12500", currency: "USD", basis: "gateway_observed" },
      taskRef: "review the PR",
    });
    // The ledger records no harness, and the row says so with a null key.
    expect(out.run).toHaveProperty("harness", null);
    expect(out.frames?.frames.map((f) => f.seq)).toEqual(["1", "2", "3"]);
    // Sealed, and the page held the whole recording: nothing to continue from.
    expect(out.frames?.cursor).toBeNull();
    expect(out.frames?.frames[0]).toMatchObject({
      type: "tool.call_completed",
      stage: "act",
      summary: "read_file ok",
      digest: event(1).eventDigest,
      observedAt: "2026-09-11T10:00:01.000Z",
    });
  });

  // #3999: get_run shares list_runs' row, so it answers the stamped role too.
  it("answers the operator's stamped workspace role, and null for a run from before the stamp", async () => {
    const stamped = ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID });
    const { get } = harness({
      ledger: [{ ...stamped, run: { ...stamped.run, operatorRole: "Admin" } }],
      tacho: [tachoSession({ publicId: TACHO_ID })],
    });
    const ledger = await get(input(), ctx());
    expect(runGet.output.parse(ledger)).toEqual(ledger);
    // Stored lowercased; a capitalized value still reads as the role.
    expect(ledger.run.operatorRole).toBe("admin");
    const wrapped = await get(input({ runId: TACHO_ID }), ctx());
    expect(wrapped.run.operatorRole).toBeNull();
  });

  // ADR-182 rule 3: a fact is never written into a label for a client to
  // parse. The Run page pairs a parked receipt with its approval on
  // `approvalId`, and reads the tool and how it ended from their own fields.
  it("answers a parked receipt's approval, tool and outcome as fields, and none of them only in its label", async () => {
    const APPROVAL = "apr_0a1b2c3d4e5f6g7h8j9k0m";
    const receipt = (runSeq: number, payload: Record<string, unknown>) =>
      event(runSeq, {
        eventType: "tool.engine_call_completed",
        payload: {
          engine_seq: runSeq,
          tool_call_id: `tc_${runSeq}`,
          tool_name: "create_workspace",
          input_digest: `sha256:${"b".repeat(64)}`,
          duration_ms: 4,
          ...payload,
        },
      });
    const { get } = harness({
      events: [
        receipt(1, { outcome: "parked", approval_public_id: APPROVAL }),
        receipt(2, { outcome: "parked" }),
        event(3),
      ],
    });
    const out = await get(input(), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    const [named, unnamed, other] = out.frames?.frames ?? [];
    expect(named).toMatchObject({
      summary: "create_workspace parked",
      tool: "create_workspace",
      toolStatus: "parked",
      approvalId: APPROVAL,
    });
    expect(named?.summary).not.toContain(APPROVAL);
    expect(unnamed).toMatchObject({ toolStatus: "parked", approvalId: null });
    // A call that waits on nothing names no approval.
    expect(other).toMatchObject({
      tool: "read_file",
      toolStatus: "ok",
      approvalId: null,
    });
  });

  it("resumes from the page cursor and from a frame's own cursor with no duplicate and no gap", async () => {
    const { get } = harness({ events: [1, 2, 3, 4, 5].map((n) => event(n)) });
    const first = await get(input({ frameLimit: 2 }), ctx());
    const second = await get(
      input({ frameLimit: 2, framesAfter: first.frames?.cursor ?? "" }),
      ctx(),
    );
    const third = await get(
      input({ frameLimit: 2, framesAfter: second.frames?.cursor ?? "" }),
      ctx(),
    );
    const seqs = [first, second, third].flatMap(
      (o) => o.frames?.frames.map((f) => f.seq) ?? [],
    );
    expect(seqs).toEqual(["1", "2", "3", "4", "5"]);
    // The first two pages were full with a frame behind them; the third was
    // the end of a sealed run, so it carries no cursor and a pager stops.
    expect(first.frames?.cursor).not.toBeNull();
    expect(second.frames?.cursor).not.toBeNull();
    expect(third.frames?.cursor).toBeNull();

    // The SSE client resumes from the last frame it rendered.
    const lastFrame = second.frames?.frames.at(-1);
    const fromFrame = await get(
      input({ framesAfter: lastFrame?.cursor ?? "" }),
      ctx(),
    );
    expect(fromFrame.frames?.frames.map((f) => f.seq)).toEqual(["5"]);

    // Past the end: nothing, and the caller keeps its cursor.
    const end = await get(
      input({ framesAfter: third.frames?.frames.at(-1)?.cursor ?? "" }),
      ctx(),
    );
    expect(end.frames).toEqual({ frames: [], cursor: null });
  });

  it("refuses a frame cursor it did not write, a list cursor included (negative)", async () => {
    const { get } = harness();
    for (const framesAfter of [
      "garbage",
      encodeRunCursor({ at: "2026-09-11T10:00:00.000Z", id: LEDGER_ID }),
      Buffer.from("f:-1").toString("base64url"),
      Buffer.from("f:").toString("base64url"),
      // Past int8 max: the ledger's bigint column never held it, so the
      // handler never wrote it.
      Buffer.from("f:9223372036854775808").toString("base64url"),
      Buffer.from(`f:${"9".repeat(30)}`).toString("base64url"),
    ]) {
      const attempt = get(input({ framesAfter }), ctx());
      await expect(attempt).rejects.toBeInstanceOf(CapabilityError);
      await expect(attempt).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("is not_found for a run in another workspace, whichever store minted the id", async () => {
    const { get } = harness({
      ledger: [
        ledgerRun({
          publicId: LEDGER_ID,
          runId: RUN_UUID,
          scope: OTHER_WORKSPACE,
        }),
      ],
      tacho: [tachoSession({ publicId: TACHO_ID, scope: OTHER_WORKSPACE })],
    });
    for (const runId of [LEDGER_ID, TACHO_ID]) {
      const attempt = get(input({ runId }), ctx());
      await expect(attempt).rejects.toSatisfy(isHandlerError);
      await expect(attempt).rejects.toMatchObject({
        code: "not_found",
        reason: "run_not_found",
      });
    }
    // The same rows read from their own workspace.
    await expect(
      get(input({ runId: TACHO_ID }), ctx(OTHER_WORKSPACE)),
    ).resolves.toMatchObject({ run: { id: TACHO_ID } });
    await expect(get(input(), ctx(OTHER_WORKSPACE))).resolves.toMatchObject({
      run: { id: LEDGER_ID },
    });
  });

  it("is not_found for a ledger id the store has no row for, a legacy V1 row, and a subagent chain", async () => {
    const gone = harness({ found: false });
    await expect(gone.get(input(), ctx())).rejects.toMatchObject({
      code: "not_found",
    });
    const legacy = harness({
      ledger: [
        ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID, specVersion: 1 }),
      ],
    });
    await expect(legacy.get(input(), ctx())).rejects.toMatchObject({
      code: "not_found",
    });
    const child = harness({
      tacho: [tachoSession({ publicId: TACHO_ID, child: true })],
    });
    await expect(
      child.get(input({ runId: TACHO_ID }), ctx()),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("waitMs: 0 reads once and never sleeps", async () => {
    const { get, sleeps } = harness();
    const out = await get(input({ waitMs: 0 }), ctx());
    expect(out.frames).toEqual({ frames: [], cursor: null });
    expect(sleeps).toEqual([]);
  });

  it("waits for a frame past the cursor and returns as soon as one lands", async () => {
    const { get, sleeps } = harness({
      events: [event(1)],
      // The ledger gains an event after the second poll has slept.
      onSleep: (count, log) => {
        if (count === 2) log.push(event(2));
      },
    });
    const out = await get(
      input({ framesAfter: encodeFrameCursor("1"), waitMs: 20_000 }),
      ctx(),
    );
    expect(out.frames?.frames.map((f) => f.seq)).toEqual(["2"]);
    // The fixture run is sealed, so a page with nothing behind it ends the read.
    expect(out.frames?.cursor).toBeNull();
    expect(sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
  });

  it("gives up at the wait budget with an empty page and a null cursor", async () => {
    const { get, sleeps } = harness({ events: [event(1)] });
    const out = await get(
      input({ framesAfter: encodeFrameCursor("1"), waitMs: 1_200 }),
      ctx(),
    );
    expect(out.frames).toEqual({ frames: [], cursor: null });
    // 500 + 500 + 200: the last sleep is the remainder, never past the budget.
    expect(sleeps).toEqual([500, 500, 200]);
  });

  it("caps a page at frameLimit and carries the page cursor past every event read", async () => {
    const { get } = harness({ events: [1, 2, 3].map((n) => event(n)) });
    const out = await get(input({ frameLimit: 1 }), ctx());
    expect(out.frames?.frames).toHaveLength(1);
    expect(decodeFrameCursor(out.frames?.cursor ?? "")).toBe("1");
  });

  describe("agent-surface bounds (#4222)", () => {
    const events = () =>
      Array.from({ length: 300 }, (_, i) => event(i + 1));
    const on = (invokeSurface: "agent" | "api" | "mcp") => ({
      ...ctx(),
      invokeSurface,
    });

    it("never waits on the agent surface, whatever waitMs the model sent", async () => {
      const { get, sleeps } = harness({ events: [event(1)] });
      const out = await get(
        input({ framesAfter: encodeFrameCursor("1"), waitMs: 20_000 }),
        on("agent"),
      );
      expect(out.frames).toEqual({ frames: [], cursor: null });
      expect(sleeps).toEqual([]);
    });

    it("caps an agent-surface page at the agent limit and keeps the cursor past it", async () => {
      const { get } = harness({ events: events() });
      const out = await get(input({ frameLimit: 500 }), on("agent"));
      expect(out.frames?.frames).toHaveLength(AGENT_FRAME_LIMIT_MAX);
      // More frames lie behind the page, so the read continues from its last.
      expect(decodeFrameCursor(out.frames?.cursor ?? "")).toBe(
        String(AGENT_FRAME_LIMIT_MAX),
      );
    });

    it("reads the agent default when the model named no frameLimit, and a smaller one as asked", async () => {
      const { get } = harness({ events: events() });
      // Zod fills an omitted frameLimit with the contract default.
      const omitted = await get(
        runGet.input.parse({ runId: LEDGER_ID }),
        on("agent"),
      );
      expect(omitted.frames?.frames).toHaveLength(AGENT_FRAME_LIMIT_DEFAULT);
      const small = await get(input({ frameLimit: 7 }), on("agent"));
      expect(small.frames?.frames).toHaveLength(7);
    });

    it.each(["api", "mcp"] as const)(
      "keeps the contract's bounds on the %s surface (negative)",
      async (surface) => {
        const { get } = harness({ events: events() });
        const out = await get(input({ frameLimit: 500 }), on(surface));
        expect(out.frames?.frames).toHaveLength(300);
        expect(out.frames?.cursor).toBeNull();
        const omitted = await get(
          runGet.input.parse({ runId: LEDGER_ID }),
          on(surface),
        );
        expect(omitted.frames?.frames).toHaveLength(FRAME_LIMIT_DEFAULT);

        const waited = harness({ events: [event(1)] });
        await waited.get(
          input({ framesAfter: encodeFrameCursor("1"), waitMs: 1_200 }),
          on(surface),
        );
        expect(waited.sleeps).toEqual([500, 500, 200]);
      },
    );
  });

  it("answers no cursor for a sealed run whose page is exactly full with nothing behind it (negative)", async () => {
    const { get } = harness({ events: [1, 2].map((n) => event(n)) });
    const out = await get(input({ frameLimit: 2 }), ctx());
    expect(out.frames?.frames.map((f) => f.seq)).toEqual(["1", "2"]);
    expect(out.frames?.cursor).toBeNull();
  });

  it("keeps the resume point on a live run whose page held every frame so far", async () => {
    const base = ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID });
    const { get } = harness({
      ledger: [{ ...base, run: { ...base.run, status: "running" } }],
      events: [event(1)],
    });
    const out = await get(input(), ctx());
    expect(out.run.status).toBe("live");
    expect(decodeFrameCursor(out.frames?.cursor ?? "")).toBe("1");
  });

  it("does not call the ledger reader for a wrapped session, reads its rollup row alone, and reads only its own session's frames", async () => {
    const readEvents = vi.fn();
    const stores = memoryStores([], [tachoSession({ publicId: TACHO_ID })]);
    const tachoFrames = vi.fn(
      memoryTachoFrames("0192d4a8-7c1e-7a00-8000-00000000dead", [tachoRow(0)]),
    );
    const get = createRunGetHandler({
      queries: stores.queries,
      store: { getRunByPublicId: vi.fn(), readAttemptEventsSince: readEvents },
      readRunRollups: stores.readRunRollups,
      readWitnessFor: async () => null,
      tachoFrames,
      sessionTitle: async () => null,
      sessionConfig: async () => ({
        effort: null,
        effortSource: null,
        thinking: null,
      }),
      storedFit: async () => null,
      sessionRepository: async () => null,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(readEvents).not.toHaveBeenCalled();
    expect(stores.rollupCalls).toEqual([[TACHO_ID]]);
    expect(tachoFrames).toHaveBeenCalledWith({
      sessionUuid: SESSION_UUID,
      afterSeq: -1,
      // Bounded above, so ClickHouse stops at the window, not the chain's end.
      throughSeq: 200,
      // One past the page, so a full page can be told from the end.
      limit: 201,
    });
    expect(out.frames).toEqual({ frames: [], cursor: null });
  });

  // #4112: a wrapped run's pause is applied by its host, so get_run reads it
  // from the last pause or resume the host acknowledged `applied`, which the
  // session query selects as `paused`.
  it("answers a live wrapped run paused while the last applied halt is a pause, and not once a resume lands", async () => {
    const live = (paused: boolean) =>
      tachoSession({
        publicId: TACHO_ID,
        session: { outcome: "running", sealedAt: null, paused },
      });
    const pausedRun = await harness({ tacho: [live(true)] }).get(
      input({ runId: TACHO_ID }),
      ctx(),
    );
    expect(runGet.output.parse(pausedRun)).toEqual(pausedRun);
    expect(pausedRun.run).toMatchObject({
      status: "live",
      ingressPaused: true,
    });
    const resumed = await harness({ tacho: [live(false)] }).get(
      input({ runId: TACHO_ID }),
      ctx(),
    );
    expect(resumed.run.ingressPaused).toBe(false);
  });

  it("answers a sealed wrapped run not paused, whatever its host last applied (negative)", async () => {
    const { get } = harness({
      tacho: [tachoSession({ publicId: TACHO_ID, session: { paused: true } })],
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.status).toBe("sealed");
    expect(out.run.ingressPaused).toBe(false);
  });
});

describe("frame cursor", () => {
  it("round-trips a run_seq and refuses anything else", () => {
    expect(decodeFrameCursor(encodeFrameCursor("9223372036854775807"))).toBe(
      "9223372036854775807",
    );
    expect(decodeFrameCursor(encodeFrameCursor("0"))).toBe("0");
    expect(decodeFrameCursor("not-a-cursor")).toBeNull();
    expect(
      decodeFrameCursor(Buffer.from("f:1.5").toString("base64url")),
    ).toBeNull();
  });

  it("refuses a run_seq past int8 max, which the ledger's bigint column never held (negative)", () => {
    expect(
      decodeFrameCursor(encodeFrameCursor("9223372036854775808")),
    ).toBeNull();
    expect(
      decodeFrameCursor(encodeFrameCursor("18446744073709551615")),
    ).toBeNull();
    expect(decodeFrameCursor(encodeFrameCursor("9".repeat(30)))).toBeNull();
  });
});

// ADR-235, item 5: an in-app run is the asking person's own record. Every
// other caller reads it as a run that does not exist.
describe("get_run on an in-app run (ADR-235)", () => {
  const ASKER = ctx().userId as string;
  const OTHER = "0192d4a8-7c1e-7a00-8000-0000000000e2";
  const KEY = "0192d4a8-7c1e-7a00-8000-0000000a91e1";
  const turn = (asker: string | null = ASKER) =>
    inAppLedgerRun({ publicId: LEDGER_ID, runId: RUN_UUID }, asker);

  it("answers the person who asked with their own turn", async () => {
    const out = await harness({ ledger: [turn()] }).get(input(), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run.id).toBe(LEDGER_ID);
  });

  it("answers another member not_found, as it answers an id it does not know (negative)", async () => {
    const other = { ...ctx(), userId: OTHER };
    const hidden = await harness({ ledger: [turn()] })
      .get(input(), other)
      .catch((e: unknown) => e);
    const unknown = await harness({ ledger: [turn()], found: false })
      .get(input(), other)
      .catch((e: unknown) => e);
    expect(isHandlerError(hidden) && [hidden.code, hidden.reason]).toEqual([
      "not_found",
      "run_not_found",
    ]);
    expect(isHandlerError(unknown) && [unknown.code, unknown.reason]).toEqual(
      ["not_found", "run_not_found"],
    );
  });

  it("answers a run on any other surface to every member, as before", async () => {
    const out = await harness({
      ledger: [
        ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID, surface: "a2a" }),
      ],
    }).get(input(), { ...ctx(), userId: OTHER });
    expect(out.run.id).toBe(LEDGER_ID);
  });

  it("answers an API-key call as the key's creator: the asker's key reads the turn, another person's does not", async () => {
    const machine = { ...ctx(), userId: null, apiKeyId: KEY };
    // Stands in for `resolveActingUserId`, which reads the key's creator from
    // `auth.api_keys` (lib/run-read.test.ts runs the real one).
    const creator =
      (createdBy: string) =>
      async (c: { userId: string | null; apiKeyId: string | null }) =>
        c.userId ?? (c.apiKeyId === KEY ? createdBy : null);
    const own = await harness({
      ledger: [turn()],
      actingUserId: creator(ASKER),
    }).get(input(), machine);
    expect(own.run.id).toBe(LEDGER_ID);
    await expect(
      harness({ ledger: [turn()], actingUserId: creator(OTHER) }).get(
        input(),
        machine,
      ),
    ).rejects.toMatchObject({ code: "not_found", reason: "run_not_found" });
  });

  it("answers no one a turn with no person behind it (negative)", async () => {
    await expect(
      harness({ ledger: [turn(null)] }).get(input(), ctx()),
    ).rejects.toMatchObject({ code: "not_found", reason: "run_not_found" });
  });
});

describe("get_run witnessFor (ADR-064)", () => {
  it("answers the worker run a witness run reported on, and null for every other run", async () => {
    const WORKER = "tse_7w0rker0000000000000a";
    const witness = await harness({ witnessFor: WORKER }).get(
      input({ runId: TACHO_ID }),
      ctx(),
    );
    expect(runGet.output.parse(witness)).toEqual(witness);
    expect(witness.witnessFor).toBe(WORKER);

    const ledger = await harness({ witnessFor: WORKER }).get(input(), ctx());
    expect(ledger.witnessFor).toBeNull();
  });

  it("answers not_found to an API-key caller for a witness run, and no witnessFor on any other run (negative)", async () => {
    const machine = { ...ctx(), userId: null, apiKeyId: "aky_worker" };
    const err = await harness({ witnessFor: "tse_7w0rker0000000000000a" })
      .get(input({ runId: TACHO_ID }), machine)
      .catch((e: unknown) => e);
    expect(isHandlerError(err) && err.code).toBe("not_found");

    const plain = await harness().get(input({ runId: TACHO_ID }), machine);
    expect(plain.run.id).toBe(TACHO_ID);
    expect(plain.witnessFor).toBeNull();
  });

  it("refuses a run outside the workspace before reading its witness link (negative)", async () => {
    const { get } = harness({
      tacho: [tachoSession({ publicId: TACHO_ID, scope: OTHER_WORKSPACE })],
      witnessFor: "tse_7w0rker0000000000000a",
    });
    const err = await get(input({ runId: TACHO_ID }), ctx()).catch(
      (e: unknown) => e,
    );
    expect(isHandlerError(err) && err.code).toBe("not_found");
  });

  it("names a wrapped session by the title its harness last gave it", async () => {
    const titled = harness({ sessionTitle: "Fix the billing proration" });
    const out = await titled.get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.name).toBe("Fix the billing proration");
    const untitled = harness();
    const plain = await untitled.get(input({ runId: TACHO_ID }), ctx());
    expect(plain.run.name).not.toBe("Fix the billing proration");
  });

  // #4224: a harness puts no bound on its title, and the ClickHouse read
  // returned it whole, past what the contract allows.
  it("cuts a long harness title to the display cap on a code-point boundary", async () => {
    const long = `${"a".repeat(254)}😀${"a".repeat(44)}`;
    const out = await harness({ sessionTitle: long }).get(
      input({ runId: TACHO_ID }),
      ctx(),
    );
    expect(out.run.name).toBe(`${"a".repeat(254)}…`);
    expect(runGet.output.parse(out)).toEqual(out);
  });

  it("still answers the run when its title cannot be read", async () => {
    const { get } = harness({ titleFails: true });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    const plain = await harness().get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.name).toBe(plain.run.name);
  });

  it("answers the effort and thinking the session's frames recorded, and where the effort was read", async () => {
    const { get } = harness({
      sessionConfig: { effort: "high", effortSource: "harness", thinking: true },
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run.effort).toBe("high");
    expect(out.run.effortSource).toBe("harness");
    expect(out.run.thinking).toBe(true);
  });

  it("answers a gateway run's effort from the proxied request (#3891)", async () => {
    const { get } = harness({
      tacho: [
        tachoSession({
          publicId: TACHO_ID,
          session: { enforcementTier: "gateway", effort: "medium" },
        }),
      ],
      sessionConfig: { effort: "low", effortSource: "request", thinking: null },
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    // The request's own setting outranks the harness's report on the row.
    expect(out.run).toMatchObject({ effort: "low", effortSource: "request" });
  });

  it("keeps the session row's effort, as the harness's report, when no frame recorded one", async () => {
    const { get } = harness({
      tacho: [
        tachoSession({ publicId: TACHO_ID, session: { effort: "medium" } }),
      ],
      sessionConfig: { effort: null, effortSource: null, thinking: false },
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run).toMatchObject({
      effort: "medium",
      effortSource: "harness",
      thinking: false,
    });
  });

  it("answers no effort and no source for an observe run that recorded none, and for a ledger run (negative)", async () => {
    const observed = await harness().get(input({ runId: TACHO_ID }), ctx());
    expect(observed.run.enforcementTier).toBe("observe");
    expect(observed.run).toMatchObject({ effort: null, effortSource: null });
    const ledger = await harness().get(input(), ctx());
    expect(ledger.run).toMatchObject({ effort: null, effortSource: null });
    expect(runGet.output.parse(ledger)).toEqual(ledger);
  });

  it("still answers the run when its effort settings cannot be read, on the row's effort", async () => {
    const { get } = harness({
      tacho: [
        tachoSession({ publicId: TACHO_ID, session: { effort: "high" } }),
      ],
      configFails: true,
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.thinking).toBeUndefined();
    expect(out.run).toMatchObject({ effort: "high", effortSource: "harness" });
  });

  // ClickHouse refuses a read under its server-wide memory cap whichever query
  // it picks, and it picked this one for the Run stream and the assistant
  // alike (#4243). The header is Postgres's and still answers.
  it("still answers the run header when the frame store refuses the read, and says so", async () => {
    const { get, sleeps } = harness({
      tachoRows: [tachoRow(0), tachoRow(1)],
      framesFail: true,
    });
    const out = await get(input({ runId: TACHO_ID, waitMs: 1_200 }), ctx());
    const plain = await harness().get(input({ runId: TACHO_ID }), ctx());
    expect(out.run).toEqual(plain.run);
    // No cursor: the caller keeps its own, and an empty page is not a seal.
    expect(out.frames).toEqual({ frames: [], cursor: null });
    expect(out.framesError?.code).toBe("frames_unavailable");
    // A refusal is not an empty store: the long poll does not read it again.
    expect(sleeps).toEqual([]);
    expect(runGet.output.parse(out)).toEqual(out);
  });

  it("carries no framesError when the frames were read (negative)", async () => {
    const { get } = harness({ tachoRows: [tachoRow(0)] });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.frames.frames).toHaveLength(1);
    expect("framesError" in out).toBe(false);
  });
  // A-05: the Run header drew no repository while the work read was pending
  // or after it failed, though the session recorded its remote's digest.
  const PLATFORM: PlaceRepository = {
    host: "github.com",
    owner: "acme",
    name: "platform",
    url: "https://github.com/acme/platform",
  };
  const DIGEST = `sha256:${"b".repeat(64)}`;
  const placed = (over: Over = {}) =>
    harness({
      tacho: [
        tachoSession({
          publicId: TACHO_ID,
          session: {
            cwd: "/Users/mb/src/platform",
            gitBranch: "fix/tags",
            gitRemoteDigest: DIGEST,
          },
        }),
      ],
      ...over,
    });

  it("names the connected repository the session's remote digest matches in its place (A-05)", async () => {
    const asked: string[] = [];
    const { get } = placed({
      repositories: { [DIGEST]: PLATFORM },
      repositoryAsked: asked,
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.place).toEqual({
      path: "/Users/mb/src/platform",
      branch: "fix/tags",
      repository: PLATFORM,
    });
    expect(asked).toEqual([DIGEST]);
    expect(runGet.output.parse(out)).toEqual(out);
  });

  it("answers a null repository when no connected repository matches, and none when the read failed (negative)", async () => {
    const unmatched = await placed().get(input({ runId: TACHO_ID }), ctx());
    expect(unmatched.run.place).toEqual({
      path: "/Users/mb/src/platform",
      branch: "fix/tags",
      repository: null,
    });
    const failed = await placed({ repositoryFails: true }).get(
      input({ runId: TACHO_ID }),
      ctx(),
    );
    // Not read is not "no repository": the key is left out.
    expect(failed.run.place).toEqual({
      path: "/Users/mb/src/platform",
      branch: "fix/tags",
    });
  });

  it("reads no repository for a session with no remote digest or for a ledger run (negative)", async () => {
    const asked: string[] = [];
    const { get } = harness({ repositoryAsked: asked });
    const tacho = await get(input({ runId: TACHO_ID }), ctx());
    const ledger = await get(input({ runId: LEDGER_ID }), ctx());
    expect(asked).toEqual([]);
    expect(tacho.run.place?.repository).toBeUndefined();
    expect(ledger.run.place).toBeNull();
  });

  // #4516: ingest stamps the flag when the session opens. The read answers
  // it as recorded and asks no repository read of its own for it.
  it("answers the unlinked-repository flag ingest stamped on the session", async () => {
    const asked: string[] = [];
    const { get } = harness({
      tacho: [
        tachoSession({
          publicId: TACHO_ID,
          session: {
            cwd: "/Users/mb/src/platform",
            gitRemoteDigest: DIGEST,
            repositoryUnlinked: true,
          },
        }),
      ],
      // Linked now: the stamp records the session's start, not today.
      repositories: { [DIGEST]: PLATFORM },
      repositoryAsked: asked,
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.repositoryUnlinked).toBe(true);
    expect(out.run.place?.repository).toEqual(PLATFORM);
    // One read, for the place. The flag comes from the row.
    expect(asked).toEqual([DIGEST]);
    expect(runGet.output.parse(out)).toEqual(out);
  });

  it("answers false for a session stamped false, a row read without the column, and a ledger run (negative)", async () => {
    const stamped = await harness({
      tacho: [
        tachoSession({
          publicId: TACHO_ID,
          session: { gitRemoteDigest: DIGEST, repositoryUnlinked: false },
        }),
      ],
    }).get(input({ runId: TACHO_ID }), ctx());
    expect(stamped.run.repositoryUnlinked).toBe(false);

    const { get } = harness();
    const unread = await get(input({ runId: TACHO_ID }), ctx());
    const ledger = await get(input({ runId: LEDGER_ID }), ctx());
    expect(unread.run.repositoryUnlinked).toBe(false);
    expect(ledger.run.repositoryUnlinked).toBe(false);
    expect(runGet.output.parse(ledger)).toEqual(ledger);
  });
});

// #3823: a subagent records on a chain of its own, numbered from 0. get_run
// pages one chain, names a subagent frame's chain, and lists each subagent
// chain's head, so a reader following the run learns a subagent recorded
// more even when the run's own chain did not move.
describe("get_run subagent chains (#3823)", () => {
  const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";
  const SECOND = "0192d4a8-7c1e-7a00-8000-00000000c1d1";
  const FOREIGN_ROOT = "0192d4a8-7c1e-7a00-8000-00000000beef";
  const FOREIGN_CHILD = "0192d4a8-7c1e-7a00-8000-00000000f0e1";

  /** A frame on a subagent chain, as the subagent read answers it. */
  const onChain = (
    session: string,
    seq: number,
    root = SESSION_UUID,
    over: Partial<TachoFrameRow> = {},
  ) =>
    tachoRow(seq, {
      sessionUuid: session,
      rootSessionUuid: root,
      parentSessionUuid: root,
      subagentId: "agent-1",
      subagentType: "Explore",
      spawnToolUseId: "toolu_A",
      ...over,
    });

  const chains = [
    subagentChain({
      sessionUuid: CHILD,
      rootSessionUuid: SESSION_UUID,
      seqCount: 3,
    }),
    subagentChain({
      sessionUuid: SECOND,
      rootSessionUuid: SESSION_UUID,
      subagentId: "agent-2",
      subagentType: null,
      spawnToolUseId: "toolu_B",
      startedAt: new Date("2026-09-11T09:03:00.000Z"),
    }),
    subagentChain({
      sessionUuid: FOREIGN_CHILD,
      rootSessionUuid: FOREIGN_ROOT,
      seqCount: 1,
    }),
  ];

  function chainHarness(
    over: {
      root?: TachoFrameRow[];
      children?: TachoFrameRow[];
      status?: "running" | "completed";
      /** Runs after each fake sleep; a test lands a subagent frame here. */
      onSleep?: (count: number, children: TachoFrameRow[]) => void;
      headsFail?: boolean;
      /** The chains Postgres lists; the three above unless a test names more. */
      chains?: SubagentChainFixture[];
    } = {},
  ) {
    const stores = memoryStores(
      [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
      [
        tachoSession({
          publicId: TACHO_ID,
          session:
            over.status === "running"
              ? { outcome: "running", sealedAt: null }
              : {},
        }),
      ],
    );
    const children = over.children ?? [];
    let clock = 1_000_000;
    const sleeps: number[] = [];
    const headReads: string[][] = [];
    const listed = memorySubagentChains(over.chains ?? chains);
    const lists: string[] = [];
    const heads = memoryChainHeads(children);
    const deps: RunGetDeps = {
      queries: stores.queries,
      store: {
        getRunByPublicId: (publicId) =>
          Promise.resolve(publicId === LEDGER_ID ? summary() : null),
        readAttemptEventsSince: memoryEvents([]),
      },
      readRunRollups: stores.readRunRollups,
      readWitnessFor: async () => null,
      tachoFrames: memoryTachoFrames(SESSION_UUID, over.root ?? []),
      tachoSubagentFrames: (args) =>
        memorySubagentFrames(children)(args),
      tachoChains: (root, options) => {
        lists.push(root);
        return listed(root, options);
      },
      chainHeads: (args) => {
        headReads.push([...args.sessionUuids]);
        return over.headsFail === true
          ? Promise.reject(new Error("Code: 241. Memory limit exceeded"))
          : heads(args);
      },
      sessionTitle: async () => null,
      sessionConfig: async () => ({
        effort: null,
        effortSource: null,
        thinking: null,
      }),
      storedFit: async () => null,
      sessionRepository: async () => null,
      now: () => clock,
      sleep: (ms) => {
        sleeps.push(ms);
        clock += ms;
        over.onSleep?.(sleeps.length, children);
        return Promise.resolve();
      },
    };
    return { get: createRunGetHandler(deps), sleeps, headReads, lists };
  }

  it("pages a subagent chain by its session, from its seq 0, and names the chain on each frame and cursor", async () => {
    const { get } = chainHarness({
      root: [tachoRow(0), tachoRow(1)],
      children: [onChain(CHILD, 0), onChain(CHILD, 1), onChain(CHILD, 2)],
    });
    const first = await get(
      input({ runId: TACHO_ID, sessionUuid: CHILD, frameLimit: 2 }),
      ctx(),
    );
    expect(runGet.output.parse(first)).toEqual(first);
    expect(
      first.frames.frames.map((f) => [f.sessionUuid, f.seq]),
    ).toEqual([
      [CHILD, "0"],
      [CHILD, "1"],
    ]);
    expect(decodeFramePosition(first.frames.frames[0]?.cursor ?? "")).toEqual(
      { sessionUuid: CHILD, seq: "0" },
    );
    expect(decodeFramePosition(first.frames.cursor ?? "")).toEqual({
      sessionUuid: CHILD,
      seq: "1",
    });
    // The page cursor resumes the chain with no gap and no repeat.
    const rest = await get(
      input({
        runId: TACHO_ID,
        sessionUuid: CHILD,
        framesAfter: first.frames.cursor ?? "",
      }),
      ctx(),
    );
    expect(rest.frames.frames.map((f) => f.seq)).toEqual(["2"]);

    // The run's own chain still pages by seq alone, and its frames name no
    // chain; so does a read that names the run's own session.
    for (const sessionUuid of [undefined, SESSION_UUID.toUpperCase()]) {
      const own = await get(input({ runId: TACHO_ID, sessionUuid }), ctx());
      expect(own.frames.frames.map((f) => f.seq)).toEqual(["0", "1"]);
      expect(own.frames.frames.every((f) => f.sessionUuid === undefined)).toBe(
        true,
      );
      expect(decodeFrameCursor(own.frames.frames[0]?.cursor ?? "")).toBe("0");
    }
  });

  it("lists every subagent chain's head from the frame store, with a cursor over the heads that hold a frame", async () => {
    const { get, headReads } = chainHarness({
      children: [onChain(CHILD, 0), onChain(CHILD, 1)],
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.chains).toEqual({
      cursor: chainsCursor([{ sessionUuid: CHILD, lastSeq: "1" }]),
      heads: [
        {
          sessionUuid: CHILD,
          parentSessionUuid: SESSION_UUID,
          subagentId: "agent-1",
          subagentType: "Explore",
          spawnCallId: "toolu_A",
          lastSeq: "1",
          frameCount: 2,
        },
        // Registered, with no frame the store can return yet.
        {
          sessionUuid: SECOND,
          parentSessionUuid: SESSION_UUID,
          subagentId: "agent-2",
          subagentType: null,
          spawnCallId: "toolu_B",
          lastSeq: null,
          frameCount: 0,
        },
      ],
      complete: true,
    });
    // Only the run's own chains are asked for; the other run's never is.
    expect(headReads).toEqual([[CHILD, SECOND]]);
    // A chain that is only registered does not move the cursor; its first
    // readable frame does.
    expect(out.chains?.cursor).toBe(
      chainsCursor([
        { sessionUuid: CHILD, lastSeq: "1" },
        { sessionUuid: SECOND, lastSeq: null },
      ]),
    );
    expect(out.chains?.cursor).not.toBe(
      chainsCursor([
        { sessionUuid: CHILD, lastSeq: "1" },
        { sessionUuid: SECOND, lastSeq: "0" },
      ]),
    );
    expect(out.chains?.cursor).toMatch(/^h:[0-9a-f]{16}$/);
  });

  it("counts the frames a chain with a gap holds, not its last seq plus one (negative)", async () => {
    const { get } = chainHarness({
      children: [onChain(CHILD, 0), onChain(CHILD, 5)],
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(
      out.chains?.heads.find((head) => head.sessionUuid === CHILD),
    ).toMatchObject({ lastSeq: "5", frameCount: 2 });
  });

  it("wakes a long poll on the run's own chain when only a subagent chain records a frame", async () => {
    const { get, sleeps, headReads, lists } = chainHarness({
      status: "running",
      root: [tachoRow(0)],
      children: [onChain(CHILD, 0)],
      onSleep: (count, children) => {
        if (count === 2) children.push(onChain(CHILD, 1));
      },
    });
    const opened = await get(input({ runId: TACHO_ID }), ctx());
    const waited = await get(
      input({
        runId: TACHO_ID,
        framesAfter: opened.frames.cursor ?? "",
        chainsAfter: opened.chains?.cursor,
        waitMs: 20_000,
      }),
      ctx(),
    );
    // No frame on the run's own chain: the wait ended on the subagent's.
    expect(waited.frames.frames).toEqual([]);
    expect(sleeps).toEqual([POLL_INTERVAL_MS, POLL_INTERVAL_MS]);
    expect(waited.chains?.cursor).not.toBe(opened.chains?.cursor);
    expect(waited.chains?.heads[0]).toMatchObject({
      sessionUuid: CHILD,
      lastSeq: "1",
    });
    // Postgres lists the chains once per invoke; each tick asks ClickHouse
    // for their heads again.
    expect(lists).toEqual([SESSION_UUID, SESSION_UUID]);
    expect(headReads).toHaveLength(1 + 3);
  });

  // Codex review on #4421: the cursor hashed only the heads the answer
  // carried, so a chain past RUN_CHAIN_HEADS_MAX could record without waking
  // the long poll or the run stream.
  it("wakes a long poll when a chain past the heads cap records, and still answers the capped heads", async () => {
    const many = Array.from({ length: RUN_CHAIN_HEADS_MAX + 1 }, (_, i) =>
      subagentChain({
        sessionUuid: `0192d4a8-7c1e-7a00-8000-0000000d${i.toString(16).padStart(4, "0")}`,
        rootSessionUuid: SESSION_UUID,
        startedAt: new Date(Date.UTC(2026, 8, 11, 9, 0, i)),
      }),
    );
    const last = many.at(-1)?.sessionUuid ?? "";
    const { get, headReads } = chainHarness({
      status: "running",
      root: [tachoRow(0)],
      chains: many,
      onSleep: (count, children) => {
        if (count === 2) children.push(onChain(last, 0));
      },
    });
    const opened = await get(input({ runId: TACHO_ID }), ctx());
    expect(opened.chains?.heads).toHaveLength(RUN_CHAIN_HEADS_MAX);
    expect(opened.chains?.complete).toBe(false);
    // The heads read covers every chain, the one past the cap too.
    expect(headReads[0]).toHaveLength(RUN_CHAIN_HEADS_MAX + 1);
    const waited = await get(
      input({
        runId: TACHO_ID,
        framesAfter: opened.frames.cursor ?? "",
        chainsAfter: opened.chains?.cursor,
        waitMs: 20_000,
      }),
      ctx(),
    );
    expect(waited.frames.frames).toEqual([]);
    expect(waited.chains?.cursor).not.toBe(opened.chains?.cursor);
    expect(
      waited.chains?.heads.some((head) => head.sessionUuid === last),
    ).toBe(false);
  });

  it("waits out the budget when no chain moves, and never waits on chains without chainsAfter (negative)", async () => {
    const quiet = chainHarness({
      status: "running",
      root: [tachoRow(0)],
      children: [onChain(CHILD, 0)],
    });
    const opened = await quiet.get(input({ runId: TACHO_ID }), ctx());
    const waited = await quiet.get(
      input({
        runId: TACHO_ID,
        framesAfter: opened.frames.cursor ?? "",
        chainsAfter: opened.chains?.cursor,
        waitMs: 1_200,
      }),
      ctx(),
    );
    expect(waited.frames.frames).toEqual([]);
    expect(quiet.sleeps).toEqual([500, 500, 200]);
    expect(waited.chains?.cursor).toBe(opened.chains?.cursor);

    // Without chainsAfter, a subagent's frame does not end the wait.
    const unwatched = chainHarness({
      status: "running",
      root: [tachoRow(0)],
      children: [onChain(CHILD, 0)],
      onSleep: (count, children) => {
        if (count === 1) children.push(onChain(CHILD, 1));
      },
    });
    const first = await unwatched.get(input({ runId: TACHO_ID }), ctx());
    await unwatched.get(
      input({
        runId: TACHO_ID,
        framesAfter: first.frames.cursor ?? "",
        waitMs: 1_200,
      }),
      ctx(),
    );
    expect(unwatched.sleeps).toEqual([500, 500, 200]);
    // The heads are read once per invoke, beside the frames, not per tick.
    expect(unwatched.headReads).toHaveLength(2);
  });

  it("answers not_found for a chain of another run and for any chain on a ledger run (negative)", async () => {
    const { get } = chainHarness({ children: [onChain(CHILD, 0)] });
    for (const [runId, sessionUuid] of [
      [TACHO_ID, FOREIGN_CHILD],
      [TACHO_ID, FOREIGN_ROOT],
      [LEDGER_ID, CHILD],
    ] as const) {
      const attempt = get(input({ runId, sessionUuid }), ctx());
      await expect(attempt).rejects.toSatisfy(isHandlerError);
      await expect(attempt).rejects.toMatchObject({
        code: "not_found",
        reason: "chain_not_found",
      });
    }
  });

  it("refuses a cursor minted on another chain than the one read (negative)", async () => {
    const { get } = chainHarness({
      root: [tachoRow(0), tachoRow(1)],
      children: [onChain(CHILD, 0), onChain(CHILD, 1)],
    });
    for (const [framesAfter, sessionUuid] of [
      // A subagent's cursor on the run's own chain.
      [encodeFrameCursor("0", CHILD), undefined],
      // The run's own cursor on a subagent's chain.
      [encodeFrameCursor("0"), CHILD],
      // Another subagent's cursor.
      [encodeFrameCursor("0", SECOND), CHILD],
    ] as const) {
      const attempt = get(
        input({ runId: TACHO_ID, framesAfter, sessionUuid }),
        ctx(),
      );
      await expect(attempt).rejects.toBeInstanceOf(CapabilityError);
      await expect(attempt).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("answers no chains on a ledger run, and leaves them out when the heads cannot be read (negative)", async () => {
    const ledger = await chainHarness().get(input(), ctx());
    expect("chains" in ledger).toBe(false);

    const failed = await chainHarness({
      root: [tachoRow(0)],
      children: [onChain(CHILD, 0)],
      headsFail: true,
    }).get(input({ runId: TACHO_ID }), ctx());
    expect(failed.frames.frames.map((f) => f.seq)).toEqual(["0"]);
    expect("chains" in failed).toBe(false);
    expect("framesError" in failed).toBe(false);
  });
});

describe("frame cursor on a subagent chain (#3823)", () => {
  const CHILD = "0192d4a8-7c1e-7a00-8000-00000000c1d0";

  it("round-trips a chain and a seq, lowercasing the chain", () => {
    expect(
      decodeFramePosition(encodeFrameCursor("4", CHILD.toUpperCase())),
    ).toEqual({ sessionUuid: CHILD, seq: "4" });
    expect(decodeFramePosition(encodeFrameCursor("4"))).toEqual({
      sessionUuid: null,
      seq: "4",
    });
  });

  it("answers no root seq for a chain cursor, and refuses a malformed chain (negative)", () => {
    // The transcript's frame cursor and the stream resume the run's own chain.
    expect(decodeFrameCursor(encodeFrameCursor("4", CHILD))).toBeNull();
    for (const text of [
      "f:not-a-uuid:4",
      `f:${CHILD}:`,
      `f:${CHILD}:-1`,
      `f:${CHILD}:9223372036854775808`,
      `f::4`,
    ]) {
      expect(
        decodeFramePosition(Buffer.from(text).toString("base64url")),
      ).toBeNull();
    }
  });
});

// #3972: get_run answers where a paused run stopped, who paused it, when and
// why, and whether the pause is on its way, in force, or being lifted. The
// state rides the rule list_runs reads `paused` by (the row's
// `ingressPaused`); the rows name the command behind it.
describe("get_run pause (#3972)", () => {
  const USER = "usr_0123456789abcdefghjkmn";
  // The harness clock reads 1970, so a row expires only when a test says so.
  const pauseRow = (over: Partial<PauseCommandRow> = {}): PauseCommandRow => ({
    publicId: "tcm_pause",
    command: "pause",
    outcome: "applied",
    reason: "budget review",
    issuedAt: new Date("2026-09-11T09:02:00.000Z"),
    expiresAt: null,
    appliedAt: new Date("2026-09-11T09:02:04.000Z"),
    appliedAtSeq: 41,
    issuedByPublicId: USER,
    issuedByName: "Ada Park",
    ...over,
  });
  const resumeRow = (over: Partial<PauseCommandRow> = {}) =>
    pauseRow({
      publicId: "tcm_resume",
      command: "resume",
      outcome: "queued",
      reason: null,
      issuedAt: new Date("2026-09-11T09:04:00.000Z"),
      appliedAt: null,
      appliedAtSeq: null,
      ...over,
    });
  const wrapped = (paused: boolean) => [
    tachoSession({
      publicId: TACHO_ID,
      session: { outcome: "running", sealedAt: null, paused },
    }),
  ];
  const base = ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID });
  const ledger = (ingressPaused: boolean) => [
    { ...base, run: { ...base.run, status: "running", ingressPaused } },
  ];

  it("answers pausing for a queued pause on a wrapped run, at the run's head, with no frame and no applied time", async () => {
    const positionAsked: [string, number][] = [];
    const { get } = harness({
      tacho: wrapped(false),
      pauseRows: [
        pauseRow({
          outcome: "queued",
          expiresAt: new Date("2026-09-11T10:02:00.000Z"),
          appliedAt: null,
          appliedAtSeq: null,
        }),
      ],
      positionAsked,
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run.pause).toEqual({
      state: "pausing",
      commandId: "tcm_pause",
      resumeCommandId: null,
      seq: null,
      // The fixture's head: 2 turns, 3 model calls and 4 tool calls.
      turn: 2,
      step: 7,
      by: { id: USER, name: "Ada Park" },
      issuedAt: "2026-09-11T09:02:00.000Z",
      appliedAt: null,
      reason: "budget review",
    });
    expect(positionAsked).toEqual([]);
  });

  it("answers paused for an applied pause on a wrapped run, at its frame, with the turn and step counted there", async () => {
    const positionAsked: [string, number][] = [];
    const pauseAsked: string[] = [];
    const { get } = harness({
      tacho: wrapped(true),
      pauseRows: [pauseRow()],
      position: { turn: 3, step: 12 },
      positionAsked,
      pauseAsked,
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run.pause).toEqual({
      state: "paused",
      commandId: "tcm_pause",
      resumeCommandId: null,
      seq: "41",
      turn: 3,
      step: 12,
      by: { id: USER, name: "Ada Park" },
      issuedAt: "2026-09-11T09:02:00.000Z",
      appliedAt: "2026-09-11T09:02:04.000Z",
      reason: "budget review",
    });
    expect(pauseAsked).toEqual([TACHO_ID]);
    // The run's own chain, at the frame the host sealed.
    expect(positionAsked).toEqual([[SESSION_UUID, 41]]);
  });

  it("answers resuming for a resume queued behind the applied pause, naming both commands", async () => {
    const { get } = harness({
      tacho: wrapped(true),
      pauseRows: [resumeRow(), pauseRow()],
      position: { turn: 3, step: 12 },
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run.pause).toMatchObject({
      state: "resuming",
      commandId: "tcm_pause",
      resumeCommandId: "tcm_resume",
      seq: "41",
    });
  });

  it("answers no pause once the resume is applied (negative)", async () => {
    const { get } = harness({
      tacho: wrapped(false),
      pauseRows: [
        resumeRow({
          outcome: "applied",
          appliedAt: new Date("2026-09-11T09:04:03.000Z"),
          appliedAtSeq: 57,
        }),
        pauseRow(),
      ],
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.pause).toBeNull();
  });

  it("answers no pause for a queued pause past its expiry, or one the host refused (negative)", async () => {
    for (const row of [
      pauseRow({
        outcome: "queued",
        expiresAt: new Date(0),
        appliedAt: null,
        appliedAtSeq: null,
      }),
      pauseRow({ outcome: "failed", appliedAt: null, appliedAtSeq: null }),
    ]) {
      const { get } = harness({ tacho: wrapped(false), pauseRows: [row] });
      const out = await get(input({ runId: TACHO_ID }), ctx());
      expect(out.run.pause).toBeNull();
    }
  });

  it("answers a ledger run's pause from its ingress fence and its receipt, with no frame, turn or step", async () => {
    const positionAsked: [string, number][] = [];
    const { get } = harness({
      ledger: ledger(true),
      pauseRows: [pauseRow({ appliedAtSeq: null })],
      positionAsked,
    });
    const out = await get(input(), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run.pause).toEqual({
      state: "paused",
      commandId: "tcm_pause",
      resumeCommandId: null,
      seq: null,
      turn: null,
      step: null,
      by: { id: USER, name: "Ada Park" },
      issuedAt: "2026-09-11T09:02:00.000Z",
      appliedAt: "2026-09-11T09:02:04.000Z",
      reason: "budget review",
    });
    expect(positionAsked).toEqual([]);
  });

  it("answers no pause for a ledger run its fence does not hold, whatever a receipt says (negative)", async () => {
    const { get } = harness({
      ledger: ledger(false),
      pauseRows: [
        resumeRow({
          outcome: "applied",
          appliedAt: new Date("2026-09-11T09:04:00.000Z"),
        }),
        pauseRow({ appliedAtSeq: null }),
      ],
    });
    expect((await get(input(), ctx())).run.pause).toBeNull();
  });

  it("answers no pause for a sealed run and reads no pause row for it (negative)", async () => {
    const pauseAsked: string[] = [];
    const { get } = harness({
      tacho: [tachoSession({ publicId: TACHO_ID, session: { paused: true } })],
      pauseRows: [pauseRow()],
      pauseAsked,
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.status).toBe("sealed");
    expect(out.run.pause).toBeNull();
    expect(pauseAsked).toEqual([]);
  });

  it("still answers the pause when its turn and step cannot be read, with the position left null", async () => {
    const { get } = harness({
      tacho: wrapped(true),
      pauseRows: [pauseRow()],
      positionFails: true,
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run.pause).toMatchObject({
      state: "paused",
      seq: "41",
      turn: null,
      step: null,
    });
  });

  it("reads a blank name as none, and a row that names no user as no issuer", async () => {
    const blank = await harness({
      tacho: wrapped(true),
      pauseRows: [pauseRow({ issuedByName: "  " })],
    }).get(input({ runId: TACHO_ID }), ctx());
    expect(blank.run.pause?.by).toEqual({ id: USER, name: null });
    const nobody = await harness({
      tacho: wrapped(true),
      pauseRows: [pauseRow({ issuedByPublicId: null, issuedByName: null })],
    }).get(input({ runId: TACHO_ID }), ctx());
    expect(nobody.run.pause?.by).toBeNull();
  });

  it("leaves the field out when the pause read fails, and still answers the run", async () => {
    const { get } = harness({ tacho: wrapped(true), pauseFails: true });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.status).toBe("live");
    expect("pause" in out.run).toBe(false);
    expect(runGet.output.parse(out)).toEqual(out);
  });
});

describe("get_run fit (#3893)", () => {
  /** The seal the default wrapped session carries. */
  const SEALED = new Date("2026-09-11T09:05:00.000Z");
  const READING = {
    read: {
      prompts: 1,
      turns: 2,
      steps: 7,
      failed: 0,
      outputTokens: 900,
      reasoningTokens: 100,
    },
    model: { verdict: "over", tier: "sonnet", suggest: "haiku" },
    effort: { verdict: "fit", effort: "medium", source: "request" },
  };
  const stored = (sealedAt: Date, over: Record<string, unknown> = {}) => ({
    reading: READING,
    method: "run-fit/v1",
    readAt: new Date("2026-09-11T09:06:00.000Z"),
    sealedAt,
    ...over,
  });

  it("answers the stored reading for the seal it read, with its provenance", async () => {
    const { get, fitReads } = harness({ storedFit: stored(SEALED) });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run.fit).toEqual({
      ...READING,
      method: "run-fit/v1",
      readAt: "2026-09-11T09:06:00.000Z",
      sealedAt: "2026-09-11T09:05:00.000Z",
    });
    expect(fitReads).toEqual([{ source: "tacho", publicId: TACHO_ID }]);
  });

  it("reads a sealed ledger run's reading by its row id", async () => {
    const { get, fitReads } = harness({
      ledger: [
        ledgerRun({
          publicId: LEDGER_ID,
          runId: RUN_UUID,
          cost: rollupCostRow(),
          seal: seal(RUN_UUID),
        }),
      ],
      storedFit: stored(new Date("2026-09-11T10:05:00.000Z")),
    });
    const out = await get(input(), ctx());
    expect(fitReads).toEqual([{ source: "ledger", runId: RUN_UUID }]);
    expect(out.run.fit).toMatchObject({
      method: "run-fit/v1",
      sealedAt: "2026-09-11T10:05:00.000Z",
    });
  });

  it("answers no reading for a reading of an earlier seal, which a reopened run outlives (negative)", async () => {
    const { get } = harness({
      storedFit: stored(new Date("2026-09-11T08:00:00.000Z")),
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.fit).toBeNull();
  });

  it("answers no reading under a rule this build does not read, or a body it cannot parse (negative)", async () => {
    for (const over of [
      { method: "run-fit/v0" },
      { reading: { read: null } },
      { readAt: null },
    ]) {
      const { get } = harness({ storedFit: stored(SEALED, over) });
      const out = await get(input({ runId: TACHO_ID }), ctx());
      expect(out.run.fit).toBeNull();
    }
  });

  it("reads no reading for a live run: the reading is of a seal (negative)", async () => {
    const { get, fitReads } = harness({
      tacho: [
        tachoSession({
          publicId: TACHO_ID,
          session: { outcome: "running", sealedAt: null },
        }),
      ],
      storedFit: stored(SEALED),
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.status).toBe("live");
    expect(out.run.fit).toBeNull();
    expect(fitReads).toEqual([]);
  });

  it("answers no reading for a run with none yet, and still answers the run when the read fails", async () => {
    const none = await harness().get(input({ runId: TACHO_ID }), ctx());
    expect(none.run.fit).toBeNull();
    const failed = await harness({ fitFails: true }).get(
      input({ runId: TACHO_ID }),
      ctx(),
    );
    expect(failed.run.fit).toBeNull();
    expect(failed.run.id).toBe(TACHO_ID);
  });
});

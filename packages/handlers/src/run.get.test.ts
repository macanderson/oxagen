import { CapabilityError } from "@oxagen/oxagen/kernel";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
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
import { encodeRunCursor, type RunScope } from "./run.list";
import type { PauseCommandRow, PausePosition } from "./lib/run-pause";
import {
  ctx,
  event,
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
  sessionConfig?: { effort: string | null; thinking: boolean | null };
  /** The settings read rejects, as a ClickHouse outage would. */
  configFails?: boolean;
  /** The frame read rejects, as ClickHouse over its memory cap does. */
  framesFail?: boolean;
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
              : { effort: null, thinking: null },
          ),
    sessionRepository: (_scope, digest) => {
      over.repositoryAsked?.push(digest);
      return over.repositoryFails === true
        ? Promise.reject(new Error("postgres timeout"))
        : Promise.resolve(over.repositories?.[digest] ?? null);
    },
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
  return { get: createRunGetHandler(deps), log, sleeps, stores };
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
      sessionConfig: async () => ({ effort: null, thinking: null }),
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

  it("still answers the run when its title cannot be read", async () => {
    const { get } = harness({ titleFails: true });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    const plain = await harness().get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.name).toBe(plain.run.name);
  });

  it("answers the effort and thinking the session's frames recorded", async () => {
    const { get } = harness({
      sessionConfig: { effort: "high", thinking: true },
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.effort).toBe("high");
    expect(out.run.thinking).toBe(true);
  });

  it("keeps the session row's effort when no frame recorded one", async () => {
    const plain = await harness().get(input({ runId: TACHO_ID }), ctx());
    const { get } = harness({
      sessionConfig: { effort: null, thinking: false },
    });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.effort).toBe(plain.run.effort ?? null);
    expect(out.run.thinking).toBe(false);
  });

  it("still answers the run when its effort settings cannot be read", async () => {
    const { get } = harness({ configFails: true });
    const out = await get(input({ runId: TACHO_ID }), ctx());
    expect(out.run.thinking).toBeUndefined();
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
    const listed = memorySubagentChains(chains);
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
      sessionConfig: async () => ({ effort: null, thinking: null }),
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

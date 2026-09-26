import { CapabilityError } from "@oxagen/oxagen/kernel";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
import type { AttemptEventReadRecord } from "@oxagen/run-ledger";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { describe, expect, it, vi } from "vitest";
import {
  createRunGetHandler,
  decodeFrameCursor,
  encodeFrameCursor,
  type PlaceRepository,
  POLL_INTERVAL_MS,
  type RunGetDeps,
} from "./run.get";
import type { SessionConfig } from "./lib/run-work";
import { encodeRunCursor } from "./run.list";
import {
  ctx,
  event,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  OTHER_WORKSPACE,
  rollupCostRow,
  seal,
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
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      over.onSleep?.(sleeps.length, log);
      return Promise.resolve();
    },
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

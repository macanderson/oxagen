import { CapabilityError } from "@oxagen/oxagen/kernel";
import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runGet } from "@oxagen/oxagen/contracts/run.get";
import type { AttemptEventReadRecord } from "@oxagen/run-ledger";
import { describe, expect, it, vi } from "vitest";
import {
  createRunGetHandler,
  decodeFrameCursor,
  encodeFrameCursor,
  frameSummary,
  POLL_INTERVAL_MS,
  type RunGetDeps,
} from "./run.get";
import { encodeRunCursor } from "./run.list";
import {
  ctx,
  event,
  ledgerRun,
  memoryEvents,
  memoryStores,
  OTHER_WORKSPACE,
  summary,
  tachoSession,
  usage,
} from "./run.test-support";

const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";

type Over = {
  ledger?: Parameters<typeof memoryStores>[0];
  tacho?: Parameters<typeof memoryStores>[1];
  events?: AttemptEventReadRecord[];
  /** What RunStore answers for the public id; defaults to the seeded run. */
  found?: boolean;
  /** Runs after each fake sleep, with the count so far; a test lands events here. */
  onSleep?: (count: number, log: AttemptEventReadRecord[]) => void;
};

function harness(over: Over = {}) {
  const stores = memoryStores(
    over.ledger ?? [
      ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID, usage: usage() }),
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
    sumTokenUsage: stores.sumTokenUsage,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      over.onSleep?.(sleeps.length, log);
      return Promise.resolve();
    },
  };
  return { get: createRunGetHandler(deps), log, sleeps, stores };
}

const input = (
  over: Partial<Parameters<ReturnType<typeof harness>["get"]>[0]> = {},
) => ({ runId: LEDGER_ID, frameLimit: 200, waitMs: 0, ...over });

describe("get_run", () => {
  it("answers a wrapped session's header with frames null, and never waits for it", async () => {
    const { get, sleeps } = harness();
    const out = await get(input({ runId: TACHO_ID, waitMs: 5_000 }), ctx());
    expect(runGet.output.parse(out)).toEqual(out);
    expect(out.run).toMatchObject({
      id: TACHO_ID,
      source: "tacho",
      cost: null,
    });
    expect(out.frames).toBeNull();
    expect(sleeps).toEqual([]);
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
    expect(out.frames?.cursor).toBe(out.frames?.frames.at(-1)?.cursor);
    expect(out.frames?.frames[0]).toMatchObject({
      type: "tool.call_completed",
      stage: "act",
      summary: "read_file ok",
      digest: event(1).eventDigest,
      observedAt: "2026-09-11T10:00:01.000Z",
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

    // The SSE client resumes from the last frame it rendered.
    const lastFrame = second.frames?.frames.at(-1);
    const fromFrame = await get(
      input({ framesAfter: lastFrame?.cursor ?? "" }),
      ctx(),
    );
    expect(fromFrame.frames?.frames.map((f) => f.seq)).toEqual(["5"]);

    // Past the end: nothing, and the caller keeps its cursor.
    const end = await get(
      input({ framesAfter: third.frames?.cursor ?? "" }),
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
    expect(decodeFrameCursor(out.frames?.cursor ?? "")).toBe("2");
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

  it("does not call ClickHouse or the ledger reader for a wrapped session", async () => {
    const readEvents = vi.fn();
    const stores = memoryStores([], [tachoSession({ publicId: TACHO_ID })]);
    const get = createRunGetHandler({
      queries: stores.queries,
      store: { getRunByPublicId: vi.fn(), readAttemptEventsSince: readEvents },
      sumTokenUsage: stores.sumTokenUsage,
      now: () => 0,
      sleep: () => Promise.resolve(),
    });
    await get(input({ runId: TACHO_ID }), ctx());
    expect(readEvents).not.toHaveBeenCalled();
    expect(stores.usageCalls).toEqual([]);
  });
});

describe("frameSummary", () => {
  it("labels each receipt from its identifiers and falls back to the type", () => {
    expect(
      frameSummary(
        event(1, {
          eventType: "admission.run_admitted",
          payload: { engine_name: "stella", engine_version: "2.1.0" },
        }),
      ),
    ).toBe("stella@2.1.0");
    expect(
      frameSummary(
        event(1, {
          eventType: "context.frames_selected",
          payload: { frame_count: 12 },
        }),
      ),
    ).toBe("frames=12");
    expect(
      frameSummary(
        event(1, {
          eventType: "model.call_completed",
          payload: { provider: "anthropic", model: "claude-sonnet-4-5" },
        }),
      ),
    ).toBe("anthropic/claude-sonnet-4-5");
    expect(frameSummary(event(1))).toBe("read_file ok");
    // An encrypted payload shows nothing it cannot read.
    expect(
      frameSummary(
        event(1, {
          eventType: "model.call_completed",
          payload: null,
          encryptedPayloadRef: "blob://x",
        }),
      ),
    ).toBe("model.call_completed");
    expect(
      frameSummary(
        event(1, { eventType: "checkout.completed", payload: { sha: "abc" } }),
      ),
    ).toBe("checkout.completed");
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

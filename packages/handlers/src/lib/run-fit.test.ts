// The Model fit reading as the durable job writes it (#3893): read from the
// run's own row, its effort, its transcript figures and its rollup tokens,
// computed by `runFit`, and written with the seal it read. The stores are the
// in-memory fakes the run handlers' tests share, so the reading reads the same
// row and frames `get_run` and `get_run_transcript` would.
import type { RunFit } from "@oxagen/oxagen/run-fit";
import { digestBytes } from "@oxagen/tacho";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { describe, expect, it, vi } from "vitest";
import {
  memoryEvents,
  memoryStores,
  memoryTachoFrames,
  SCOPE,
  tachoRow,
  tachoSession,
} from "../run.test-support";
import { type RunFitDeps, storedFitOf, writeRunFitReading } from "./run-fit";
import type { SessionConfig } from "./run-work";

const TACHO_ID = "tse_4q8r1t6v3x5z0b2d7h2k9m";
const SESSION_UUID = "0192d4a8-7c1e-7a00-8000-00000000c0de";
const SEALED = "2026-09-11T09:05:00.000Z";
const NOW = new Date("2026-09-11T09:06:00.000Z");

const enc = new TextEncoder();
const objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
/** A body the fake evidence store holds, and the columns a frame names it by. */
function stored(text: string) {
  const bytes = enc.encode(text);
  const digest = digestBytes(bytes);
  const ref = `evb:v1:k:${digest.slice(7)}`;
  objects.set(ref, { bytes, contentType: "text/plain" });
  return { contentDigest: digest, bytesRef: ref };
}

const blank = { toolName: "", toolStatus: "", toolUseId: "" };
/** One prompt, one tool call that worked: a first-try run. */
const FIRST_TRY: TachoFrameRow[] = [
  tachoRow(0, {
    kind: "turn_start",
    ...blank,
    turnSeq: 1,
    ...stored("Rename the flag."),
  }),
  tachoRow(1, { kind: "tool_call", toolName: "Edit", turnSeq: 1 }),
];

type Over = {
  rows?: TachoFrameRow[];
  session?: Parameters<typeof tachoSession>[0]["session"];
  config?: SessionConfig;
  tokens?: { output: number; reasoning: number } | null;
};

function harness(over: Over = {}) {
  const stores = memoryStores(
    [],
    [tachoSession({ publicId: TACHO_ID, session: over.session ?? {} })],
  );
  const writes: { target: unknown; fit: RunFit }[] = [];
  const deps: RunFitDeps = {
    read: {
      queries: stores.queries,
      store: {
        getRunByPublicId: () => Promise.resolve(null),
        readAttemptEventsSince: memoryEvents([]),
      },
      readRunRollups: stores.readRunRollups,
      readWitnessFor: () => Promise.resolve(null),
      tachoFrames: memoryTachoFrames(SESSION_UUID, over.rows ?? FIRST_TRY),
    },
    bodies: {
      getBody: (_scope, ref) => {
        const object = objects.get(ref);
        if (!object) return Promise.reject(new Error(`no object for ${ref}`));
        return Promise.resolve({ ...object, digestHex: ref.slice(-64) });
      },
      getAssembly: () => Promise.resolve(null),
    },
    sessionConfig: vi.fn(() =>
      Promise.resolve(
        over.config ?? { effort: null, effortSource: null, thinking: null },
      ),
    ),
    readTokens: () =>
      Promise.resolve(
        over.tokens === undefined ? { output: 900, reasoning: 100 } : over.tokens,
      ),
    writeFit: (_scope, target, fit) => {
      writes.push({ target, fit });
      return Promise.resolve(true);
    },
    now: () => NOW,
  };
  return { deps, writes };
}

describe("writeRunFitReading", () => {
  it("reads a sealed first-try run from its record and writes the reading with the seal it read", async () => {
    const { deps, writes } = harness({
      session: { numTurns: 2 },
      config: { effort: "high", effortSource: "request", thinking: null },
      tokens: { output: 600, reasoning: 400 },
    });
    const out = await writeRunFitReading(deps, SCOPE, TACHO_ID);
    const fit = {
      method: "run-fit/v1",
      readAt: NOW.toISOString(),
      sealedAt: SEALED,
      // Two turns and seven steps from the row, one prompt and no failed call
      // from the frames, and the output with its reasoning added back.
      read: {
        prompts: 1,
        turns: 2,
        steps: 7,
        failed: 0,
        outputTokens: 1_000,
        reasoningTokens: 400,
      },
      model: { verdict: "over", tier: "sonnet", suggest: "haiku" },
      effort: {
        verdict: "over",
        effort: "high",
        source: "request",
        suggest: "medium",
      },
    };
    expect(out).toEqual({ outcome: "written", fit });
    expect(writes).toEqual([
      { target: { source: "tacho", publicId: TACHO_ID }, fit },
    ]);
  });

  it("counts a failed tool call and a second prompt, and argues one rung up", async () => {
    const { deps } = harness({
      rows: [
        ...FIRST_TRY,
        tachoRow(2, {
          kind: "tool_call",
          toolName: "Bash",
          toolStatus: "error",
          turnSeq: 1,
        }),
        tachoRow(3, {
          kind: "turn_start",
          ...blank,
          turnSeq: 2,
          ...stored("That broke the build, try again."),
        }),
      ],
      session: { numTurns: 6, numModelCalls: 20, numToolCalls: 20 },
      config: { effort: "low", effortSource: "harness", thinking: null },
    });
    const out = await writeRunFitReading(deps, SCOPE, TACHO_ID);
    expect(out.outcome).toBe("written");
    if (out.outcome !== "written") throw new Error(out.outcome);
    expect(out.fit.read).toMatchObject({ prompts: 2, failed: 1 });
    expect(out.fit.model).toEqual({
      verdict: "under",
      tier: "sonnet",
      suggest: "opus",
    });
    expect(out.fit.effort).toMatchObject({ verdict: "under", suggest: "medium" });
  });

  it("does not count a prompt of only whitespace, as the page does not", async () => {
    const { deps } = harness({
      rows: [
        ...FIRST_TRY,
        tachoRow(2, {
          kind: "turn_start",
          ...blank,
          turnSeq: 2,
          ...stored("   \n"),
        }),
      ],
    });
    const out = await writeRunFitReading(deps, SCOPE, TACHO_ID);
    if (out.outcome !== "written") throw new Error(out.outcome);
    expect(out.fit.read?.prompts).toBe(1);
  });

  it("says an observe run's effort was not captured, and a gateway run's that the agent sent none", async () => {
    const observed = await writeRunFitReading(harness().deps, SCOPE, TACHO_ID);
    expect(observed).toMatchObject({
      fit: { effort: { verdict: "unseen", why: "not_proxied" } },
    });
    const gateway = await writeRunFitReading(
      harness({ session: { enforcementTier: "gateway" } }).deps,
      SCOPE,
      TACHO_ID,
    );
    expect(gateway).toMatchObject({
      fit: { effort: { verdict: "unseen", why: "not_sent" } },
    });
  });

  it("reads the row's effort as the harness's when the frames recorded none", async () => {
    const out = await writeRunFitReading(
      harness({ session: { effort: "medium" } }).deps,
      SCOPE,
      TACHO_ID,
    );
    expect(out).toMatchObject({
      fit: { effort: { effort: "medium", source: "harness" } },
    });
  });

  it("stores no token figures when the rollup has no row, and never argues for less effort on them (negative)", async () => {
    const untotalled = await writeRunFitReading(
      harness({
        tokens: null,
        config: { effort: "high", effortSource: "request", thinking: null },
      }).deps,
      SCOPE,
      TACHO_ID,
    );
    expect(untotalled).toMatchObject({
      fit: {
        read: { outputTokens: null, reasoningTokens: null },
        effort: { verdict: "fit", effort: "high" },
      },
    });
  });

  it("leaves a live run alone, and answers not_found for a run no store holds (negative)", async () => {
    const live = harness({ session: { outcome: "running", sealedAt: null } });
    await expect(writeRunFitReading(live.deps, SCOPE, TACHO_ID)).resolves.toEqual(
      { outcome: "live" },
    );
    expect(live.writes).toEqual([]);
    const gone = harness();
    await expect(
      writeRunFitReading(gone.deps, SCOPE, "tse_0000000000000000000000"),
    ).resolves.toEqual({ outcome: "not_found" });
    expect(gone.writes).toEqual([]);
  });
});

describe("storedFitOf", () => {
  const reading = {
    read: null,
    model: null,
    effort: { verdict: "unseen", why: "not_proxied" },
  };
  const row = {
    reading,
    method: "run-fit/v1",
    readAt: NOW,
    sealedAt: new Date(SEALED),
  };

  it("answers the reading of this seal, with its provenance", () => {
    expect(storedFitOf(row, SEALED)).toEqual({
      ...reading,
      method: "run-fit/v1",
      readAt: NOW.toISOString(),
      sealedAt: SEALED,
    });
  });

  it("answers nothing for another seal, another rule, a broken body, a live run or no row (negative)", () => {
    expect(storedFitOf(row, "2026-09-11T10:00:00.000Z")).toBeNull();
    expect(storedFitOf({ ...row, method: "run-fit/v2" }, SEALED)).toBeNull();
    expect(storedFitOf({ ...row, reading: { read: 3 } }, SEALED)).toBeNull();
    expect(storedFitOf(row, null)).toBeNull();
    expect(storedFitOf(null, SEALED)).toBeNull();
  });
});

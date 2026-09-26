import { isHandlerError } from "@oxagen/oxagen/handler-error";
import { runBisect } from "@oxagen/oxagen/contracts/run.bisect";
import type { AttemptEventReadRecord } from "@oxagen/run-ledger";
import type { TachoFrameRow } from "@oxagen/telemetry";
import { describe, expect, it } from "vitest";
import { createRunBisectHandler } from "./run.bisect";
import type { RunReadDeps } from "./lib/run-read";
import {
  ctx,
  event,
  ledgerRun,
  memoryEvents,
  memoryStores,
  memorySubagentFrames,
  summary,
  tachoRow,
  tachoSession,
} from "./run.test-support";

const RUN_UUID = "0192d4a8-7c1e-7a00-8000-0000000000a1";
const LEDGER_ID = "arun_5f0c2e9a1b7d4c3e8f6a02";
const TACHO_A = "tse_aaaaaaaaaaaaaaaaaaaaaa";
const TACHO_B = "tse_bbbbbbbbbbbbbbbbbbbbbb";
const SESSION_A = "0192d4a8-7c1e-7a00-8000-00000000000a";
const SESSION_B = "0192d4a8-7c1e-7a00-8000-00000000000b";

function harness(over: {
  a: TachoFrameRow[];
  b: TachoFrameRow[];
  events?: AttemptEventReadRecord[];
  /** Both runs' subagent frames, as the subagent read answers them. */
  children?: TachoFrameRow[];
}) {
  const stores = memoryStores(
    [ledgerRun({ publicId: LEDGER_ID, runId: RUN_UUID })],
    [
      tachoSession({ publicId: TACHO_A, session: { sessionUuid: SESSION_A } }),
      tachoSession({ publicId: TACHO_B, session: { sessionUuid: SESSION_B } }),
    ],
  );
  const bySession: Record<string, TachoFrameRow[]> = {
    [SESSION_A]: over.a,
    [SESSION_B]: over.b,
  };
  const deps: RunReadDeps = {
    queries: stores.queries,
    store: {
      getRunByPublicId: (id) =>
        Promise.resolve(id === LEDGER_ID ? summary() : null),
      readAttemptEventsSince: memoryEvents(over.events ?? []),
    },
    readRunRollups: stores.readRunRollups,
    readWitnessFor: stores.readWitnessFor,
    tachoFrames: ({ sessionUuid, afterSeq, limit }) =>
      Promise.resolve(
        (bySession[sessionUuid] ?? [])
          .filter((r) => r.seq > afterSeq)
          .slice(0, limit),
      ),
    ...(over.children === undefined
      ? {}
      : { tachoSubagentFrames: memorySubagentFrames(over.children) }),
  };
  return createRunBisectHandler(deps);
}

const same = [
  tachoRow(0, { kind: "agent_start", toolName: "", toolStatus: "" }),
  tachoRow(1, { toolName: "Read", toolStatus: "ok" }),
  tachoRow(2, {
    kind: "policy_decision",
    toolName: "",
    toolStatus: "",
    policyDecision: "allow",
  }),
];

describe("bisect_runs", () => {
  it("answers null for two identical recordings, and for a run against itself", async () => {
    const bisect = harness({ a: same, b: same });
    const out = await bisect({ runA: TACHO_A, runB: TACHO_B }, ctx());
    expect(runBisect.output.parse(out)).toEqual(out);
    expect(out).toEqual({
      divergentSeq: null,
      keyA: null,
      keyB: null,
      aligned: 3,
    });
    expect(await bisect({ runA: TACHO_A, runB: TACHO_A }, ctx())).toEqual(out);
  });

  it("opens at the first frame whose kind or call identity differs", async () => {
    const bisect = harness({
      a: same,
      b: [
        same[0] as TachoFrameRow,
        tachoRow(1, { toolName: "Read", toolStatus: "ok" }),
        tachoRow(2, {
          kind: "policy_decision",
          toolName: "",
          toolStatus: "",
          policyDecision: "deny",
        }),
      ],
    });
    expect(await bisect({ runA: TACHO_A, runB: TACHO_B }, ctx())).toEqual({
      divergentSeq: "2",
      keyA: "policy_decision:policy=allow",
      keyB: "policy_decision:policy=deny",
      aligned: 2,
    });
  });

  it("aligns a ledger run against a wrapped one by position, and a shorter run diverges where it ends", async () => {
    const bisect = harness({
      a: same,
      b: [],
      events: [
        event(1, { eventType: "admission.run_admitted", payload: {} }),
        event(2, { payload: { capability_name: "Read", outcome: "ok" } }),
      ],
    });
    expect(await bisect({ runA: LEDGER_ID, runB: TACHO_A }, ctx())).toEqual({
      divergentSeq: "1",
      keyA: "admission.run_admitted",
      keyB: "agent_start",
      aligned: 0,
    });
    expect(await bisect({ runA: TACHO_B, runB: TACHO_A }, ctx())).toEqual({
      divergentSeq: "0",
      keyA: null,
      keyB: "agent_start",
      aligned: 0,
    });
  });

  it("refuses when the capped prefixes agree and either run is longer than the cap, and answers a divergence inside the prefix (negative)", async () => {
    const CAP = 10_000;
    const long = Array.from({ length: CAP + 1 }, (_, i) => tachoRow(i));
    const exact = long.slice(0, CAP);
    for (const [a, b] of [
      [long, long],
      [long, exact],
    ] as const) {
      await expect(
        harness({ a, b })({ runA: TACHO_A, runB: TACHO_B }, ctx()),
      ).rejects.toSatisfy(
        (e) =>
          isHandlerError(e) &&
          e.code === "conflict" &&
          e.reason === "run_exceeds_bisect_cap",
      );
    }
    const diverged = [...long];
    diverged[5] = tachoRow(5, { toolName: "Write" });
    expect(
      await harness({ a: long, b: diverged })(
        { runA: TACHO_A, runB: TACHO_B },
        ctx(),
      ),
    ).toMatchObject({ divergentSeq: "5", aligned: 5 });
  });

  it("is not_found when either run is outside the workspace (negative)", async () => {
    const bisect = harness({ a: same, b: same });
    await expect(
      bisect({ runA: TACHO_A, runB: "tse_nope" }, ctx()),
    ).rejects.toSatisfy((e) => isHandlerError(e) && e.code === "not_found");
  });
});

// #3823: a wrapped run is compared as every chain it recorded, each subagent
// chain spliced in after the frame that spawned it.
describe("bisect_runs across subagent chains (#3823)", () => {
  const CHILD_A = "0192d4a8-7c1e-7a00-8000-0000000c1d0a";
  const CHILD_B = "0192d4a8-7c1e-7a00-8000-0000000c1d0b";
  const root = [
    tachoRow(0, { kind: "agent_start", toolName: "", toolStatus: "" }),
    tachoRow(1, {
      kind: "subagent_start",
      toolName: "",
      toolStatus: "",
      toolUseId: "toolu_A",
    }),
    tachoRow(2, { toolName: "Edit", toolStatus: "ok" }),
  ];
  /** A frame on the subagent chain `session` spawned under `rootUuid`. */
  const onChain = (
    session: string,
    rootUuid: string,
    seq: number,
    over: Partial<TachoFrameRow> = {},
  ) =>
    tachoRow(seq, {
      sessionUuid: session,
      rootSessionUuid: rootUuid,
      parentSessionUuid: rootUuid,
      subagentId: "agent-1",
      spawnToolUseId: "toolu_A",
      ...over,
    });

  it("opens inside a subagent chain and names it, since its seq alone would name the run's own frame", async () => {
    const bisect = harness({
      a: root,
      b: root,
      children: [
        onChain(CHILD_A, SESSION_A, 0),
        onChain(CHILD_A, SESSION_A, 1),
        onChain(CHILD_B, SESSION_B, 0),
        onChain(CHILD_B, SESSION_B, 1, { toolName: "Write" }),
      ],
    });
    const out = await bisect({ runA: TACHO_A, runB: TACHO_B }, ctx());
    expect(runBisect.output.parse(out)).toEqual(out);
    // Spliced: agent_start, subagent_start, the chain's 0 and 1, then Edit.
    expect(out).toEqual({
      divergentSeq: "1",
      divergentSessionUuid: CHILD_A,
      keyA: "tool_call:Read=ok",
      keyB: "tool_call:Write=ok",
      aligned: 3,
    });
  });

  it("names run B's chain where run A has no frame, and compares a subagent's frame against the run's next", async () => {
    // Run A's subagent recorded one frame; run B's recorded none.
    const onlyA = harness({
      a: root,
      b: root,
      children: [onChain(CHILD_A, SESSION_A, 0)],
    });
    expect(await onlyA({ runA: TACHO_A, runB: TACHO_B }, ctx())).toEqual({
      divergentSeq: "0",
      divergentSessionUuid: CHILD_A,
      keyA: "tool_call:Read=ok",
      keyB: "tool_call:Edit=ok",
      aligned: 2,
    });

    const shorter = harness({
      a: root.slice(0, 2),
      b: root.slice(0, 2),
      children: [onChain(CHILD_B, SESSION_B, 0)],
    });
    expect(await shorter({ runA: TACHO_A, runB: TACHO_B }, ctx())).toEqual({
      divergentSeq: "0",
      divergentSessionUuid: CHILD_B,
      keyA: null,
      keyB: "tool_call:Read=ok",
      aligned: 2,
    });
  });

  it("names no chain when the runs diverge on their own chains, and none when they agree (negative)", async () => {
    const children = [
      onChain(CHILD_A, SESSION_A, 0),
      onChain(CHILD_B, SESSION_B, 0),
    ];
    const agree = harness({ a: root, b: root, children });
    expect(await agree({ runA: TACHO_A, runB: TACHO_B }, ctx())).toEqual({
      divergentSeq: null,
      keyA: null,
      keyB: null,
      aligned: 4,
    });
    const differ = harness({
      a: root,
      b: [...root.slice(0, 2), tachoRow(2, { toolName: "Bash" })],
      children,
    });
    const out = await differ({ runA: TACHO_A, runB: TACHO_B }, ctx());
    expect(out).toMatchObject({ divergentSeq: "2", aligned: 3 });
    expect("divergentSessionUuid" in out).toBe(false);
  });
});

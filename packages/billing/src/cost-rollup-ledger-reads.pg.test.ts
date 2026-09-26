// The two ledger reads the cost rollup and the Runs list share, evaluated by
// Postgres over the payloads the in-app assistant writes (#3372). Runs
// wherever DATABASE_URL points at a database (CI's `test` job); a local run
// without one is skipped, not red. It reads literals and writes nothing.
//
// A shape test of the rendered SQL says which text the query sends. These say
// what Postgres answers for it: that the turn rule agrees with the seal's
// rollup on every payload shape, so a run's turns do not change when
// compaction swaps its rows for the seal, and that an assistant tool call's
// name reaches the breakdown.
import { closeDatabase, withSystemDb } from "@oxagen/database";
import { deriveSealRollup, type SealedFrameRow } from "@oxagen/run-ledger";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { rollupRun, type RunMeta } from "./cost-rollup";
import { modelCallHidesTurn, toolCallName } from "./cost-rollup-store";

const enabled = Boolean(process.env.DATABASE_URL);

type Payload = Record<string, unknown> | null;

/** A payload as a jsonb literal, or SQL null for an encrypted one. */
function jsonb(payload: Payload): SQL {
  return payload === null
    ? sql`null::jsonb`
    : sql`(${JSON.stringify(payload)}::text)::jsonb`;
}

async function answer<T>(expression: SQL): Promise<T> {
  const rows = (await withSystemDb((tx) =>
    tx.execute(sql`select ${expression} as value`),
  )) as unknown as Array<{ value: T }>;
  return rows[0]!.value;
}

/** A sealed model call with this payload, as the seal's rollup reads it. */
function modelCall(payload: Payload): SealedFrameRow {
  return {
    id: "e1",
    attempt_seq: 1,
    run_seq: 1,
    event_schema_version: "1",
    event_type: "model.engine_call_completed",
    stage: "act",
    payload_digest: `sha256:${"a".repeat(64)}`,
    event_digest: `sha256:${"b".repeat(64)}`,
    payload_inline: payload,
    encrypted_payload_ref: payload === null ? "enc:v1:k:abc" : null,
    observed_at: "2026-09-25T00:00:00.000Z",
    created_at: "2026-09-25T00:00:00.000Z",
    body_ref: null,
    body_digest: null,
    body_bytes: null,
    redactions: null,
    fidelity: "full",
  };
}

const META: RunMeta = {
  runId: "arun_0123456789abcdef012345",
  runSource: "ledger",
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
  operatorPrincipalId: null,
  operatorKey: null,
  agentPrincipalId: null,
  agentKey: null,
  taskRef: null,
  costCenter: null,
  startedAt: new Date("2026-09-25T09:00:00.000Z"),
  sealedAt: new Date("2026-09-25T09:10:00.000Z"),
  turns: null,
  retries: 0,
  enforcementTier: null,
  replayGrade: null,
};

describe.skipIf(!enabled)("the ledger reads against Postgres", () => {
  afterAll(async () => {
    await closeDatabase();
  });

  it.each<[string, Payload]>([
    ["an encrypted payload", null],
    [
      "an engine call's payload",
      { engine_seq: 1, model_call_id: "prov-1-0", outcome: "completed" },
    ],
    ["a null turn index", { turn_index: null }],
    ["a turn index", { turn_index: 3 }],
  ])(
    "hides the turn count for %s exactly when the seal's rollup does",
    async (_, payload) => {
      const hides = await answer<boolean>(modelCallHidesTurn(jsonb(payload)));
      expect(hides).toBe(deriveSealRollup([modelCall(payload)]).turns === null);
    },
  );

  it("puts an assistant tool call in the breakdown under its tool_name", async () => {
    // What `tool.engine_call_completed` carries: `tool_name`, and no
    // `capability_name`.
    const engine = await answer<string | null>(
      toolCallName(
        jsonb({
          engine_seq: 2,
          tool_call_id: "call-1",
          tool_name: "search_tools",
          outcome: "succeeded",
        }),
      ),
    );
    const ledger = await answer<string | null>(
      toolCallName(jsonb({ capability_name: "run.list" })),
    );
    const encrypted = await answer<string | null>(toolCallName(jsonb(null)));
    const record = rollupRun({
      meta: META,
      modelCalls: [],
      toolCalls: [{ name: engine }, { name: ledger }, { name: encrypted }],
      book: [],
    });
    expect(record.toolCalls).toBe(3);
    expect(record.breakdown.tools).toEqual([
      { name: "run.list", calls: 1 },
      { name: "search_tools", calls: 1 },
    ]);
  });
});

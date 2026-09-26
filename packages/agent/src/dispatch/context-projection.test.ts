import { describe, expect, it, vi } from "vitest";
import { NO_BODY, type AttemptEventReadRecord } from "@oxagen/run-ledger";
import {
  manifestParams,
  type ProjectionSession,
  projectRunContextWindows,
} from "./context-projection";

const RUN = {
  runId: "0192d4a8-7c1e-7a00-8000-0000000000a1",
  runPublicId: "arun_5f0c2e9a1b7d4c3e8f6a02",
  executionRef: "0192d4a8-7c1e-7a00-8000-00000000m5g1",
};

function event(
  runSeq: number,
  eventType: string,
  payload: Record<string, unknown>,
): AttemptEventReadRecord {
  return {
    eventId: `0192d4a8-7c1e-7a00-8000-0000000000e${runSeq}`,
    attemptId: "0192d4a8-7c1e-7a00-8000-0000000000b1",
    attemptPublicId: "aatt_0123456789abcdefghjkmn",
    runSeq: String(runSeq),
    attemptSeq: runSeq,
    eventSchemaVersion: "agent-run-event/v2",
    eventType,
    stage: "model",
    payloadDigest: `sha256:${"a".repeat(64)}`,
    eventDigest: `sha256:${String(runSeq).padStart(64, "0")}`,
    payload,
    encryptedPayloadRef: null,
    observedAt: new Date("2026-09-26T10:00:00.000Z"),
    recordedAt: new Date("2026-09-26T10:00:00.500Z"),
    body: NO_BODY,
  };
}

const started = (seq: number, id: string) =>
  event(seq, "model.engine_call_started", {
    engine_seq: seq,
    model_call_id: id,
    role: "worker",
    provider: "oxagen",
    model: "anthropic/claude-sonnet-4",
    window: {
      blocks: [
        { kind: "system", bytes: 1204, items: 1 },
        { kind: "steering", bytes: 0, items: 0 },
        { kind: "tools", bytes: 9120, items: 14 },
        { kind: "context", bytes: 412, items: 2 },
        { kind: "conversation", bytes: 954, items: 3 },
      ],
    },
  });

const completed = (seq: number, id: string) =>
  event(seq, "model.engine_call_completed", {
    engine_seq: seq,
    model_call_id: id,
    role: "worker",
    provider: "oxagen",
    model: "anthropic/claude-sonnet-4.6",
    outcome: "completed",
    input_tokens: 4000,
  });

/** The run's events as the store pages them: strictly after the cursor, at most `limit`. */
function reader(log: AttemptEventReadRecord[]) {
  const pages: string[] = [];
  const read = (_runId: string, after: string, limit: number) => {
    pages.push(after);
    return Promise.resolve(
      log.filter((e) => BigInt(e.runSeq) > BigInt(after)).slice(0, limit),
    );
  };
  return { read, pages };
}

function session() {
  const runs: { cypher: string; params: Record<string, unknown> }[] = [];
  const close = vi.fn(async () => undefined);
  const s: ProjectionSession = {
    run: (cypher, params) => {
      runs.push({ cypher, params });
      return Promise.resolve({ records: [] });
    },
    close,
  };
  return { s, runs, close };
}

describe("projectRunContextWindows", () => {
  it("merges one manifest per measured window under the turn's execution, and writes no bytes or tokens", async () => {
    const { read } = reader([
      event(1, "admission.run_admitted", {}),
      started(2, "prov-1-0"),
      completed(3, "prov-1-0"),
      started(4, "prov-1-1"),
      completed(5, "prov-1-1"),
    ]);
    const { s, runs, close } = session();

    const projected = await projectRunContextWindows(RUN, read, () => s);

    expect(projected).toBe(2);
    expect(runs).toHaveLength(3);
    expect(runs.map((r) => r.cypher)).toEqual([
      expect.stringContaining("MERGE (e:Execution"),
      expect.stringContaining("MERGE (m:ContextManifest"),
      expect.stringContaining("MERGE (e)-[u:USED_CONTEXT]->(m)"),
    ]);
    // Every statement anchors the tenant, as the scoped session requires.
    for (const r of runs) expect(r.cypher).toContain("orgId: $orgId");
    const windows = runs[1]?.params["windows"];
    expect(windows).toEqual([
      {
        id: `${RUN.runPublicId}:2`,
        publicId: `context-window:${RUN.runPublicId}:2`,
        seq: "2",
        modelCallId: "prov-1-0",
        // The empty steering block carried nothing, so it is not named.
        kinds: ["system", "tools", "context", "conversation"],
        items: [1, 14, 2, 3],
        displayName: `Context window: ${RUN.runPublicId} frame 2`,
      },
      expect.objectContaining({ id: `${RUN.runPublicId}:4`, seq: "4" }),
    ]);
    expect(JSON.stringify(runs.map((r) => r.params))).not.toMatch(
      /bytes|tokens/,
    );
    expect(runs[0]?.params["executionRef"]).toBe(RUN.executionRef);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("writes nothing for a run that measured no window", async () => {
    const { read } = reader([completed(3, "prov-1-0")]);
    const { s, runs } = session();
    expect(await projectRunContextWindows(RUN, read, () => s)).toBe(0);
    expect(runs).toEqual([]);
  });

  it("walks the ledger page by page from the run's first event", async () => {
    const log = Array.from({ length: 1200 }, (_, i) =>
      event(i + 1, "tool.engine_call_completed", {}),
    );
    log.push(started(1201, "prov-9"));
    const { read, pages } = reader(log);
    const { s } = session();
    expect(await projectRunContextWindows(RUN, read, () => s)).toBe(1);
    expect(pages).toEqual(["0", "500", "1000"]);
  });

  it("closes the session and throws when Neo4j refuses a statement (negative)", async () => {
    const { read } = reader([started(2, "prov-1-0")]);
    const close = vi.fn(async () => undefined);
    const failing: ProjectionSession = {
      run: () => Promise.reject(new Error("neo4j unavailable")),
      close,
    };
    await expect(
      projectRunContextWindows(RUN, read, () => failing),
    ).rejects.toThrow("neo4j unavailable");
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("manifestParams", () => {
  it("names the blocks the window carried and nothing it measured", () => {
    const params = manifestParams(RUN.runPublicId, {
      seq: "7",
      responseSeq: null,
      modelCallId: null,
      provider: null,
      model: null,
      promptTokens: null,
      bytes: 10,
      blocks: [
        { kind: "system", bytes: 0, items: 0, tokens: null },
        { kind: "conversation", bytes: 10, items: 1, tokens: null },
      ],
    });
    expect(params.kinds).toEqual(["conversation"]);
    expect(params.items).toEqual([1]);
    expect(params.modelCallId).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import {
  RUN_OUTPUT_DURABLE_KINDS,
  RUN_OUTPUT_KINDS,
  runOutputsGet,
} from "./run.outputs.get";

function node(over: Record<string, unknown> = {}) {
  return {
    seq: "118",
    kind: "file",
    name: "app/page.tsx",
    nameIsLocator: false,
    where: "tsx",
    state: "created",
    note: "1 write",
    stat: { added: 40, removed: 0 },
    observedAt: null,
    digestBefore: null,
    digestAfter: null,
    ...over,
  };
}

function output(over: Record<string, unknown> = {}) {
  return {
    runId: "tse_01k5rq4b9c7xtn2p",
    source: "wrapped",
    nodes: [node()],
    tally: { artifacts: 1, reads: 0, gates: 0 },
    complete: true,
    ...over,
  };
}

describe("get_run_outputs contract", () => {
  it("is an unbilled read on the API alone, never an MCP tool", () => {
    expect(runOutputsGet.noBillingGate).toBe(true);
    expect(runOutputsGet.mutates).toBe(false);
    expect(runOutputsGet.surfaces).toEqual(["api"]);
    expect(runOutputsGet.defaultEffect).toBe("deny");
  });

  it("promises the app layer, because the spine is the Run page", () => {
    expect(runOutputsGet.layers).toContain("app");
  });

  it("takes a run id and nothing else", () => {
    expect(
      runOutputsGet.input.safeParse({ runId: "tse_01k5rq4b9c7xtn2p" }).success,
    ).toBe(true);
    expect(
      runOutputsGet.input.safeParse({
        runId: "tse_01k5rq4b9c7xtn2p",
        limit: 10,
      }).success,
    ).toBe(false);
  });

  it("accepts a spine of nodes with its tally", () => {
    expect(runOutputsGet.output.safeParse(output()).success).toBe(true);
  });

  it("counts a read and a gate as kinds, never as artifacts", () => {
    // The tally is the contract's; the handler's arithmetic is tested there.
    // What is pinned here is that neither kind is durable.
    for (const kind of ["read", "gate", "would"]) {
      expect(RUN_OUTPUT_KINDS).toContain(kind);
      expect(RUN_OUTPUT_DURABLE_KINDS as readonly string[]).not.toContain(kind);
    }
  });

  it("lets a gate carry no frame, because the record names none", () => {
    const parsed = runOutputsGet.output.safeParse(
      output({
        nodes: [node({ seq: null, kind: "gate", state: "awaiting" })],
        tally: { artifacts: 0, reads: 0, gates: 1 },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it("refuses a frame sequence that is not a decimal", () => {
    expect(
      runOutputsGet.output.safeParse(
        output({ nodes: [node({ seq: "fr 12" })] }),
      ).success,
    ).toBe(false);
  });

  it("refuses a node with no name, so nothing renders as a blank row", () => {
    expect(
      runOutputsGet.output.safeParse(output({ nodes: [node({ name: "" })] }))
        .success,
    ).toBe(false);
  });

  it("refuses a kind or a state it does not know", () => {
    expect(
      runOutputsGet.output.safeParse(
        output({ nodes: [node({ kind: "blob" })] }),
      ).success,
    ).toBe(false);
    expect(
      runOutputsGet.output.safeParse(
        output({ nodes: [node({ state: "probably-written" })] }),
      ).success,
    ).toBe(false);
  });

  it("says which store recorded the run, and nothing else", () => {
    expect(
      runOutputsGet.output.safeParse(output({ source: "ledger" })).success,
    ).toBe(true);
    expect(
      runOutputsGet.output.safeParse(output({ source: "tacho" })).success,
    ).toBe(false);
  });

  it("takes an empty spine: a run that produced nothing says so", () => {
    expect(
      runOutputsGet.output.safeParse(
        output({ nodes: [], tally: { artifacts: 0, reads: 0, gates: 0 } }),
      ).success,
    ).toBe(true);
  });
});

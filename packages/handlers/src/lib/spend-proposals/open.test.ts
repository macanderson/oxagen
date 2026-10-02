import type { SpendProposalInput } from "@oxagen/billing/proposal-opener";
import { HandlerError } from "@oxagen/oxagen";
import { describe, expect, it, vi } from "vitest";
import { createProposal } from "../../context.proposal.shared";
import type { SteeringStore } from "../../context.steering.store";
import { openSpendProposalsFor } from "./index";
import { buildSpendProposals, openProposals } from "./open";
import { repeatedInstructionProposals } from "./repeated-instructions";
import { agentLineage } from "./shared";
import { spinLoopProposals } from "./spin-loops";
import { instruction, SCOPE, spinDraft } from "./test-support";
import type { SpendProposal } from "./types";

const AGENT = "acme.core.triage";

function proposal(n: number): SpendProposal {
  return { kind: "repeated_instructions", title: null, ...instruction(n) };
}

const taken = () =>
  new HandlerError({ code: "conflict", reason: "clone_name_taken" });

function storeWith(...outcomes: (Error | null)[]) {
  const insertProposal = vi.fn();
  for (const outcome of outcomes) {
    if (outcome === null) insertProposal.mockResolvedValueOnce({});
    else insertProposal.mockRejectedValueOnce(outcome);
  }
  return { insertProposal };
}

type ProposalValues = Parameters<SteeringStore["insertProposal"]>[0];

/**
 * A store that refuses a create-only insert on a lineage that already has a
 * proposal, in any state, as the Postgres store does.
 */
function memoryStore() {
  const rows: ProposalValues[] = [];
  const store: Pick<SteeringStore, "insertProposal"> = {
    async insertProposal(values, options) {
      if (
        options?.createOnly &&
        rows.some((r) => r.lineageId === values.lineageId)
      )
        throw taken();
      rows.push(values);
      return { ...values, publicId: `prp_${rows.length}` } as never;
    },
  };
  return { rows, store };
}

describe("openProposals", () => {
  it("opens one create-only workspace rule per instruction", async () => {
    const store = storeWith(null, null);
    const result = await openProposals(SCOPE, [proposal(1), proposal(2)], {
      store,
      create: createProposal,
      audit: vi.fn(),
    });
    expect(result).toEqual({ opened: 2, taken: 0 });
    expect(store.insertProposal).toHaveBeenCalledTimes(2);
    const [values, options] = store.insertProposal.mock.calls[0]!;
    expect(options).toEqual({ createOnly: true });
    expect(values).toEqual({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      lineageId: "ctx.habits.instruction-000000000001",
      title: null,
      label: null,
      kind: "rule",
      force: "should",
      constraintEffect: null,
      sharingScope: "workspace",
      statement: "Run the unit tests before you open pull request 1.",
      rationale: "Runs received it 1 times.",
      source: "finding:repeated_instructions",
      supportRuns: ["run_a", "run_b", "run_c"],
      supportAgents: ["agent.reviewer"],
      supportingRecordIds: [],
      evidenceLinks: ["frame:run_a/1", "frame:run_b/4"],
      createdById: null,
    });
  });

  it("writes a builder's title and names its finding kind as the source", async () => {
    const store = storeWith(null);
    const [wait] = spinLoopProposals.build({
      instructions: [],
      findings: [spinDraft(AGENT)],
    });
    await openProposals(SCOPE, [wait!], {
      store,
      create: createProposal,
      audit: vi.fn(),
    });
    const [values] = store.insertProposal.mock.calls[0]!;
    expect(values).toMatchObject({
      lineageId: agentLineage("spin_loops", AGENT),
      title: `Wait rule for ${AGENT}`,
      kind: "rule",
      force: "should",
      sharingScope: "workspace",
      source: "finding:spin_loops",
      supportRuns: ["tse_a", "tse_b"],
      supportAgents: [AGENT],
      evidenceLinks: ["frame:tse_a/12"],
    });
  });

  it("gives each proposal its own request id", async () => {
    const create = vi.fn(async () => ({ publicId: "cprop_1" }) as never);
    await openProposals(SCOPE, [proposal(1), proposal(2)], {
      store: storeWith(),
      create,
      audit: vi.fn(),
    });
    const ids = create.mock.calls.map(
      (call) =>
        (call as unknown as [unknown, { requestId: string }])[1].requestId,
    );
    expect(new Set(ids).size).toBe(2);
    expect(
      (create.mock.calls[0] as unknown as [unknown, { surface: string }])[1]
        .surface,
    ).toBe("runner");
  });

  it("leaves a lineage that already has a record or a proposal alone", async () => {
    const store = storeWith(taken(), null);
    const result = await openProposals(SCOPE, [proposal(1), proposal(2)], {
      store,
      create: createProposal,
      audit: vi.fn(),
    });
    expect(result).toEqual({ opened: 1, taken: 1 });
  });

  it("tries every proposal, then throws the first other failure", async () => {
    const store = storeWith(
      new Error("database unavailable"),
      null,
      new Error("second failure"),
    );
    await expect(
      openProposals(SCOPE, [proposal(1), proposal(2), proposal(3)], {
        store,
        create: createProposal,
        audit: vi.fn(),
      }),
    ).rejects.toThrow("database unavailable");
    expect(store.insertProposal).toHaveBeenCalledTimes(3);
  });

  it("treats a conflict with another reason as a failure", async () => {
    const store = storeWith(
      new HandlerError({ code: "conflict", reason: "stale_head" }),
    );
    await expect(
      openProposals(SCOPE, [proposal(1)], {
        store,
        create: createProposal,
        audit: vi.fn(),
      }),
    ).rejects.toMatchObject({ reason: "stale_head" });
  });

  it("opens nothing for an empty list", async () => {
    const store = storeWith();
    await expect(
      openProposals(SCOPE, [], {
        store,
        create: createProposal,
        audit: vi.fn(),
      }),
    ).resolves.toEqual({ opened: 0, taken: 0 });
    expect(store.insertProposal).not.toHaveBeenCalled();
  });

  it("audits each proposal it opens as the findings job", async () => {
    const insertProposal = vi
      .fn()
      .mockResolvedValueOnce({ publicId: "cprop_1" });
    const audit = vi.fn();
    await openProposals(SCOPE, [proposal(1)], {
      store: { insertProposal },
      create: createProposal,
      audit,
    });
    expect(audit).toHaveBeenCalledTimes(1);
    const event = audit.mock.calls[0]![0];
    expect(event).toMatchObject({
      eventType: "capability.invoke_allowed",
      actorUserId: null,
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      capability: "propose_record",
      outcome: "allow",
      detail: {
        actor: "findings_job",
        source: "finding:repeated_instructions",
        lineageId: "ctx.habits.instruction-000000000001",
        proposalId: "cprop_1",
      },
    });
    const values = insertProposal.mock.calls[0]![0];
    expect(values.createdById).toBeNull();
  });

  it("audits a failed write and leaves a taken lineage unaudited", async () => {
    const store = storeWith(taken(), new Error("database unavailable"));
    const audit = vi.fn();
    await expect(
      openProposals(SCOPE, [proposal(1), proposal(2)], {
        store,
        create: createProposal,
        audit,
      }),
    ).rejects.toThrow("database unavailable");
    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit.mock.calls[0]![0]).toMatchObject({
      eventType: "capability.invoke_error",
      outcome: "error",
      detail: {
        lineageId: "ctx.habits.instruction-000000000002",
        proposalId: null,
      },
    });
  });
});

describe("buildSpendProposals", () => {
  it("runs each builder in order", () => {
    const proposals = buildSpendProposals(
      { instructions: [instruction(1)], findings: [spinDraft(AGENT)] },
      [repeatedInstructionProposals, spinLoopProposals],
    );
    expect(proposals.map((p) => p.kind)).toEqual([
      "repeated_instructions",
      "spin_loops",
    ]);
  });
});

describe("openSpendProposalsFor", () => {
  function open(
    store: Pick<SteeringStore, "insertProposal">,
    input: SpendProposalInput,
  ) {
    return openSpendProposalsFor(SCOPE, input, {
      store,
      create: createProposal,
      audit: vi.fn(),
    });
  }

  it("opens one proposal for a repeated instruction", async () => {
    const { rows, store } = memoryStore();
    await expect(
      open(store, { instructions: [instruction(1)], findings: [] }),
    ).resolves.toEqual({ opened: 1, taken: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lineageId: "ctx.habits.instruction-000000000001",
      source: "finding:repeated_instructions",
    });
  });

  it("opens one wait proposal for an agent with spin loop findings", async () => {
    // A digest_only workspace has no instruction proposals. Its spin loop
    // findings still open one.
    const { rows, store } = memoryStore();
    await expect(
      open(store, { instructions: [], findings: [spinDraft(AGENT)] }),
    ).resolves.toEqual({ opened: 1, taken: 0 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      lineageId: agentLineage("spin_loops", AGENT),
      source: "finding:spin_loops",
      supportRuns: ["tse_a", "tse_b"],
      supportAgents: [AGENT],
    });
    expect(rows[0]!.statement).toContain("instead of polling in a shell loop");
  });

  it("opens no duplicate on a second detector run", async () => {
    const { rows, store } = memoryStore();
    const first: SpendProposalInput = {
      instructions: [instruction(1)],
      findings: [spinDraft(AGENT)],
    };
    // The next night's pass cites one more run for the same agent.
    const second: SpendProposalInput = {
      instructions: [instruction(1)],
      findings: [spinDraft(AGENT, { citedRuns: ["tse_a", "tse_b", "tse_c"] })],
    };
    await expect(open(store, first)).resolves.toEqual({
      opened: 2,
      taken: 0,
    });
    await expect(open(store, second)).resolves.toEqual({
      opened: 0,
      taken: 2,
    });
    expect(rows).toHaveLength(2);
  });

  it("opens a proposal for a second agent beside the first one's", async () => {
    const { rows, store } = memoryStore();
    await open(store, { instructions: [], findings: [spinDraft(AGENT)] });
    await expect(
      open(store, {
        instructions: [],
        findings: [spinDraft(AGENT), spinDraft("acme.core.review")],
      }),
    ).resolves.toEqual({ opened: 1, taken: 1 });
    expect(rows.map((r) => r.supportAgents)).toEqual([
      [AGENT],
      ["acme.core.review"],
    ]);
  });
});

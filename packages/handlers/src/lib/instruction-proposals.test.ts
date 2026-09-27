import type { InstructionProposal } from "@oxagen/billing/proposal-opener";
import { HandlerError } from "@oxagen/oxagen";
import { describe, expect, it, vi } from "vitest";
import { createProposal } from "../context.proposal.shared";
import {
  INSTRUCTION_PROPOSAL_SOURCE,
  openInstructionProposalsFor,
} from "./instruction-proposals";

const scope = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

function proposal(n: number): InstructionProposal {
  return {
    lineageId: `ctx.habits.instruction-00000000000${n}`,
    statement: `Run the unit tests before you open pull request ${n}.`,
    rationale: `Runs received it ${n} times.`,
    runs: ["run_a", "run_b", "run_c"],
    agents: ["agent.reviewer"],
    evidenceLinks: ["frame:run_a/1", "frame:run_b/4"],
  };
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

describe("openInstructionProposalsFor", () => {
  it("opens one create-only workspace rule per instruction", async () => {
    const store = storeWith(null, null);
    const result = await openInstructionProposalsFor(
      scope,
      [proposal(1), proposal(2)],
      { store, create: createProposal },
    );
    expect(result).toEqual({ opened: 2, taken: 0 });
    expect(store.insertProposal).toHaveBeenCalledTimes(2);
    const [values, options] = store.insertProposal.mock.calls[0]!;
    expect(options).toEqual({ createOnly: true });
    expect(values).toEqual({
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      lineageId: "ctx.habits.instruction-000000000001",
      title: null,
      label: null,
      kind: "rule",
      force: "should",
      constraintEffect: null,
      sharingScope: "workspace",
      statement: "Run the unit tests before you open pull request 1.",
      rationale: "Runs received it 1 times.",
      source: INSTRUCTION_PROPOSAL_SOURCE,
      supportRuns: ["run_a", "run_b", "run_c"],
      supportAgents: ["agent.reviewer"],
      supportingRecordIds: [],
      evidenceLinks: ["frame:run_a/1", "frame:run_b/4"],
      createdById: null,
    });
  });

  it("gives each proposal its own request id", async () => {
    const create = vi.fn(async () => ({}) as never);
    await openInstructionProposalsFor(scope, [proposal(1), proposal(2)], {
      store: storeWith(),
      create,
    });
    const ids = create.mock.calls.map(
      (call) => (call as unknown as [unknown, { requestId: string }])[1].requestId,
    );
    expect(new Set(ids).size).toBe(2);
    expect(
      (create.mock.calls[0] as unknown as [unknown, { surface: string }])[1]
        .surface,
    ).toBe("runner");
  });

  it("leaves a lineage that already has a record or a proposal alone", async () => {
    const store = storeWith(taken(), null);
    const result = await openInstructionProposalsFor(
      scope,
      [proposal(1), proposal(2)],
      { store, create: createProposal },
    );
    expect(result).toEqual({ opened: 1, taken: 1 });
  });

  it("tries every proposal, then throws the first other failure", async () => {
    const store = storeWith(
      new Error("database unavailable"),
      null,
      new Error("second failure"),
    );
    await expect(
      openInstructionProposalsFor(
        scope,
        [proposal(1), proposal(2), proposal(3)],
        { store, create: createProposal },
      ),
    ).rejects.toThrow("database unavailable");
    expect(store.insertProposal).toHaveBeenCalledTimes(3);
  });

  it("treats a conflict with another reason as a failure", async () => {
    const store = storeWith(
      new HandlerError({ code: "conflict", reason: "stale_head" }),
    );
    await expect(
      openInstructionProposalsFor(scope, [proposal(1)], {
        store,
        create: createProposal,
      }),
    ).rejects.toMatchObject({ reason: "stale_head" });
  });

  it("opens nothing for an empty list", async () => {
    const store = storeWith();
    await expect(
      openInstructionProposalsFor(scope, [], { store, create: createProposal }),
    ).resolves.toEqual({ opened: 0, taken: 0 });
    expect(store.insertProposal).not.toHaveBeenCalled();
  });
});

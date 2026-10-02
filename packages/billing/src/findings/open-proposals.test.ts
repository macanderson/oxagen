import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { warn, error } = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../logger", () => ({ logger: { warn, error, info: vi.fn() } }));

import { openSpendProposals } from "./open-proposals";
import {
  setSpendProposalOpener,
  type InstructionProposal,
  type SpendProposalInput,
} from "./proposal-opener";
import type { FindingDraft } from "./shared";

const SCOPE = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
};

const instruction: InstructionProposal = {
  lineageId: "ctx.habits.instruction-0123456789ab",
  statement: "Run the unit tests before you open a pull request.",
  rationale: "Runs received it 3 times.",
  runs: ["tse_a", "tse_b", "tse_c"],
  agents: [],
  evidenceLinks: [],
};

/** Only the fields the opener reads; the handlers' builders read the rest. */
const spinLoop = {
  kind: "spin_loops",
  level: "agent",
  subject: "acme.core.triage",
} as FindingDraft;

const EMPTY: SpendProposalInput = { instructions: [], findings: [] };

beforeEach(() => {
  warn.mockReset();
  error.mockReset();
});

afterEach(() => setSpendProposalOpener(null));

describe("openSpendProposals", () => {
  it("calls nothing for a pass with no instructions and no findings", async () => {
    const opener = vi.fn();
    setSpendProposalOpener(opener);
    await openSpendProposals(SCOPE, EMPTY);
    expect(opener).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it("hands findings to the opener when the pass found no instruction", async () => {
    // A digest_only workspace stores no prompt text, so it has no
    // instruction proposals. Its findings still support proposals.
    const opener = vi.fn(async () => undefined);
    setSpendProposalOpener(opener);
    const input = { instructions: [], findings: [spinLoop] };
    await openSpendProposals(SCOPE, input);
    expect(opener).toHaveBeenCalledWith(SCOPE, input);
  });

  it("hands the instructions and findings to the installed opener", async () => {
    const opener = vi.fn(async () => undefined);
    setSpendProposalOpener(opener);
    const input = { instructions: [instruction], findings: [spinLoop] };
    await openSpendProposals(SCOPE, input);
    expect(opener).toHaveBeenCalledWith(SCOPE, input);
    expect(error).not.toHaveBeenCalled();
  });

  it("logs when no opener is installed", async () => {
    await openSpendProposals(SCOPE, {
      instructions: [instruction],
      findings: [],
    });
    expect(warn).toHaveBeenCalledWith(
      { ...SCOPE, instructions: 1, findings: 0 },
      expect.stringContaining("no steering record proposal opener"),
    );
  });

  it("logs a failed open and resolves, so the pass keeps its findings", async () => {
    const err = new Error("database unavailable");
    setSpendProposalOpener(async () => {
      throw err;
    });
    await expect(
      openSpendProposals(SCOPE, { instructions: [], findings: [spinLoop] }),
    ).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(
      { ...SCOPE, instructions: 0, findings: 1, err },
      expect.stringContaining("failed"),
    );
  });
});

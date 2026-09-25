/**
 * The in-app assistant's steering: published records and the workspace's
 * instructions, assembled by the one assembler, with a manifest of what was
 * kept and cut (ADR-093 §7, #4158).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestJcs } from "@oxagen/run-evidence";
import {
  assembleSteering,
  PREFIX_BUDGET_TOKENS,
  type SteeringCandidate,
} from "@oxagen/steering-assembler";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
  readPublished: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  // The org-wide seam is mocked as the SAME function as the tenant
  // seam (ADR-086): a handler's role gate reads through withOrgDb, and
  // a suite that counts seam calls must see one identity, not two.
  const dbMock = {
    ...(await importOriginal<typeof import("@oxagen/database")>()),
    withTenantDb: mocks.withTenantDb,
  };
  return { ...dbMock, withOrgDb: dbMock.withTenantDb };
});
vi.mock("./published-steering", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./published-steering")>()),
  readPublishedSteeringCandidates: mocks.readPublished,
}));

import {
  ASSISTANT_STEERING_BUDGET_TOKENS,
  ASSISTANT_STEERING_HEADER,
  assembleAssistantSteering,
  assistantSystemPrompt,
  instructionCandidate,
  loadAssistantSteering,
  WORKSPACE_INSTRUCTIONS_ID,
  WORKSPACE_INSTRUCTIONS_MAX_CHARS,
} from "./assistant-steering";

const INSTRUCTIONS = "Answer in British English and cite the run id.";

/** The assembler's token unit: `ceil(utf8_bytes / 4)`. */
const budgetTokens = (text: string): number =>
  Math.ceil(Buffer.byteLength(text, "utf8") / 4);

/** A published record as `recordCandidate` renders one. */
function record(overrides: Partial<SteeringCandidate>): SteeringCandidate {
  return {
    id: "ask-before-deleting",
    kind: "record",
    force: "must",
    body: "Ask before deleting data. (rule; ask-before-deleting)",
    recordedAt: "2026-09-10T00:00:00.000Z",
    ...overrides,
  };
}

const assemble = (
  records: SteeringCandidate[],
  instructions: string | null = INSTRUCTIONS,
  budgetTokens?: number,
) =>
  assembleAssistantSteering({
    orgId: "org-1",
    workspaceId: "ws-1",
    records,
    promptConfig: { additionalInstructions: instructions },
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
  });

const outcomeOf = (
  steering: ReturnType<typeof assemble>,
  id: string,
): { outcome: string; reason?: string } | undefined =>
  steering.manifest.items.find((item) => item.id === id);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.withTenantDb.mockImplementation((fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({})),
  );
  mocks.readPublished.mockResolvedValue([]);
});

describe("instructionCandidate", () => {
  it("is one SHOULD item of kind instruction, ranked as the oldest", () => {
    expect(
      instructionCandidate({ additionalInstructions: `  ${INSTRUCTIONS}\n` }),
    ).toEqual({
      id: WORKSPACE_INSTRUCTIONS_ID,
      kind: "instruction",
      force: "should",
      body: `Workspace instructions: ${INSTRUCTIONS}`,
      recordedAt: "",
    });
  });

  it("is null when the workspace configured none (negative)", () => {
    expect(instructionCandidate(null)).toBeNull();
    expect(instructionCandidate({})).toBeNull();
    expect(instructionCandidate({ additionalInstructions: "  " })).toBeNull();
  });
});

describe("assembleAssistantSteering", () => {
  it("carries a published record and the instructions, and names both as included", () => {
    const steering = assemble([record({})]);
    const text = steering.text!;
    expect(text.split("\n")[0]).toBe(ASSISTANT_STEERING_HEADER);
    expect(text).toContain(
      "- Ask before deleting data. (rule; ask-before-deleting)",
    );
    expect(text).toContain(`- Workspace instructions: ${INSTRUCTIONS}`);
    // The published MUST record is listed before the instructions, which
    // carry SHOULD, so "follow the one listed first" settles a conflict.
    expect(text.indexOf("Ask before deleting")).toBeLessThan(
      text.indexOf("Workspace instructions"),
    );
    expect(steering.manifest).toMatchObject({
      schema: "oxagen.steering.manifest/1",
      delivers: ["must", "should"],
      budget_tokens: ASSISTANT_STEERING_BUDGET_TOKENS,
      spent_tokens: budgetTokens(text),
      included: 2,
      cut: 0,
    });
    expect(steering.manifest.items.map((i) => [i.id, i.kind])).toEqual([
      ["ask-before-deleting", "record"],
      [WORKSPACE_INSTRUCTIONS_ID, "instruction"],
    ]);
    expect(steering.instructionsDigest).toBe(digestJcs(INSTRUCTIONS));
    expect(steering.unavailableKinds).toEqual([]);
  });

  it("names an over-budget record in the manifest as cut, and keeps what fits", () => {
    const long = record({
      id: "long-record",
      body: `${"Explain every step at length. ".repeat(40)}(rule; long-record)`,
      recordedAt: "2026-09-12T00:00:00.000Z",
    });
    const steering = assemble([long, record({})], INSTRUCTIONS, 200);
    expect(outcomeOf(steering, "long-record")).toMatchObject({
      outcome: "cut",
      reason: "budget",
    });
    expect(outcomeOf(steering, "ask-before-deleting")).toMatchObject({
      outcome: "included",
    });
    expect(steering.text).not.toContain("Explain every step");
    expect(steering.text).toContain(
      "1 more record was left out because the steering text reached its size limit.",
    );
    expect(steering.manifest.cut).toBe(1);
  });

  it("cuts instructions past the budget and still carries the records (negative)", () => {
    const oversized = "x".repeat(ASSISTANT_STEERING_BUDGET_TOKENS * 4);
    const steering = assemble([record({})], oversized);
    expect(outcomeOf(steering, WORKSPACE_INSTRUCTIONS_ID)).toMatchObject({
      outcome: "cut",
      reason: "budget",
    });
    expect(steering.text).toContain("Ask before deleting data.");
    expect(steering.text).not.toContain("xxxx");
    // The record still names the text it cut, by digest.
    expect(steering.instructionsDigest).toBe(digestJcs(oversized));
  });

  it("lists a published SHOULD record before the instructions, and cuts MAY and INFO for their tier", () => {
    const steering = assemble([
      record({
        id: "prefer-small",
        force: "should",
        body: "Prefer small PRs.",
      }),
      record({ id: "maybe", force: "may", body: "Maybe M." }),
      record({ id: "note", force: "info", body: "Note N." }),
    ]);
    expect(steering.manifest.items.map((i) => i.id)).toEqual([
      "prefer-small",
      WORKSPACE_INSTRUCTIONS_ID,
      "maybe",
      "note",
    ]);
    expect(outcomeOf(steering, "maybe")).toMatchObject({ reason: "tier" });
    expect(outcomeOf(steering, "note")).toMatchObject({ reason: "tier" });
    expect(steering.text).not.toContain("Maybe M.");
  });

  it("holds a full wrapped-agent prefix beside the longest instructions the write path accepts", () => {
    // The records a wrapped agent's prefix includes at its own budget.
    const many = Array.from({ length: 120 }, (_, i) =>
      record({
        id: `record-${String(i).padStart(3, "0")}`,
        body: `Keep invariant number ${i} whenever you touch its module. (rule; record-${i})`,
        recordedAt: `2026-09-${String((i % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      }),
    );
    const prefix = assembleSteering(
      { orgId: "org-1", workspaceId: "ws-1", candidates: many },
      PREFIX_BUDGET_TOKENS,
    );
    expect(prefix.manifest.cut).toBeGreaterThan(0);
    const included = new Set(
      prefix.manifest.items
        .filter((i) => i.outcome === "included")
        .map((i) => i.id),
    );
    const fitted = many.filter((c) => included.has(c.id));

    const steering = assemble(
      fitted,
      "y".repeat(WORKSPACE_INSTRUCTIONS_MAX_CHARS),
    );
    expect(steering.manifest.cut).toBe(0);
    expect(steering.manifest.included).toBe(fitted.length + 1);
    expect(steering.manifest.spent_tokens).toBeLessThanOrEqual(
      ASSISTANT_STEERING_BUDGET_TOKENS,
    );
  });

  it("answers null text, an empty manifest and no digest when nothing steers (negative)", () => {
    const steering = assemble([], null);
    expect(steering.text).toBeNull();
    expect(steering.manifest).toMatchObject({
      included: 0,
      cut: 0,
      text_digest: null,
      items: [],
    });
    expect(steering.instructionsDigest).toBeNull();
  });
});

describe("loadAssistantSteering", () => {
  const load = () =>
    loadAssistantSteering({
      orgId: "org-1",
      workspaceId: "ws-1",
      promptConfig: { additionalInstructions: INSTRUCTIONS },
      requestId: "req-1",
    });

  it("reads the published records in the turn's tenant scope and assembles them", async () => {
    mocks.readPublished.mockResolvedValueOnce([record({})]);
    const steering = await load();
    expect(mocks.withTenantDb).toHaveBeenCalledTimes(1);
    expect(mocks.readPublished).toHaveBeenCalledWith({}, "org-1", "ws-1");
    expect(steering.text).toContain("Ask before deleting data.");
    expect(steering.text).toContain(INSTRUCTIONS);
    expect(steering.unavailableKinds).toEqual([]);
  });

  it("runs on the instructions alone when the registry does not answer, and says so", async () => {
    mocks.readPublished.mockRejectedValueOnce(new Error("registry is down"));
    const steering = await load();
    expect(steering.unavailableKinds).toEqual(["record"]);
    expect(steering.text).toContain(INSTRUCTIONS);
    expect(steering.manifest.items.map((i) => i.id)).toEqual([
      WORKSPACE_INSTRUCTIONS_ID,
    ]);
  });

  it("assembles over-budget steering without refusing the turn", async () => {
    mocks.readPublished.mockResolvedValueOnce([record({})]);
    const steering = await loadAssistantSteering({
      orgId: "org-1",
      workspaceId: "ws-1",
      promptConfig: {
        additionalInstructions: "z".repeat(
          ASSISTANT_STEERING_BUDGET_TOKENS * 4,
        ),
      },
    });
    expect(outcomeOf(steering, WORKSPACE_INSTRUCTIONS_ID)).toMatchObject({
      reason: "budget",
    });
    expect(steering.text).toContain("Ask before deleting data.");
  });
});

describe("assistantSystemPrompt", () => {
  it("is the baseline alone, byte for byte, when nothing was included", () => {
    expect(assistantSystemPrompt("GOVERNANCE", { text: null })).toBe(
      "GOVERNANCE",
    );
  });

  it("puts the steering after the baseline under its own heading", () => {
    expect(assistantSystemPrompt("GOVERNANCE", { text: "STEERING" })).toBe(
      "GOVERNANCE\n\n---\n\n## Workspace steering\n\nSTEERING",
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CREDIT_REASONS } from "@oxagen/billing";
import type { CapabilityContext } from "@oxagen/oxagen";

const ai = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  selectModelForOrg: vi.fn(),
}));
vi.mock("@oxagen/ai", () => ai);

import {
  effectOf,
  settleStatements,
  splitDocument,
  splitPrompt,
  splitSchema,
  splitWithModel,
  SPLIT_SYSTEM,
  type SplitModel,
  type SplitOutput,
} from "./split";

const ctx = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  surface: "api",
  messageId: null,
  requestId: "00000000-0000-4000-8000-000000000003",
} as unknown as CapabilityContext;

const CLAUDE_MD = [
  "# Rules",
  "",
  "Never push to main.",
  "Prefer rg over grep.",
  "CI runs on every push.",
  "",
  "1. Tag the release.",
  "2. Publish the notes.",
].join("\n");

type Proposed = SplitOutput["statements"][number];

function proposed(over: Partial<Proposed>): Proposed {
  return {
    statement: "Never push to main.",
    label: "No push to main",
    line: 3,
    kind: "constraint",
    kindReason: "It forbids an action.",
    force: "must",
    forceWords: "Never",
    effect: "forbid",
    ...over,
  };
}

beforeEach(() => {
  ai.generateObjectFor.mockReset();
  ai.selectModelForOrg.mockReset();
});

describe("settleStatements", () => {
  it("keeps a force the kind allows when the file holds the words behind it", () => {
    const [s] = settleStatements({ statements: [proposed({})] }, CLAUDE_MD);
    expect(s).toMatchObject({ kind: "constraint", force: "must", forceWords: "Never", effect: "forbid" });
  });

  it("moves a force the kind forbids to the kind's default (negative)", () => {
    const settled = settleStatements(
      {
        statements: [
          proposed({ statement: "Prefer rg over grep.", kind: "preference", force: "must", forceWords: "Prefer", effect: null }),
          proposed({ statement: "CI runs on every push.", kind: "fact", force: "should", forceWords: "runs", effect: null }),
          proposed({ statement: "Agents learned the cache key.", kind: "memory", force: "must", forceWords: "", effect: null }),
        ],
      },
      CLAUDE_MD,
    );
    expect(settled.map((s) => [s.kind, s.force, s.forceWords])).toEqual([
      ["preference", "may", ""],
      ["fact", "info", ""],
      ["memory", "info", ""],
    ]);
  });

  it("uses the kind's default when no words justify the force", () => {
    const settled = settleStatements(
      {
        statements: [
          proposed({ statement: "Tag the release.", kind: "procedure", force: "must", forceWords: "", effect: null }),
          proposed({ statement: "Publish the notes.", kind: "business-rule", force: "must", forceWords: "absolutely", effect: null }),
        ],
      },
      CLAUDE_MD,
    );
    // "absolutely" is not in the file, so it justifies nothing.
    expect(settled.map((s) => [s.force, s.forceWords])).toEqual([
      ["should", ""],
      ["should", ""],
    ]);
  });

  it("gives every constraint an effect, and every other kind none", () => {
    const settled = settleStatements(
      {
        statements: [
          proposed({ statement: "Do not deploy on Fridays.", effect: null }),
          proposed({ statement: "Run the tests before a merge.", effect: null }),
          proposed({ statement: "Prefer rg over grep.", kind: "preference", force: "may", forceWords: "Prefer", effect: "forbid" }),
        ],
      },
      `${CLAUDE_MD}\nDo not deploy on Fridays.\nRun the tests before a merge.`,
    );
    expect(settled.map((s) => s.effect)).toEqual(["forbid", "require", null]);
  });

  it("keeps lines inside the file and trims each field", () => {
    const [low, high] = settleStatements(
      {
        statements: [
          proposed({ line: 1, statement: "  Never push to main.  ", label: " No push " }),
          proposed({ line: 999 }),
        ],
      },
      CLAUDE_MD,
    );
    expect(low).toMatchObject({ line: 1, statement: "Never push to main.", label: "No push" });
    expect(high?.line).toBe(CLAUDE_MD.split("\n").length);
  });

  it("drops a blank statement (negative)", () => {
    expect(settleStatements({ statements: [proposed({ statement: "   " }), proposed({})] }, CLAUDE_MD)).toHaveLength(1);
  });

  it("returns at most 50 statements", () => {
    const many = Array.from({ length: 60 }, (_, i) =>
      proposed({ statement: `Never push branch ${i}.` }),
    );
    // The schema caps the model at 50, and settle caps what it is handed too.
    expect(splitSchema.safeParse({ statements: many }).success).toBe(false);
    expect(settleStatements({ statements: many }, CLAUDE_MD)).toHaveLength(50);
  });
});

describe("effectOf", () => {
  it("reads a prohibition as forbid and anything else as require", () => {
    expect(effectOf("Never force-push a shared branch.")).toBe("forbid");
    expect(effectOf("You must not skip review.")).toBe("forbid");
    expect(effectOf("Avoid long-lived branches.")).toBe("forbid");
    expect(effectOf("Every change has a ticket.")).toBe("require");
  });
});

describe("splitPrompt and the system prompt", () => {
  it("numbers each line so the model can name the source line", () => {
    expect(splitPrompt("CLAUDE.md", "a\nb")).toBe("Filename: CLAUDE.md\n\n1| a\n2| b");
  });

  it("names the eight kinds and the force defaults", () => {
    for (const kind of [
      "business-rule",
      "code-rule",
      "constraint",
      "procedure",
      "skill",
      "fact",
      "preference",
      "memory",
    ]) {
      expect(SPLIT_SYSTEM).toContain(`- ${kind}:`);
    }
    expect(SPLIT_SYSTEM).toContain("Split compound guidance into separate statements.");
    expect(SPLIT_SYSTEM).toContain("may for a preference, and info for a fact or a memory");
  });
});

describe("splitDocument", () => {
  it("makes one model call per file and settles what it answers", async () => {
    const model = vi.fn<SplitModel>().mockResolvedValue({
      statements: [
        proposed({}),
        proposed({ statement: "Prefer rg over grep.", line: 4, kind: "preference", force: "should", forceWords: "Prefer", effect: null }),
      ],
    });
    const settled = await splitDocument({ filename: "CLAUDE.md", content: CLAUDE_MD, ctx, model });
    expect(model).toHaveBeenCalledTimes(1);
    expect(model).toHaveBeenCalledWith({ filename: "CLAUDE.md", content: CLAUDE_MD, ctx });
    expect(settled.map((s) => [s.kind, s.force])).toEqual([
      ["constraint", "must"],
      ["preference", "may"],
    ]);
  });

  it("passes a model failure to the caller", async () => {
    const model = vi.fn<SplitModel>().mockRejectedValue(new Error("gateway down"));
    await expect(
      splitDocument({ filename: "CLAUDE.md", content: CLAUDE_MD, ctx, model }),
    ).rejects.toThrow("gateway down");
  });
});

describe("splitWithModel", () => {
  it("runs on the balanced tier, on the organization's funding, billed as assistant tokens", async () => {
    const model = { modelId: "anthropic/claude-sonnet-5" };
    ai.selectModelForOrg.mockResolvedValue({ model, fundedBy: "organization" });
    ai.generateObjectFor.mockResolvedValue({ object: { statements: [] }, usage: {} });

    await expect(splitWithModel({ filename: "CLAUDE.md", content: "a", ctx })).resolves.toEqual({
      statements: [],
    });

    expect(ai.selectModelForOrg).toHaveBeenCalledWith(ctx.orgId, { tier: "balanced" });
    const args = ai.generateObjectFor.mock.calls[0]?.[0];
    expect(args).toMatchObject({
      model,
      fundedBy: "organization",
      chargeReason: CREDIT_REASONS.CONSUME_ASSISTANT_TOKENS,
      system: SPLIT_SYSTEM,
      prompt: "Filename: CLAUDE.md\n\n1| a",
      telemetry: { orgId: ctx.orgId, workspaceId: ctx.workspaceId, messageId: ctx.requestId },
    });
    expect(args.maxOutputTokens).toBeGreaterThan(0);
  });
});

import { describe, expect, it, vi, beforeEach } from "vitest";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The revise handler: reads the active version body via one withTenantDb call
// (two selects — skill row, then version row), synthesises a new body, pins the
// immutable slug, and persists via the shared createNewSkillVersion helper (which
// we mock so this test targets the revise logic, not the version-bump plumbing).
const mocks = vi.hoisted(() => ({
  generateObjectFor: vi.fn(),
  createNewSkillVersion: vi.fn(),
  dbRows: [] as unknown[][],
}));

vi.mock("@oxagen/ai", () => ({
  generateObjectFor: mocks.generateObjectFor,
}));

vi.mock("./skill-version-create", () => ({
  createNewSkillVersion: mocks.createNewSkillVersion,
}));

// Spread the real module (keeps `schema` + every other export real for sibling
// importers) and override only withTenantDb with a chainable tx that returns the
// queued rows in order across the handler's two selects.
vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  type Chain = {
    from: () => Chain;
    where: () => Chain;
    orderBy: () => Chain;
    limit: () => Promise<unknown[]>;
  };
  return {
    ...real,
    withTenantDb: async (
      fn: (tx: { select: () => Chain }) => Promise<unknown>,
    ) => {
      let i = 0;
      const chain: Chain = {
        from: () => chain,
        where: () => chain,
        orderBy: () => chain,
        limit: () => Promise.resolve(mocks.dbRows[i++] ?? []),
      };
      return fn({ select: () => chain });
    },
  };
});

import { skillReviseHandler, SkillReviseError } from "./skill.revise";
import { TEST_CTX } from "./test-utils/fixtures";

// ── fixtures ──────────────────────────────────────────────────────────────────

const CURRENT_CONTENT = `schema_version = 1
kind = "skill"
name = "incident-response"
description = "How to respond to a production incident."
instructions = "Acknowledge the page, assess blast radius, mitigate, then write a postmortem."
references = []

[metadata]
weight = "high"
category = "engineering"
`;

const SKILL_ROW = {
  id: "uuid-skill-1",
  slug: "incident-response",
  activeVersionId: "uuid-ver-1",
};
const VERSION_ROW = { body: CURRENT_CONTENT };

// The model renames the skill (name: renamed) on purpose — the handler must pin
// the slug back to the current one.
const SYNTHESIS_RESULT = {
  displayName: "Incident Response",
  name: "renamed-by-model",
  description:
    "How to respond to and recover from a production incident, with rollback.",
  weight: "critical" as const,
  category: "engineering",
  body: "# Incident Response\n\nLoad during an incident.\n\n## Steps\n\n1. Acknowledge.\n2. Assess.\n3. Mitigate.\n4. Roll back.\n5. Postmortem.",
  changeSummary: ["Tightened steps to five bullets", "Added a rollback step"],
};

const CREATE_RESULT = {
  versionId: "slv_002",
  versionNumber: 2,
  skillId: "skl_INC01",
  activated: true,
};

const INPUT = {
  skill_id: "skl_INC01",
  prompt: "Tighten the steps to five bullets and add a rollback step",
  activate: true,
  workspace_id: undefined as string | undefined,
};

function setupHappyPath() {
  mocks.dbRows = [[SKILL_ROW], [VERSION_ROW]];
  mocks.generateObjectFor.mockResolvedValue({ object: SYNTHESIS_RESULT });
  mocks.createNewSkillVersion.mockResolvedValue(CREATE_RESULT);
}

describe("skillReviseHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.dbRows = [];
  });

  it("persists a new bumped version and returns the change summary", async () => {
    setupHappyPath();

    const out = await skillReviseHandler(INPUT, TEST_CTX);

    expect(out.skill_id).toBe("skl_INC01");
    expect(out.version_id).toBe("slv_002");
    expect(out.version_number).toBe(2);
    expect(out.activated).toBe(true);
    expect(out.changeSummary).toEqual([
      "Tightened steps to five bullets",
      "Added a rollback step",
    ]);
    expect(out.content).toContain("Roll back");
  });

  it("pins the immutable slug — the model's rename is ignored in the saved body", async () => {
    setupHappyPath();

    await skillReviseHandler(INPUT, TEST_CTX);

    const call = mocks.createNewSkillVersion.mock.calls[0]![0] as {
      skillPublicId: string;
      content: string;
      activate: boolean;
    };
    expect(call.skillPublicId).toBe("skl_INC01");
    expect(call.content).toContain('name = "incident-response"');
    expect(call.content).not.toContain('name = "renamed-by-model"');
    expect(call.activate).toBe(true);
  });

  it("forwards activate:false to stage a version without going live", async () => {
    setupHappyPath();

    await skillReviseHandler({ ...INPUT, activate: false }, TEST_CTX);

    const call = mocks.createNewSkillVersion.mock.calls[0]![0] as {
      activate: boolean;
    };
    expect(call.activate).toBe(false);
  });

  it("throws SkillReviseError when the skill is not found", async () => {
    mocks.dbRows = [[]]; // skill lookup returns nothing
    mocks.generateObjectFor.mockResolvedValue({ object: SYNTHESIS_RESULT });

    await expect(skillReviseHandler(INPUT, TEST_CTX)).rejects.toBeInstanceOf(
      SkillReviseError,
    );
    expect(mocks.generateObjectFor).not.toHaveBeenCalled();
    expect(mocks.createNewSkillVersion).not.toHaveBeenCalled();
  });

  it("wraps a model synthesis failure and never persists", async () => {
    mocks.dbRows = [[SKILL_ROW], [VERSION_ROW]];
    mocks.generateObjectFor.mockRejectedValue(new Error("gateway down"));

    await expect(skillReviseHandler(INPUT, TEST_CTX)).rejects.toBeInstanceOf(
      SkillReviseError,
    );
    expect(mocks.createNewSkillVersion).not.toHaveBeenCalled();
  });
});

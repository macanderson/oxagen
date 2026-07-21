import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SkillLoadRow } from "@oxagen/telemetry";

// Mock withTenantDb as a queue-based stub so successive calls return
// different query results without complex chain-counting. The stub also
// supports the .update().set().where() chain used by the usage-count bump.
const mocks = vi.hoisted(() => ({
  dbCallResults: [] as unknown[],
  recordSkillLoad: vi.fn<(row: unknown) => Promise<void>>(async () => {}),
  emitAudit: vi.fn(async () => {}),
}));

vi.mock("@oxagen/iam", () => ({
  emitAudit: mocks.emitAudit,
}));

vi.mock("@oxagen/telemetry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/telemetry")>();
  return {
    ...real,
    recordSkillLoad: mocks.recordSkillLoad,
  };
});

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const nextResult = mocks.dbCallResults.shift();
      return fn({
        select: () => ({
          from: () => ({
            where: () => ({
              limit: async () => nextResult,
              orderBy: async () => nextResult,
            }),
            orderBy: async () => nextResult,
          }),
        }),
        update: () => ({
          set: () => ({
            where: async () => nextResult,
          }),
        }),
      });
    },
  };
});

import { agentSkillLoadHandler } from "./agent.skill.load";

import { TEST_CTX as CTX } from "../test-utils/fixtures";

function enqueue(...results: unknown[]) {
  mocks.dbCallResults.push(...results);
}

describe("agent.skill.load handler", () => {
  beforeEach(() => {
    mocks.dbCallResults = [];
    mocks.recordSkillLoad.mockClear();
  });

  it("returns loaded=false when skill not found", async () => {
    enqueue([]); // skill query returns nothing
    const result = await agentSkillLoadHandler({ skillSlug: "missing" }, CTX);
    expect(result.loaded).toBe(false);
    expect(result.dependencyErrors).toHaveLength(1);
    expect(result.dependencyErrors[0]!.slug).toBe("missing");
  });

  it("returns loaded=false when no version matches constraint", async () => {
    enqueue([{ id: "skl_1", activeVersionId: null }]); // skill found
    enqueue([{ id: "slv_1", versionNumber: 1, body: "# Skill" }]); // only version 1 available
    const result = await agentSkillLoadHandler({ skillSlug: "summarize", version: "5" }, CTX);
    expect(result.loaded).toBe(false);
    expect(result.dependencyErrors[0]!.reason).toContain("version constraint");
  });

  it("loads latest version when no constraint and no active version pinned", async () => {
    enqueue([{ id: "skl_1", activeVersionId: null }]);
    enqueue([
      { id: "slv_3", versionNumber: 3, body: "## Capability: summarize.text" },
      { id: "slv_1", versionNumber: 1, body: "old" },
    ]);
    enqueue([{}]); // usage bump update
    const result = await agentSkillLoadHandler({ skillSlug: "summarize" }, CTX);
    expect(result.loaded).toBe(true);
    expect(result.versionLoaded).toBe(3);
    expect(result.capabilities).toContain("summarize.text");
  });

  it("loads the pinned active version when active != latest and no constraint given", async () => {
    // active version is slv_2 (v2) even though v3 is the latest available row.
    enqueue([{ id: "skl_1", activeVersionId: "slv_2" }]);
    enqueue([
      { id: "slv_3", versionNumber: 3, body: "latest body" },
      { id: "slv_2", versionNumber: 2, body: "## Capability: pinned.cap" },
      { id: "slv_1", versionNumber: 1, body: "old body" },
    ]);
    enqueue([{}]); // usage bump update
    const result = await agentSkillLoadHandler({ skillSlug: "summarize" }, CTX);
    expect(result.loaded).toBe(true);
    expect(result.versionLoaded).toBe(2);
    expect(result.body).toBe("## Capability: pinned.cap");
    expect(result.capabilities).toContain("pinned.cap");
  });

  it("explicit version constraint overrides the pinned active version", async () => {
    enqueue([{ id: "skl_1", activeVersionId: "slv_2" }]);
    enqueue([
      { id: "slv_3", versionNumber: 3, body: "latest body" },
      { id: "slv_2", versionNumber: 2, body: "pinned body" },
      { id: "slv_1", versionNumber: 1, body: "old body" },
    ]);
    enqueue([{}]); // usage bump update
    const result = await agentSkillLoadHandler({ skillSlug: "summarize", version: "3" }, CTX);
    expect(result.loaded).toBe(true);
    expect(result.versionLoaded).toBe(3);
    expect(result.body).toBe("latest body");
  });

  it("records skill-load telemetry on a successful load", async () => {
    enqueue([{ id: "skl_1", activeVersionId: null }]);
    enqueue([{ id: "slv_1", versionNumber: 1, body: "body text" }]);
    enqueue([{}]); // usage bump update
    const result = await agentSkillLoadHandler({ skillSlug: "summarize" }, CTX);
    expect(result.loaded).toBe(true);
    expect(mocks.recordSkillLoad).toHaveBeenCalledTimes(1);
    const arg = mocks.recordSkillLoad.mock.calls[0]![0] as SkillLoadRow;
    expect(arg.skill_id).toBe("skl_1");
    expect(arg.skill_slug).toBe("summarize");
    expect(arg.skill_version).toBe(1);
    expect(arg.org_id).toBe(CTX.orgId);
    expect(arg.workspace_id).toBe(CTX.workspaceId);
    expect(typeof arg.load_latency_ms).toBe("number");
  });

  it("does not record telemetry when the skill fails to load", async () => {
    enqueue([]); // skill not found
    const result = await agentSkillLoadHandler({ skillSlug: "missing" }, CTX);
    expect(result.loaded).toBe(false);
    expect(mocks.recordSkillLoad).not.toHaveBeenCalled();
  });

  it("matches caret constraint (>=N)", async () => {
    enqueue([{ id: "skl_1", activeVersionId: null }]);
    enqueue([
      { id: "slv_5", versionNumber: 5, body: "" },
      { id: "slv_2", versionNumber: 2, body: "" },
    ]);
    enqueue([{}]); // usage bump update
    const result = await agentSkillLoadHandler({ skillSlug: "summarize", version: "^3" }, CTX);
    expect(result.loaded).toBe(true);
    expect(result.versionLoaded).toBe(5);
  });

  it("matches tilde constraint (exact major)", async () => {
    enqueue([{ id: "skl_1", activeVersionId: null }]);
    enqueue([
      { id: "slv_5", versionNumber: 5, body: "" },
      { id: "slv_2", versionNumber: 2, body: "" },
    ]);
    enqueue([{}]); // usage bump update
    const result = await agentSkillLoadHandler({ skillSlug: "summarize", version: "~2" }, CTX);
    expect(result.loaded).toBe(true);
    expect(result.versionLoaded).toBe(2);
  });

  it("collects dependency errors without failing primary load", async () => {
    // dep lookup → not found, primary lookup → found, version lookup → found
    enqueue([]); // dep: skill not found
    enqueue([{ id: "skl_1", activeVersionId: null }]); // primary: skill found
    enqueue([{ id: "slv_1", versionNumber: 1, body: "body text" }]); // primary: version
    enqueue([{}]); // usage bump update
    const result = await agentSkillLoadHandler(
      { skillSlug: "primary", dependencies: ["missing-dep"] },
      CTX,
    );
    expect(result.loaded).toBe(true);
    expect(result.dependencyErrors).toHaveLength(1);
    expect(result.dependencyErrors[0]!.slug).toBe("missing-dep");
  });

  it("returns empty capabilities when body has no capability markers", async () => {
    enqueue([{ id: "skl_1", activeVersionId: null }]);
    enqueue([{ id: "slv_1", versionNumber: 1, body: "# Just a skill body" }]);
    enqueue([{}]); // usage bump update
    const result = await agentSkillLoadHandler({ skillSlug: "plain" }, CTX);
    expect(result.capabilities).toEqual([]);
  });
});

// ── Agent RBAC skills.slugs gate (spec §3.3, Phase 4b) ─────────────────────────

describe("agent.skill.load — role scope gate", () => {
  beforeEach(() => {
    mocks.dbCallResults = [];
    mocks.recordSkillLoad.mockClear();
    mocks.emitAudit.mockClear();
  });

  /** CTX carrying an agentRun whose effective skills scope is `slugs`. */
  function agentCtx(slugs: string[] | undefined) {
    const byCapability = new Map<string, unknown>();
    byCapability.set("load_agent_skill", {
      outcome: "allow",
      agentResolution: {},
      humanResolution: {},
      resourceScope: { skills: slugs === undefined ? {} : { slugs } },
    });
    return {
      ...CTX,
      agentRun: {
        agentPrincipal: {
          id: "prn_agent",
          kind: "agent",
          orgId: CTX.orgId,
          workspaceId: CTX.workspaceId,
        },
        humanPrincipal: null,
        agentId: "agt_1",
        runId: "run_1",
        resolution: { byCapability },
      },
    } as typeof CTX;
  }

  it("denies a slug outside the allow-list without touching the DB, and audits", async () => {
    const result = await agentSkillLoadHandler(
      { skillSlug: "forbidden-skill" },
      agentCtx(["allowed-skill"]),
    );
    expect(result.loaded).toBe(false);
    expect(result.dependencyErrors[0]!.reason).toContain("role scope");
    expect(mocks.dbCallResults).toHaveLength(0); // nothing dequeued — no query ran
    expect(mocks.emitAudit).toHaveBeenCalledTimes(1);
    expect(mocks.emitAudit.mock.calls[0]![0]).toMatchObject({
      capability: "load_agent_skill",
      target: { kind: "skill", id: "forbidden-skill" },
    });
  });

  it("loads an in-scope slug normally", async () => {
    enqueue([{ id: "skl_1", activeVersionId: null }]);
    enqueue([{ id: "slv_1", versionNumber: 1, body: "## Capability: x.y" }]);
    enqueue([{}]); // usage bump
    const result = await agentSkillLoadHandler(
      { skillSlug: "allowed-skill" },
      agentCtx(["allowed-skill"]),
    );
    expect(result.loaded).toBe(true);
    expect(mocks.emitAudit).not.toHaveBeenCalled();
  });

  it("treats undefined slugs as unrestricted (all enabled workspace skills)", async () => {
    enqueue([{ id: "skl_1", activeVersionId: null }]);
    enqueue([{ id: "slv_1", versionNumber: 1, body: "body" }]);
    enqueue([{}]);
    const result = await agentSkillLoadHandler(
      { skillSlug: "any-skill" },
      agentCtx(undefined),
    );
    expect(result.loaded).toBe(true);
  });

  it("filters out-of-scope declared dependencies with a per-slug error", async () => {
    // Primary skill is in scope; dep "outside" is not. Only the primary's
    // queries run (dep query is skipped by the filter).
    enqueue([{ id: "skl_1", activeVersionId: null }]);
    enqueue([{ id: "slv_1", versionNumber: 1, body: "body" }]);
    enqueue([{}]);
    const result = await agentSkillLoadHandler(
      { skillSlug: "allowed-skill", dependencies: ["outside"] },
      agentCtx(["allowed-skill"]),
    );
    expect(result.loaded).toBe(true);
    expect(result.dependencyErrors).toHaveLength(1);
    expect(result.dependencyErrors[0]!).toMatchObject({ slug: "outside" });
    expect(result.dependencyErrors[0]!.reason).toContain("role scope");
  });
});

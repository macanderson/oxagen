import { describe, expect, it, vi, beforeEach } from "vitest";
import type { CapabilityContext } from "@oxagen/oxagen";

// ── hoisted stubs ─────────────────────────────────────────────────────────────
// The handler issues two withTenantDb calls in order, each terminating at
// .limit(1): (1) skill lookup, (2) version lookup. We queue one result per
// call and reset the queue per test so call order never drifts.
const mocks = vi.hoisted(() => ({
  dbCallResults: [] as Array<() => Promise<unknown>>,
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  return {
    ...real,
    withTenantDb: async (fn: (tx: unknown) => Promise<unknown>) => {
      const queued = mocks.dbCallResults.shift();
      const resolve = (): Promise<unknown> =>
        queued ? queued() : Promise.resolve([]);
      const tx = {
        select: () => ({
          from: () => ({
            where: () => ({ limit: () => resolve() }),
          }),
        }),
      };
      return fn(tx);
    },
  };
});

vi.mock("yaml", () => ({
  parse: (s: string) => {
    // minimal yaml parser for test purposes
    const out: Record<string, unknown> = {};
    for (const line of s.split("\n")) {
      const m = /^(\w+):\s*(.+)/.exec(line);
      if (m) out[m[1]!] = m[2]!.trim();
    }
    return out;
  },
}));

import { skillVersionGetHandler } from "./skill.version.get";
import { TEST_CTX as CTX, makeCTX } from "./test-utils/fixtures";

// ── helpers ───────────────────────────────────────────────────────────────────

const SKILL_ROW = {
  id: "uuid-skill-1",
  publicId: "skl_abc",
  activeVersionId: "uuid-ver-2",
};

const VERSION_BODY = `---
name: my-skill
description: A test skill
---
# My Skill

This is the skill content.
`;

const makeVersionRow = (overrides: Record<string, unknown> = {}) => ({
  id: "uuid-ver-2",
  publicId: "slv_002",
  skillId: "uuid-skill-1",
  versionNumber: 2,
  isLatest: true,
  body: VERSION_BODY,
  referencesPayload: [],
  createdAt: new Date("2024-06-01T00:00:00.000Z"),
  createdByUserId: "u_1",
  ...overrides,
});

/** Queue the two withTenantDb results (skill lookup, version lookup). */
function enqueue(skill: unknown, version: unknown): void {
  mocks.dbCallResults.length = 0;
  mocks.dbCallResults.push(
    () => Promise.resolve(skill),
    () => Promise.resolve(version),
  );
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("skillVersionGetHandler (@oxagen/handlers)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enqueue([SKILL_ROW], [makeVersionRow()]);
  });

  it("returns full version with body, frontmatter, and metadata", async () => {
    const result = await skillVersionGetHandler(
      { skill_id: "skl_abc", version_id: "slv_002" },
      CTX,
    );
    expect(result.id).toBe("slv_002");
    expect(result.skill_id).toBe("skl_abc");
    expect(result.versionNumber).toBe(2);
    expect(result.isLatest).toBe(true);
    expect(result.isActive).toBe(true);
    expect(result.body).toBe(VERSION_BODY);
    expect(result.frontmatter).toMatchObject({ name: "my-skill", description: "A test skill" });
    expect(Array.isArray(result.referencesPayload)).toBe(true);
    expect(result.createdBy).toBe("u_1");
    expect(typeof result.createdAt).toBe("string");
    expect(new Date(result.createdAt).getTime()).not.toBeNaN();
  });

  it("sets isActive=true when version matches active_version_id", async () => {
    const result = await skillVersionGetHandler(
      { skill_id: "skl_abc", version_id: "slv_002" },
      CTX,
    );
    expect(result.isActive).toBe(true);
  });

  it("sets isActive=false when version does not match active_version_id", async () => {
    enqueue(
      [SKILL_ROW],
      [makeVersionRow({ id: "uuid-ver-1", publicId: "slv_001", versionNumber: 1, isLatest: false })],
    );
    const result = await skillVersionGetHandler(
      { skill_id: "skl_abc", version_id: "slv_001" },
      CTX,
    );
    expect(result.isActive).toBe(false);
  });

  it("sets isActive=false when skill has no activeVersionId", async () => {
    enqueue([{ ...SKILL_ROW, activeVersionId: null }], [makeVersionRow()]);
    const result = await skillVersionGetHandler(
      { skill_id: "skl_abc", version_id: "slv_002" },
      CTX,
    );
    expect(result.isActive).toBe(false);
  });

  it("throws when skill not found", async () => {
    enqueue([], [makeVersionRow()]);
    await expect(
      skillVersionGetHandler({ skill_id: "skl_unknown", version_id: "slv_002" }, CTX),
    ).rejects.toThrow("Skill not found: skl_unknown");
  });

  it("throws when version not found", async () => {
    enqueue([SKILL_ROW], []);
    await expect(
      skillVersionGetHandler({ skill_id: "skl_abc", version_id: "slv_999" }, CTX),
    ).rejects.toThrow("Skill version not found: slv_999");
  });

  it("returns null createdBy when createdByUserId is null", async () => {
    enqueue([SKILL_ROW], [makeVersionRow({ createdByUserId: null })]);
    const result = await skillVersionGetHandler(
      { skill_id: "skl_abc", version_id: "slv_002" },
      CTX,
    );
    expect(result.createdBy).toBeNull();
  });

  it("returns empty frontmatter when body has no frontmatter block", async () => {
    enqueue([SKILL_ROW], [makeVersionRow({ body: "# Skill body without frontmatter" })]);
    const result = await skillVersionGetHandler(
      { skill_id: "skl_abc", version_id: "slv_002" },
      CTX,
    );
    expect(result.frontmatter).toEqual({});
  });

  it("returns empty referencesPayload when DB value is not an array", async () => {
    enqueue([SKILL_ROW], [makeVersionRow({ referencesPayload: null })]);
    const result = await skillVersionGetHandler(
      { skill_id: "skl_abc", version_id: "slv_002" },
      CTX,
    );
    expect(result.referencesPayload).toEqual([]);
  });

  it("createdAt is serialized as ISO 8601 string", async () => {
    const result = await skillVersionGetHandler(
      { skill_id: "skl_abc", version_id: "slv_002" },
      CTX,
    );
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("propagates DB error from skill lookup", async () => {
    mocks.dbCallResults.length = 0;
    mocks.dbCallResults.push(() => Promise.reject(new Error("DB connection failed")));
    await expect(
      skillVersionGetHandler({ skill_id: "skl_abc", version_id: "slv_002" }, CTX),
    ).rejects.toThrow("DB connection failed");
  });

  it("propagates DB error from version lookup", async () => {
    mocks.dbCallResults.length = 0;
    mocks.dbCallResults.push(
      () => Promise.resolve([SKILL_ROW]),
      () => Promise.reject(new Error("version query failed")),
    );
    await expect(
      skillVersionGetHandler({ skill_id: "skl_abc", version_id: "slv_002" }, CTX),
    ).rejects.toThrow("version query failed");
  });

  it("tenant isolation: skill from different workspace throws not-found", async () => {
    enqueue([], [makeVersionRow()]);
    const alienCtx: CapabilityContext = makeCTX({ workspaceId: "ws_other", orgId: "org_other" });
    await expect(
      skillVersionGetHandler({ skill_id: "skl_abc", version_id: "slv_002" }, alienCtx),
    ).rejects.toThrow("Skill not found: skl_abc");
  });
});

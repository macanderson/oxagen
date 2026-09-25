import { skillConfigGet } from "@oxagen/oxagen/contracts/skill.config.get";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseSkillConfig } from "./skill-resolution";
import { skillConfigSchema } from "@oxagen/oxagen/skills";
import { createSkillConfigGetHandler } from "./skill.config.get";
import { makeCTX } from "./test-utils/fixtures";
const gate = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => gate);

describe("get_skill_config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.assertOrgRole.mockResolvedValue(undefined);
    gate.resolveActingUserId.mockResolvedValue("owner");
  });
  it("starts off without inventing a published version", async () => {
    const store = { list: vi.fn().mockResolvedValue([]), publish: vi.fn() };
    const result = await createSkillConfigGetHandler(
      store,
      vi.fn().mockResolvedValue(undefined),
    )({}, makeCTX());
    expect(skillConfigGet.output.parse(result)).toMatchObject({
      config: { enabled: false },
      current: null,
      versions: [],
    });
    expect(parseSkillConfig(result.draftText).config).toEqual(result.config);
    expect(gate.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner" }),
      { org: ["Owner", "Admin", "Member"], workspace: ["Owner", "Member"] },
    );
  });
  it("selects an immutable version without leaking its internal binding id", async () => {
    const row = {
      id: "skv_123",
      version: "skl_v1",
      repositoryBindingId: "internal",
      config: skillConfigSchema.parse({}),
      commitSha: "a".repeat(40),
      digest: `sha256:${"b".repeat(64)}`,
      pullRequestNumber: 12,
      publishedAt: "2026-09-20T10:00:00.000Z",
    };
    const handler = createSkillConfigGetHandler(
      { list: vi.fn().mockResolvedValue([row]), publish: vi.fn() },
      vi.fn().mockResolvedValue({ bindingId: "new-binding" }),
    );
    expect(
      (await handler({ version: "skl_v1" }, makeCTX())).current,
    ).not.toHaveProperty("repositoryBindingId");
    expect(await handler({}, makeCTX())).toMatchObject({
      current: null,
      config: { enabled: false },
    });
    await expect(
      handler({ version: "skl_v2" }, makeCTX()),
    ).rejects.toMatchObject({ reason: "skill_config_missing" });
  });
  it("marks only versions of the current binding as searchable (#3666)", async () => {
    const earlier = {
      id: "skv_111",
      version: "skl_v1",
      repositoryBindingId: "old-binding",
      config: skillConfigSchema.parse({}),
      commitSha: "a".repeat(40),
      digest: `sha256:${"b".repeat(64)}`,
      pullRequestNumber: 11,
      publishedAt: "2026-09-19T10:00:00.000Z",
    };
    const later = {
      ...earlier,
      id: "skv_222",
      version: "skl_v2",
      repositoryBindingId: "new-binding",
      pullRequestNumber: 12,
      publishedAt: "2026-09-20T10:00:00.000Z",
    };
    const binding = vi.fn().mockResolvedValue({ bindingId: "new-binding" });
    const handler = createSkillConfigGetHandler(
      { list: vi.fn().mockResolvedValue([later, earlier]), publish: vi.fn() },
      binding,
    );
    const result = skillConfigGet.output.parse(await handler({}, makeCTX()));
    expect(result.current).toMatchObject({
      version: "skl_v2",
      searchable: true,
    });
    expect(result.versions.map((row) => [row.version, row.searchable])).toEqual(
      [
        ["skl_v2", true],
        ["skl_v1", false],
      ],
    );
    // Naming an earlier version still reports it as unsearchable.
    const named = await handler({ version: "skl_v1" }, makeCTX());
    expect(named.current).toMatchObject({
      version: "skl_v1",
      searchable: false,
    });
    // An unbound workspace has no searchable version at all.
    binding.mockResolvedValue(undefined);
    const unbound = await handler({}, makeCTX());
    expect(unbound.current).toBeNull();
    expect(unbound.versions.every((row) => row.searchable === false)).toBe(
      true,
    );
  });
  it("checks the human role before reading any configuration", async () => {
    const store = { list: vi.fn(), publish: vi.fn() };
    gate.assertOrgRole.mockRejectedValue(new Error("denied"));
    await expect(
      createSkillConfigGetHandler(store, vi.fn().mockResolvedValue(undefined))(
        {},
        makeCTX(),
      ),
    ).rejects.toThrow("denied");
    expect(store.list).not.toHaveBeenCalled();
  });
});

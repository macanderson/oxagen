import { skillConfigGet } from "@oxagen/oxagen/contracts/skill.config.get";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

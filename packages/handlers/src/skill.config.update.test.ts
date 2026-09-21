import { beforeEach, describe, expect, it, vi } from "vitest";
import { skillConfigSchema } from "@oxagen/oxagen/skills";
import { createSkillConfigUpdateHandler } from "./skill.config.update";
import { makeCTX } from "./test-utils/fixtures";
const gate = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => gate);

describe("update_skill_config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    gate.assertOrgRole.mockResolvedValue(undefined);
    gate.resolveActingUserId.mockResolvedValue("owner");
  });
  const snapshot = {
    id: "skv_123",
    version: "skl_v1",
    repositoryBindingId: "internal",
    config: skillConfigSchema.parse({}),
    commitSha: "a".repeat(40),
    digest: `sha256:${"b".repeat(64)}`,
    pullRequestNumber: 12,
    publishedAt: "2026-09-20T10:00:00.000Z",
  };
  it("separates proposal from approved publication and import", async () => {
    const service = {
      propose: vi
        .fn()
        .mockResolvedValue({ number: 12, url: "https://github.test/pull/12" }),
      publish: vi.fn().mockResolvedValue(snapshot),
    };
    const handler = createSkillConfigUpdateHandler(service);
    expect(
      await handler({ action: "propose", text: "enabled = false" }, makeCTX()),
    ).toMatchObject({ pullRequest: { number: 12 }, published: null });
    expect(service.publish).not.toHaveBeenCalled();
    expect(
      await handler({ action: "publish", pullRequestNumber: 12 }, makeCTX()),
    ).toMatchObject({ pullRequest: null, published: { id: "skv_123" } });
    expect(service.publish).toHaveBeenCalledWith(
      { ...makeCTX(), userId: "owner" },
      12,
    );
    await handler({ action: "import" }, makeCTX());
    expect(service.publish).toHaveBeenLastCalledWith({
      ...makeCTX(),
      userId: "owner",
    });
    expect(gate.assertOrgRole).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "owner" }),
      { org: ["Owner", "Admin"] },
    );
  });
  it("rejects ambiguous arguments and refuses a non-manager before the service runs", async () => {
    const service = { propose: vi.fn(), publish: vi.fn() };
    const handler = createSkillConfigUpdateHandler(service);
    await expect(
      handler(
        { action: "publish", text: "enabled = true", pullRequestNumber: 12 },
        makeCTX(),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    gate.assertOrgRole.mockRejectedValue(new Error("denied"));
    await expect(handler({ action: "import" }, makeCTX())).rejects.toThrow(
      "denied",
    );
    expect(service.propose).not.toHaveBeenCalled();
    expect(service.publish).not.toHaveBeenCalled();
  });
});

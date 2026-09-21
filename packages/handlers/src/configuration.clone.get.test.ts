import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCTX } from "./test-utils/fixtures";
import { createConfigurationCloneGetHandler } from "./configuration.clone.get";
import {
  configurationSourceDigest,
  type ConfigurationSource,
} from "./configuration-clone-source";
const gate = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => gate);
const original: ConfigurationSource = {
  kind: "skill",
  id: "review",
  slug: "review",
  name: "review",
  source:
    '---\nname: review\nversion: "1.0.0"\nscope: workspace\n---\nReview changes.',
  files: [{ path: "notes.md", content: "Notes" }],
  harness: null,
  repository: { bindingId: "binding" } as ConfigurationSource["repository"],
};
beforeEach(() => {
  vi.clearAllMocks();
  gate.assertOrgRole.mockResolvedValue(undefined);
  gate.resolveActingUserId.mockResolvedValue("owner");
});
describe("get_clone_draft", () => {
  it("skips occupied historical names and opens an editable proposal without changing source", async () => {
    const source = vi.fn().mockResolvedValue(original);
    const taken = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const out = await createConfigurationCloneGetHandler({ source, taken })(
      { kind: "skill", sourceId: "review" },
      makeCTX(),
    );
    expect(out).toMatchObject({
      slug: "review-cloned-2",
      name: "review-cloned-2",
      sourceDigest: configurationSourceDigest(original),
      files: original.files,
    });
    expect(out.source).toContain("name: review-cloned-2");
    expect(original.source).toContain("name: review\n");
    expect(taken.mock.calls.map((call) => call[2])).toEqual([
      "review-cloned",
      "review-cloned-1",
      "review-cloned-2",
    ]);
  });
  it("refuses denied users before reading a source", async () => {
    gate.assertOrgRole.mockRejectedValue(new Error("denied"));
    const source = vi.fn();
    await expect(
      createConfigurationCloneGetHandler({ source, taken: vi.fn() })(
        { kind: "skill", sourceId: "review" },
        makeCTX(),
      ),
    ).rejects.toThrow("denied");
    expect(source).not.toHaveBeenCalled();
  });
  it("binds the draft digest to repository identity and source metadata", () => {
    const digest = configurationSourceDigest(original);
    expect(
      configurationSourceDigest({
        ...original,
        repository: { ...original.repository, bindingId: "new-binding" },
      }),
    ).not.toBe(digest);
    expect(
      configurationSourceDigest({ ...original, name: "Renamed" }),
    ).not.toBe(digest);
    expect(configurationSourceDigest({ ...original, files: [] })).not.toBe(
      digest,
    );
  });
});

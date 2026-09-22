import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCTX } from "./test-utils/fixtures";
import { createConfigurationCloneGetHandler } from "./configuration.clone.get";
import {
  configurationSourceDigest,
  type ConfigurationSource,
  type TakenConfigurationNames,
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
const takenNames = (
  over: Partial<TakenConfigurationNames> = {},
): TakenConfigurationNames => ({
  slugs: new Set(),
  names: new Set(),
  files: new Set(),
  ...over,
});
describe("get_clone_draft", () => {
  it("skips occupied historical names and opens an editable proposal without changing source", async () => {
    const source = vi.fn().mockResolvedValue(original);
    // One is a published file, one is a proposal branch: the first is ruled
    // out by the single tree read, the second by the per-candidate branch
    // check, which is asked only of the candidates the reads let through.
    const taken = vi
      .fn()
      .mockResolvedValue(
        takenNames({
          files: new Set([".oxagen/skills/review-cloned/SKILL.md"]),
        }),
      );
    const branchTaken = vi
      .fn()
      .mockResolvedValueOnce(true)
      .mockResolvedValue(false);
    const out = await createConfigurationCloneGetHandler({
      source,
      taken,
      branchTaken,
    })({ kind: "skill", sourceId: "review" }, makeCTX());
    expect(out).toMatchObject({
      slug: "review-cloned-2",
      name: "review-cloned-2",
      sourceDigest: configurationSourceDigest(original),
      files: original.files,
    });
    expect(out.source).toContain("name: review-cloned-2");
    expect(original.source).toContain("name: review\n");
    expect(taken).toHaveBeenCalledTimes(1);
    expect(branchTaken.mock.calls.map((call) => call[1])).toEqual([
      "review-cloned-1",
      "review-cloned-2",
    ]);
  });
  it("rules a candidate out by its workspace slug or display name without a GitHub call", async () => {
    const source = vi.fn().mockResolvedValue({
      ...original,
      kind: "agent" as const,
      name: "Review",
      source: 'slug = "review"\nname = "Review"\ndescription = "Reviews."\n',
    });
    const taken = vi.fn().mockResolvedValue(
      takenNames({
        slugs: new Set(["review-cloned"]),
        names: new Set(["Review-cloned-1"]),
      }),
    );
    const branchTaken = vi.fn().mockResolvedValue(false);
    const out = await createConfigurationCloneGetHandler({
      source,
      taken,
      branchTaken,
    })({ kind: "agent", sourceId: "review" }, makeCTX());
    expect(out).toMatchObject({
      slug: "review-cloned-2",
      name: "Review-cloned-2",
    });
    expect(taken).toHaveBeenCalledTimes(1);
    expect(branchTaken).toHaveBeenCalledTimes(1);
    expect(branchTaken).toHaveBeenCalledWith(
      expect.anything(),
      "review-cloned-2",
    );
  });
  it("refuses denied users before reading a source", async () => {
    gate.assertOrgRole.mockRejectedValue(new Error("denied"));
    const source = vi.fn();
    await expect(
      createConfigurationCloneGetHandler({
        source,
        taken: vi.fn(),
        branchTaken: vi.fn(),
      })({ kind: "skill", sourceId: "review" }, makeCTX()),
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

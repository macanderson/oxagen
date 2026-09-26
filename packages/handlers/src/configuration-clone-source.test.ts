import { describe, expect, it, vi } from "vitest";
const deps = vi.hoisted(() => ({ resolveSkillRepository: vi.fn() }));
vi.mock("./skill-config.repository", () => deps);
import {
  readConfigurationSource,
  configurationSourceDigest,
} from "./configuration-clone-source";
describe("published clone source", () => {
  it("reads source and companions from one immutable production commit", async () => {
    const sha = "a".repeat(40);
    const getFileContent = vi
      .fn()
      .mockResolvedValueOnce("skill source")
      .mockResolvedValueOnce("companion");
    const repository = {
      bindingId: "binding",
      owner: "acme",
      repo: "repo",
      productionBranch: "release",
      github: {
        getBranch: vi.fn().mockResolvedValue({ sha }),
        getTree: vi
          .fn()
          .mockResolvedValue([
            ".oxagen/skills/review/SKILL.md",
            ".oxagen/skills/review/notes.md",
          ]),
        getFileContent,
      },
    };
    deps.resolveSkillRepository.mockResolvedValue(repository);
    const source = await readConfigurationSource(
      { orgId: "org", workspaceId: "ws" },
      "skill",
      "review",
    );
    expect(
      getFileContent.mock.calls.every(([input]) => input.ref === sha),
    ).toBe(true);
    expect(source.files).toEqual([{ path: "notes.md", content: "companion" }]);
    expect(
      configurationSourceDigest({
        ...source,
        repository: { ...source.repository, bindingId: "changed" },
      }),
    ).not.toBe(configurationSourceDigest(source));
  });
  it("refuses a missing approved production branch", async () => {
    const getFileContent = vi.fn();
    deps.resolveSkillRepository.mockResolvedValue({
      github: { getBranch: vi.fn().mockResolvedValue(null), getFileContent },
    });
    await expect(
      readConfigurationSource(
        { orgId: "org", workspaceId: "ws" },
        "skill",
        "review",
      ),
    ).rejects.toMatchObject({ reason: "skill_production_branch_missing" });
    expect(getFileContent).not.toHaveBeenCalled();
  });
});

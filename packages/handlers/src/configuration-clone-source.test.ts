import { schema, withSystemDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq } from "drizzle-orm";
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

it.skipIf(!process.env.DATABASE_URL)(
  "does not clone an agent from another workspace",
  async () => {
    const orgId = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    let id: string | undefined;
    const getBranch = vi.fn();
    deps.resolveSkillRepository.mockResolvedValue({ github: { getBranch } });
    try {
      const [agent] = await withSystemDb((tx) =>
        tx
          .insert(schema.agents)
          .values({
            orgId,
            workspaceId: crypto.randomUUID(),
            slug: "cross-workspace-clone",
            name: "Other workspace",
            agentType: "custom",
            harness: "claude-code",
          })
          .returning(),
      );
      id = agent!.id;
      await expect(
        runInTenantScope({ orgId, workspaceId }, () =>
          readConfigurationSource(
            { orgId, workspaceId },
            "agent",
            agent!.publicId,
          ),
        ),
      ).rejects.toMatchObject({ reason: "clone_source_missing" });
      expect(getBranch).not.toHaveBeenCalled();
    } finally {
      if (id)
        await withSystemDb((tx) =>
          tx.delete(schema.agents).where(eq(schema.agents.id, id!)),
        );
    }
  },
);

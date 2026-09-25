import { beforeEach, describe, expect, it, vi } from "vitest";
import { configurationCloneDraftSchema } from "@oxagen/oxagen/configuration-clone";
import { createConfigurationCloneProposeHandler } from "./configuration.clone.propose";
import {
  configurationSourceDigest,
  type ConfigurationSource,
} from "./configuration-clone-source";
import {
  ctx,
  FakeGitHub,
  MemoryStore,
  REPO,
} from "./context.steering.test-support";
const gate = vi.hoisted(() => ({
  assertOrgRole: vi.fn(),
  resolveActingUserId: vi.fn(),
  resolveActorOrgRole: vi.fn(),
  resolveActorWorkspaceRole: vi.fn(),
}));
vi.mock("@oxagen/iam/org-role", () => gate);
const body = (name: string) =>
  `---\nname: ${name}\nversion: "1.0.0"\nscope: workspace:core-platform\n---\nReview changes.\n`;
const original: ConfigurationSource = {
  kind: "skill",
  id: "review",
  slug: "review",
  name: "review",
  source: body("review"),
  files: [],
  harness: null,
  repository: { bindingId: "binding" } as ConfigurationSource["repository"],
};
const input = () =>
  configurationCloneDraftSchema.parse({
    kind: "skill",
    sourceId: "review",
    sourceDigest: configurationSourceDigest(original),
    slug: "review-cloned",
    name: "review-cloned",
    source: body("review-cloned"),
    files: [],
    harness: null,
  });
function setup() {
  const github = new FakeGitHub();
  const source = vi.fn().mockResolvedValue(original);
  const taken = vi.fn().mockResolvedValue(false);
  const facts = vi.fn();
  const store = new MemoryStore();
  return {
    github,
    source,
    taken,
    facts,
    store,
    handler: createConfigurationCloneProposeHandler({
      github,
      source,
      taken,
      facts,
      store,
    }),
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  gate.assertOrgRole.mockResolvedValue(undefined);
  gate.resolveActingUserId.mockResolvedValue("owner");
});
describe("propose_configuration_clone", () => {
  it("opens a distinct skill PR without replacing the source, and refuses a second submit even if the name check raced", async () => {
    const { handler, github } = setup();
    const result = await handler(input(), ctx());
    expect(result).toMatchObject({
      slug: "review-cloned",
      proposalId: null,
      pullRequest: { number: 519 },
    });
    expect(github.branches.map((row) => row.branch)).toEqual([
      "skills/review-cloned",
    ]);
    expect(
      await github.readFile(
        REPO,
        ".oxagen/skills/review-cloned/SKILL.md",
        "skills/review-cloned",
      ),
    ).toContain("name: review-cloned");
    await expect(handler(input(), ctx())).rejects.toMatchObject({
      reason: "clone_name_taken",
    });
    expect(github.pulls).toHaveLength(1);
  });
  it("proposes an agent with a new source identity and no credential allocation", async () => {
    const { handler, source, facts, github, store } = setup();
    const originalAgent = {
      ...original,
      kind: "agent" as const,
      harness: "claude-code" as const,
      source:
        'schema="agent-definition/v0.1"\nslug="review"\nname="Review"\nmodel_tier="complex"\ntools=[]\nside_effects=[]\nbudget={per_run_micros=1}\n[instructions]\nbody="Review changes."',
    };
    source.mockResolvedValue(originalAgent);
    facts.mockResolvedValue({
      slugTaken: false,
      agentKey: "acme.core.review-cloned",
      registry: { tools: [], capabilities: [] },
      exceeded: [],
    });
    const result = await handler(
      {
        ...input(),
        kind: "agent",
        harness: "claude-code",
        name: "Review-cloned",
        sourceDigest: configurationSourceDigest(originalAgent),
        source: originalAgent.source,
      },
      ctx(),
    );
    expect(result).toMatchObject({ slug: "review-cloned", proposalId: null });
    expect(github.branches.map((row) => row.branch)).toEqual([
      "agents/review-cloned",
    ]);
    expect(
      await github.readFile(
        REPO,
        ".oxagen/agents/review-cloned.toml",
        "agents/review-cloned",
      ),
    ).toContain('slug = "review-cloned"');
    expect(store.proposals.length).toBe(0);
  });
  it("creates a distinct record proposal under the existing workflow without publishing it", async () => {
    const { handler, source, store, github } = setup();
    const originalRecord = { ...original, kind: "record" as const };
    source.mockResolvedValue(originalRecord);
    const insert = vi.spyOn(store, "insertProposal");
    const result = await handler(
      {
        ...input(),
        kind: "record",
        name: "Review-cloned",
        sourceDigest: configurationSourceDigest(originalRecord),
        source:
          'lineageId="review"\ntitle="Review"\nkind="rule"\nforce="must"\nsharingScope="workspace"\nstatement="Review changes."',
      },
      ctx(),
    );
    expect(result).toMatchObject({
      slug: "review-cloned",
      pullRequest: null,
      proposalId: expect.any(String),
    });
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        lineageId: "review-cloned",
        label: "Review-cloned",
        statement: "Review changes.",
      }),
      { createOnly: true },
    );
    expect(github.pulls).toEqual([]);
  });
  it("refuses a second record clone on the same slug even if the name check raced (ADR-178)", async () => {
    const { handler, source, store } = setup();
    const originalRecord = { ...original, kind: "record" as const };
    source.mockResolvedValue(originalRecord);
    const clone = {
      ...input(),
      kind: "record" as const,
      name: "Review-cloned",
      sourceDigest: configurationSourceDigest(originalRecord),
      source:
        'lineageId="review"\nlabel="Review"\nkind="rule"\nforce="must"\nsharingScope="workspace"\nstatement="Review changes."',
    };
    await handler(clone, ctx());
    // `taken` still answers false, so only the store's create-only refusal
    // stands between the second submit and a second row on the lineage.
    await expect(handler(clone, ctx())).rejects.toMatchObject({
      code: "conflict",
      reason: "clone_name_taken",
    });
    expect(store.proposals).toHaveLength(1);
  });
  it("refuses a record clone whose name is longer than a label as invalid input, before reading the source (ADR-178)", async () => {
    const { handler, source, store } = setup();
    const originalRecord = { ...original, kind: "record" as const };
    source.mockResolvedValue(originalRecord);
    // The draft allows a 200-character name. A record's name is its label,
    // which stops at 36.
    await expect(
      handler(
        {
          ...input(),
          kind: "record",
          name: "x".repeat(37),
          sourceDigest: configurationSourceDigest(originalRecord),
          source:
            'lineageId="review"\nkind="rule"\nforce="must"\nsharingScope="workspace"\nstatement="Review changes."',
        },
        ctx(),
      ),
    ).rejects.toMatchObject({
      code: "invalid_input",
      message: expect.stringContaining("36"),
    });
    expect(source).not.toHaveBeenCalled();
    expect(store.proposals).toEqual([]);
  });
  it("refuses changed source content and occupied identities before opening a branch", async () => {
    const { handler, source, taken, github } = setup();
    source.mockResolvedValueOnce({ ...original, source: body("changed") });
    await expect(handler(input(), ctx())).rejects.toMatchObject({
      reason: "clone_source_changed",
    });
    taken.mockResolvedValue(true);
    await expect(handler(input(), ctx())).rejects.toMatchObject({
      reason: "clone_name_taken",
    });
    expect(github.branches).toEqual([]);
  });
  it("checks human authorization before repository or identity reads", async () => {
    const { handler, source } = setup();
    gate.assertOrgRole.mockRejectedValue(new Error("denied"));
    await expect(handler(input(), ctx())).rejects.toThrow("denied");
    expect(source).not.toHaveBeenCalled();
  });
});

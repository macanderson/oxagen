import { describe, expect, it, vi } from "vitest";
import { skillConfigSchema, type SkillCandidate } from "@oxagen/oxagen/skills";
import {
  agentSkillResolution,
  parseSkillConfig,
  pinnedSkillIds,
  resolveSkills,
} from "./skill-resolution";

/** Every candidate's bytes were read unless a case says otherwise. */
const read = (candidates: SkillCandidate[], unpinned: string[] = []) => ({
  candidates,
  unpinned,
});

const digest = `sha256:${"a".repeat(64)}`;
const candidate = (id: string, tokenCost = 100): SkillCandidate => ({
  id,
  version: "1.0.0",
  digest,
  source: "workspace",
  description: id,
  tokenCost,
});
function config(candidates: SkillCandidate[], search = {}) {
  return skillConfigSchema.parse({
    enabled: true,
    sources: [
      {
        id: "workspace",
        path: ".oxagen/skills",
        skills: candidates.map(({ id, version, digest }) => ({
          id,
          version,
          digest,
        })),
      },
    ],
    search,
  });
}
describe("skill resolution", () => {
  it("parses actual TOML, defaults only missing configuration, and digests exact file bytes", () => {
    expect(parseSkillConfig(null).config.enabled).toBe(false);
    expect(
      parseSkillConfig("enabled = true\n[search]\nbudget = 1_024").config.search
        .budget,
    ).toBe(1024);
    expect(parseSkillConfig("").digest).not.toBe(parseSkillConfig("\n").digest);
    expect(() => parseSkillConfig("enabled =")).toThrow();
    expect(() => parseSkillConfig("enabled = true\nenabled = false")).toThrow();
    expect(() => parseSkillConfig('unbound_repo = "allow"')).toThrow();
  });
  it("withholds before the ranker sees names and projects only counts to the agent", async () => {
    const good = candidate("review");
    const changed = candidate("changed");
    const out = candidate("secret-procedure");
    const rank = vi.fn().mockResolvedValue([0.8]);
    const result = await resolveSkills(
      config([good, changed]),
      read([good, { ...changed, digest: `sha256:${"b".repeat(64)}` }, out]),
      rank,
    );
    expect(rank).toHaveBeenCalledWith([good]);
    expect(result.withheld).toEqual([
      { id: "changed", reason: "unapproved_digest" },
      { id: "secret-procedure", reason: "out_of_scope" },
    ]);
    const wire = agentSkillResolution(result);
    expect(wire.withheld).toEqual({
      count: 2,
      reasons: { out_of_scope: 1, unapproved_digest: 1 },
    });
    expect(JSON.stringify(wire)).not.toContain("secret-procedure");
    expect(JSON.stringify(wire)).not.toContain("changed");
  });
  it("enforces the cumulative load budget, score cutoff and result limit", async () => {
    const candidates = [
      candidate("large", 400),
      candidate("first", 200),
      candidate("second", 100),
      candidate("third", 10),
      candidate("low", 1),
    ];
    const result = await resolveSkills(
      config(candidates, { budget: 300, cutoff: 0.5, limit: 2 }),
      read(candidates),
      async () => [1, 0.9, 0.8, 0.7, 0.2],
    );
    expect(result.results.map((row) => row.id)).toEqual(["first", "second"]);
    expect(result.tokenCost).toBe(300);
  });
  it("uses the supplied pinned version and never calls the ranker while off", async () => {
    const skill = candidate("review");
    const old = config([skill]);
    const newer = skillConfigSchema.parse({});
    const rank = vi.fn().mockResolvedValue([1]);
    expect(
      (await resolveSkills(old, read([skill]), rank)).results,
    ).toHaveLength(1);
    rank.mockClear();
    expect((await resolveSkills(newer, read([skill]), rank)).results).toEqual(
      [],
    );
    expect(rank).not.toHaveBeenCalled();
    expect(
      (await resolveSkills(old, read([skill]), rank)).results,
    ).toHaveLength(1);
  });
  it("refuses duplicate catalog identities and invalid scores", async () => {
    const skill = candidate("review");
    await expect(
      resolveSkills(config([skill]), read([skill, skill]), async () => []),
    ).rejects.toThrow("duplicate");
    await expect(
      resolveSkills(config([skill]), read([skill], ["other"]), async () => [1]),
    ).resolves.toBeDefined();
    await expect(
      resolveSkills(config([skill]), read([], ["other", "other"]), async () => [
        1,
      ]),
    ).rejects.toThrow("duplicate");
    for (const scores of [[], [NaN], [Infinity], [-1], [2]]) {
      await expect(
        resolveSkills(config([skill]), read([skill]), async () => scores),
      ).rejects.toThrow("invalid scores");
    }
  });
  it("names the skills a reader may leave unread and refuses one skipped in error", async () => {
    const skill = candidate("review");
    const pinned = config([skill]);
    expect([...pinnedSkillIds(pinned, "workspace")]).toEqual(["review"]);
    expect([...pinnedSkillIds(pinned, "other-source")]).toEqual([]);
    expect([
      ...pinnedSkillIds(skillConfigSchema.parse({}), "workspace"),
    ]).toEqual([]);
    const result = await resolveSkills(
      pinned,
      read([skill], ["unlisted"]),
      async () => [1],
    );
    expect(result.results.map((row) => row.id)).toEqual(["review"]);
    expect(result.withheld).toEqual([
      { id: "unlisted", reason: "out_of_scope" },
    ]);
    await expect(
      resolveSkills(pinned, read([], ["review"]), async () => []),
    ).rejects.toThrow("pinned skill unread");
  });
});

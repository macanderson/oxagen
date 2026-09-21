import { describe, expect, it, vi } from "vitest";
import { skillConfigSchema, type SkillCandidate } from "@oxagen/oxagen/skills";
import {
  agentSkillResolution,
  parseSkillConfig,
  resolveSkills,
} from "./skill-resolution";

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
      [good, { ...changed, digest: `sha256:${"b".repeat(64)}` }, out],
      rank,
    );
    expect(rank).toHaveBeenCalledWith([good]);
    expect(result.withheld.map((held) => held.reason)).toEqual([
      "unapproved_digest",
      "out_of_scope",
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
      candidates,
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
    expect((await resolveSkills(old, [skill], rank)).results).toHaveLength(1);
    rank.mockClear();
    expect((await resolveSkills(newer, [skill], rank)).results).toEqual([]);
    expect(rank).not.toHaveBeenCalled();
    expect((await resolveSkills(old, [skill], rank)).results).toHaveLength(1);
  });
  it("refuses duplicate catalog identities and invalid scores", async () => {
    const skill = candidate("review");
    await expect(
      resolveSkills(config([skill]), [skill, skill], async () => []),
    ).rejects.toThrow("duplicate");
    for (const scores of [[], [NaN], [Infinity], [-1], [2]]) {
      await expect(
        resolveSkills(config([skill]), [skill], async () => scores),
      ).rejects.toThrow("invalid scores");
    }
  });
});

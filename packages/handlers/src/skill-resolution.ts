import { parse } from "smol-toml";
import { HandlerError } from "@oxagen/oxagen";
import {
  skillConfigSchema,
  skillCandidateSchema,
  type SkillCandidate,
  type SkillConfig,
  type SkillWithheldReason,
} from "@oxagen/oxagen/skills";
import { sha256Hex } from "./registry-digest";

/** Missing configuration is off; invalid configuration never becomes a default. */
export function parseSkillConfig(text: string | null): {
  config: SkillConfig;
  digest: string;
} {
  try {
    return {
      config: skillConfigSchema.parse(text === null ? {} : parse(text)),
      digest: `sha256:${sha256Hex(text ?? "")}`,
    };
  } catch {
    throw new HandlerError({
      code: "conflict",
      reason: "skill_config_invalid",
      message: "The skill configuration is not valid version 1 TOML",
    });
  }
}

export type SkillResolution = {
  results: Array<SkillCandidate & { score: number }>;
  withheld: Array<SkillCandidate & { reason: SkillWithheldReason }>;
  tokenCost: number;
};

/** Only approved candidates reach the ranker, including an embedding service. */
export async function resolveSkills(
  pinnedConfig: SkillConfig,
  candidates: readonly SkillCandidate[],
  rank: (eligible: readonly SkillCandidate[]) => Promise<readonly number[]>,
): Promise<SkillResolution> {
  const config = skillConfigSchema.parse(pinnedConfig);
  const eligible: SkillCandidate[] = [];
  const withheld: SkillResolution["withheld"] = [];
  const identities = new Set<string>();
  for (const raw of candidates) {
    const candidate = skillCandidateSchema.parse(raw);
    const identity = `${candidate.source}/${candidate.id}@${candidate.version}`;
    if (identities.has(identity))
      throw new Error("Skill catalog contains a duplicate identity");
    identities.add(identity);
    const pin = config.enabled
      ? config.sources
          .find((source) => source.id === candidate.source)
          ?.skills.find(
            (entry) =>
              entry.id === candidate.id && entry.version === candidate.version,
          )
      : undefined;
    if (!pin) withheld.push({ ...candidate, reason: "out_of_scope" });
    else if (pin.digest !== candidate.digest)
      withheld.push({ ...candidate, reason: "unapproved_digest" });
    else eligible.push(candidate);
  }
  if (!eligible.length) return { results: [], withheld, tokenCost: 0 };
  const scores = await rank(eligible);
  if (
    scores.length !== eligible.length ||
    scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
  ) {
    throw new Error("Skill ranker returned invalid scores");
  }
  const ranked = eligible
    .map((candidate, index) => ({ ...candidate, score: scores[index]! }))
    .filter((candidate) => candidate.score >= config.search.cutoff)
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.source.localeCompare(b.source) ||
        a.id.localeCompare(b.id) ||
        a.version.localeCompare(b.version),
    );
  const results: SkillResolution["results"] = [];
  let tokenCost = 0;
  for (const candidate of ranked) {
    if (results.length === config.search.limit) break;
    if (candidate.tokenCost > config.search.budget - tokenCost) continue;
    tokenCost += candidate.tokenCost;
    results.push(candidate);
  }
  return { results, withheld, tokenCost };
}

/** The agent projection cannot disclose a held name, source, version or digest. */
export function agentSkillResolution(resolution: SkillResolution) {
  const reasons: Record<SkillWithheldReason, number> = {
    out_of_scope: 0,
    unapproved_digest: 0,
  };
  for (const held of resolution.withheld) reasons[held.reason] += 1;
  return {
    results: resolution.results,
    tokenCost: resolution.tokenCost,
    withheld: { count: resolution.withheld.length, reasons },
  };
}

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

/** A withheld skill is named to a person and counted to an agent; nothing else about it travels. */
export type SkillWithheld = { id: string; reason: SkillWithheldReason };

/**
 * One repository commit's skill catalog, split by what the resolver needed to read.
 * A skill no pin names can only be withheld, so a reader may report its id from the
 * tree and leave its bytes on GitHub.
 */
export type SkillCatalog = {
  candidates: readonly SkillCandidate[];
  unpinned: readonly string[];
};

export type SkillResolution = {
  results: Array<SkillCandidate & { score: number }>;
  withheld: SkillWithheld[];
  tokenCost: number;
};

/** The skill ids an enabled configuration pins for one source. Nothing else can be eligible. */
export function pinnedSkillIds(
  pinnedConfig: SkillConfig,
  source: string,
): Set<string> {
  const config = skillConfigSchema.parse(pinnedConfig);
  if (!config.enabled) return new Set();
  return new Set(
    config.sources
      .find((entry) => entry.id === source)
      ?.skills.map((pin) => pin.id) ?? [],
  );
}

/** Only approved candidates reach the ranker, including an embedding service. */
export async function resolveSkills(
  pinnedConfig: SkillConfig,
  catalog: SkillCatalog,
  rank: (eligible: readonly SkillCandidate[]) => Promise<readonly number[]>,
): Promise<SkillResolution> {
  const config = skillConfigSchema.parse(pinnedConfig);
  const pinned = new Set(
    config.enabled
      ? config.sources.flatMap((source) => source.skills.map((pin) => pin.id))
      : [],
  );
  const eligible: SkillCandidate[] = [];
  const withheld: SkillResolution["withheld"] = [];
  const identities = new Set<string>();
  const ids = new Set<string>();
  // A reader may skip a skill's bytes only when the configuration pins no such id.
  // Checking that here keeps the decision with the resolver: a reader that skipped
  // a pinned skill would otherwise turn an eligible skill into a withheld one.
  for (const id of catalog.unpinned) {
    if (pinned.has(id))
      throw new Error("Skill catalog withheld a pinned skill unread");
    if (ids.has(id))
      throw new Error("Skill catalog contains a duplicate identity");
    ids.add(id);
    withheld.push({ id, reason: "out_of_scope" });
  }
  for (const raw of catalog.candidates) {
    const candidate = skillCandidateSchema.parse(raw);
    const identity = `${candidate.source}/${candidate.id}@${candidate.version}`;
    if (identities.has(identity) || ids.has(candidate.id))
      throw new Error("Skill catalog contains a duplicate identity");
    identities.add(identity);
    ids.add(candidate.id);
    const pin = config.enabled
      ? config.sources
          .find((source) => source.id === candidate.source)
          ?.skills.find(
            (entry) =>
              entry.id === candidate.id && entry.version === candidate.version,
          )
      : undefined;
    if (!pin) withheld.push({ id: candidate.id, reason: "out_of_scope" });
    else if (pin.digest !== candidate.digest)
      withheld.push({ id: candidate.id, reason: "unapproved_digest" });
    else eligible.push(candidate);
  }
  // One order whatever the reader read, so a preview does not shuffle when a
  // skill moves between the read and the unread half of the catalog.
  withheld.sort((a, b) => a.id.localeCompare(b.id));
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

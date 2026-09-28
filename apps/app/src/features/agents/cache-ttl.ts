// The cache TTL the findings job proposes for one agent (detector 3,
// ADR-208). The idle cache finding carries it as a recommendation on the
// `cache_ttl` setting, with the TTL the agent's writes used when they used
// one. The agent page reads it from the open findings (`list_findings`), the
// same read the Activity tab lists.
import type { SpendFinding, SpendFindings } from "@/data/contracts/spend";

/** The setting a TTL recommendation names; billing's `CACHE_TTL_SETTING`. */
const CACHE_TTL_SETTING = "cache_ttl";

/** The two TTLs the provider offers, as billing's `CacheTtl` spells them. */
type CacheTtl = "5m" | "1h";

/** One agent's TTL recommendation, with the finding that carries it. */
export type CacheTtlAdvice = {
  /** The finding's public id, for the link to its evidence. */
  findingId: string;
  /** The proposed TTL. */
  value: CacheTtl;
  /** The TTL every write used; null when the writes used both. */
  current: CacheTtl | null;
};

function ttlOf(value: unknown): CacheTtl | null {
  return value === "5m" || value === "1h" ? value : null;
}

/**
 * The recommendation of the newest open finding about this agent that names a
 * cache TTL. Null when the agent has no key, when no open finding names one,
 * or when the newest names a TTL this page does not know.
 */
export function cacheTtlOf(
  findings: SpendFindings,
  agentKey: string | null,
): CacheTtlAdvice | null {
  if (agentKey === null) return null;
  let newest: SpendFinding | null = null;
  for (const finding of findings.findings) {
    if (
      finding.level !== "agent" ||
      finding.subject !== agentKey ||
      finding.recommendation?.setting !== CACHE_TTL_SETTING
    )
      continue;
    // Parsed, since two instants may carry different fractions of a second.
    if (
      newest === null ||
      Date.parse(finding.window.to) > Date.parse(newest.window.to)
    )
      newest = finding;
  }
  if (newest === null) return null;
  const value = ttlOf(newest.recommendation?.value);
  if (value === null) return null;
  return {
    findingId: newest.id,
    value,
    current: ttlOf(newest.recommendation?.current),
  };
}

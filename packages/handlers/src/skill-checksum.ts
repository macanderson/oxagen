/**
 * skillBodyChecksum — SHA-256 hex over a skill version's raw body.
 *
 * The immutability contract for skill_versions rows, mirroring
 * agent_versions.checksum (computeConfigChecksum in agent.definition.publish):
 * a stored version can later be proven byte-identical to what ran. Stamped on
 * every INSERT into skill_versions (seed, install, create, upload/edit).
 */
import { createHash } from "node:crypto";

export function skillBodyChecksum(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

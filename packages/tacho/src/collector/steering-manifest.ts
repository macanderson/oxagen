/**
 * The body of the `steering.manifest` frame a session seals at its start
 * (ADR-093, ADR-144).
 *
 * The control plane assembles the workspace's steering into the bundle's
 * `context.system` and signs the assembler's manifest beside it as
 * `context.manifest`. The host cannot rank anything, and it does not try: it
 * seals that manifest into the session's chain as sealed evidence of what the
 * agent was shown at this boundary, names the bundle it came from, and appends
 * one included `steer` item per operator message it delivered beside the
 * prefix. So the frame says what the agent saw, and the `oxagen.context_digest`
 * attribute on the start event and `text_digest` here name the same bytes.
 */
import { budgetTokens } from "@contextgraphprotocol/typescript-sdk";
import type {
  PolicyBundle,
  SteeringManifest,
  SteeringManifestFrame,
  SteeringManifestItem,
} from "../wire";

/** One operator message the host delivered at this boundary. */
export interface DeliveredPrompt {
  id: string;
  text: string;
  command: "message" | "steer";
  /** When the operator issued it, or when it was delivered if the queue predates the field. */
  issuedAt: string;
}

export function steeringManifestFrame(
  manifest: SteeringManifest,
  bundle: Pick<PolicyBundle, "version" | "etag">,
  delivered: readonly DeliveredPrompt[],
): SteeringManifestFrame {
  const steers: SteeringManifestItem[] = delivered.map((prompt) => ({
    id: prompt.id,
    kind: "steer",
    force: "must",
    recorded_at: prompt.issuedAt,
    tokens: budgetTokens(prompt.text),
    outcome: "included",
  }));
  return {
    ...manifest,
    included: manifest.included + steers.length,
    items: [...manifest.items, ...steers],
    bundle_version: bundle.version,
    bundle_etag: bundle.etag,
  };
}

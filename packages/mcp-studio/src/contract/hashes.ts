// hashes.ts: the hashes and token counts a lock file and the manifest carry
// (mcp-studio-spec, Lock file).
//
// - upstream_hash: SHA-256 over the RFC 8785 form of the locked upstream.
// - definition_hash: SHA-256 over the RFC 8785 form of the effective name,
//   description, and input and output schemas. The classification, and so
//   the annotations derived from it, stay outside, so a reclassification
//   never makes a new tool version.
// - tokens: countTokens over the RFC 8785 form of the tools/list entry the
//   agent receives.
import { sha256Digest, type Sha256Digest } from "@oxagen/run-evidence";
import { countTokens } from "@oxagen/oxagen/steering-repo/tokens";
import type { UpstreamTool } from "../model/upstream-tool";
import { canonicalDigest, canonicalText } from "./json";
import type { EffectiveDefinition } from "./manifest";
import type { LockedMcpTool } from "./mcp-tool";

/** The fields definition_hash covers. */
export function definitionHashInput(
  definition: Pick<EffectiveDefinition, "name" | "description" | "inputSchema" | "outputSchema">,
): Pick<EffectiveDefinition, "name" | "description" | "inputSchema" | "outputSchema"> {
  const { name, description, inputSchema, outputSchema } = definition;
  return { name, description, inputSchema, outputSchema };
}

/** definition_hash for an effective definition. */
export function definitionHash(
  definition: Pick<EffectiveDefinition, "name" | "description" | "inputSchema" | "outputSchema">,
): Sha256Digest {
  return canonicalDigest(definitionHashInput(definition));
}

/** upstream_hash for a locked upstream: a tools/list entry, or an UpstreamTool. */
export function upstreamHash(upstream: LockedMcpTool | UpstreamTool): Sha256Digest {
  return canonicalDigest(upstream);
}

/** The tokens one definition costs on every request that lists it. */
export function definitionTokens(definition: EffectiveDefinition): number {
  return countTokens(canonicalText(definition));
}

/** document_hash: SHA-256 of a definition's bytes as committed. */
export function documentHash(bytes: Uint8Array | string): Sha256Digest {
  return sha256Digest(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes);
}

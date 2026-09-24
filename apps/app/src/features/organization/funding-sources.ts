// The three sources a model call can be funded from (ADR-053, ADR-131), in the
// order the design lists them, and which one the record names. A customer key
// that is stored and active is customer_key. Otherwise Oxagen pays, on the
// organization's minted key (platform_minted) or on the shared key (platform),
// and no capability tells the two apart yet (#4005), so the answer is null.
import type { ModelCredential } from "@/data/contracts/org";

export const FUNDING_SOURCES = [
  "platform_minted",
  "platform",
  "customer_key",
] as const;
export type FundingSource = (typeof FUNDING_SOURCES)[number];

/** The source the record names, or null when it cannot say which of Oxagen's keys pays. */
export function recordedSource(
  credential: ModelCredential,
): FundingSource | null {
  // A disabled credential is not in use: its turns run on Oxagen's key.
  return credential.configured && credential.status === "active"
    ? "customer_key"
    : null;
}

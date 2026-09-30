// @oxagen/done-record/attestation: the signed record of a done-record verdict,
// the key that signs it, and the README badge.
//
// A verdict change becomes an in-toto Statement v1 (statement.ts), signed as a
// DSSE envelope with Ed25519 (sign.ts). Oxagen publishes the public key
// (key.ts), so anyone can check an envelope without Oxagen.
export * from "./badge";
export * from "./dsse";
export * from "./key";
export * from "./sign";
export * from "./statement";

// The contract names a consumer of the attestation needs, so it can import this
// subpath alone. The package root also loads the schema file helpers.
export type { DoneOutcome, DoneReason } from "../decide";
export {
  DONE_CHECK_NAME,
  DONE_REASONS,
  DONE_RECORD_PREDICATE_TYPE,
  DONE_VERDICTS,
  type DoneReasonCode,
  type DoneVerdict,
  type WorkItemId,
} from "../types";

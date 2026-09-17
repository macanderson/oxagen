/**
 * Which enforcement tier a Tacho session ran under — the control plane's
 * verdict, never the producer's claim.
 *
 * ## The hole this closes
 *
 * `enforcement_tier` is the claim that an action was *enforced*. ADR-078 §5
 * is explicit about what the word buys: a `harness` record is
 * `client_attested` — a hook inside a process Oxagen does not own reported
 * what it did — while a `gateway` record is server-enforced, a call Oxagen
 * itself served and could refuse. Exports sign the tier and replay grading
 * reads it, so the difference is the difference between "an agent told us it
 * obeyed" and "we refused it".
 *
 * `ingest_tacho_events` is a *report from the machine*. Its envelope carries
 * an optional `agent.enforcement_tier`, and the ingest handler used to write
 * that field straight onto the session row. Anything that can reach the
 * ingest endpoint with the host key — which on an enrolled machine includes
 * every governed agent running there, since the local bearer and
 * `host.json` are on the same disk — could therefore mint a session whose
 * record says `gateway`, and every downstream surface, export and grade
 * would attribute enforcement that never happened. The hash chain does not
 * help: the producer computes it, so a forged tier seals into a perfectly
 * valid chain.
 *
 * ## The rule
 *
 * The tier of an ingested session is derived from server-owned state — the
 * host's policy mode, which only the control plane sets — and a
 * producer-supplied tier is honoured **only when it is lower** than the
 * derived one.
 *
 * Lowering is honest and must stay possible: a wrapped host in `enforce`
 * mode whose hooks were removed mid-session genuinely only observed, and
 * ADR-078 §401's honesty rule is that a surface never says "enforced" for a
 * session that was not. Raising is the forgery, and it fails closed.
 *
 * `gateway` is therefore unreachable through ingest, by construction and on
 * purpose. A gateway call is one the control plane served through the
 * `tacho_gateway_v1` key on the `invoke()` path; the tier for it is a fact
 * the server holds at the moment it serves the call, not something a machine
 * can report afterwards. Checking that the *host* merely possesses a gateway
 * credential would corroborate nothing — `host.json` holds that key too, so
 * the very adversary this guards against has one. When the gateway path
 * comes to stamp its own records, it stamps them server-side, at the call.
 */
import { ENFORCEMENT_TIERS } from "@oxagen/tacho";

export type TachoEnforcementTier = (typeof ENFORCEMENT_TIERS)[number];

/** Ordered weakest to strongest; a claim may only move down this list. */
const TIER_RANK: Readonly<Record<TachoEnforcementTier, number>> = {
  observe: 0,
  harness: 1,
  gateway: 2,
};

/**
 * The tier the control plane's own state implies for a session reported by
 * this host. `enforce` mode means the bundle told the hook to answer `deny`,
 * which is harness-level enforcement; anything else is observation.
 */
export function hostDerivedTier(
  mode: string | null | undefined,
): TachoEnforcementTier {
  return mode === "enforce" ? "harness" : "observe";
}

/**
 * The tier to record for an ingested session: the host-derived tier, unless
 * the producer claimed a strictly weaker one, in which case the weaker claim
 * is taken at its word.
 */
export function resolveIngestedTier(
  mode: string | null | undefined,
  claimed: string | null | undefined,
): TachoEnforcementTier {
  const derived = hostDerivedTier(mode);
  if (typeof claimed !== "string") return derived;
  const claimedRank = TIER_RANK[claimed as TachoEnforcementTier];
  if (claimedRank === undefined) return derived;
  return claimedRank < TIER_RANK[derived]
    ? (claimed as TachoEnforcementTier)
    : derived;
}

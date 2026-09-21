/**
 * Whether `rotate_api_key` will replace a key — the whole answer, in one place.
 *
 * Two different things disqualify a key, and both have to live here, because
 * the answer is given twice for two audiences and a drift between them is the
 * same defect either way:
 *
 *   - `rotate_api_key` refuses, which is the guarantee. It is reachable from
 *     the API and MCP as well as the app, so a surface-side check is a courtesy
 *     and never the enforcement.
 *   - `list_api_keys` reports `rotatable`, so a page does not offer a control
 *     that can only fail.
 *
 * The reasons — three about the key, one about the workspace it lives in:
 *
 *   - **A server-owned scope purpose.** A key minted by an enrollment or a
 *     login flow carries a reserved `purpose`, and the service that issued it
 *     owns its lifecycle (`rotate_agent_credential`, an operator enrollment,
 *     `oxagen login`). `create_api_key` refuses to mint one for the same
 *     reason — a caller must not self-assert an enrolment.
 *   - **Revocation.** `list_api_keys` includes revoked rows so the roster can
 *     show them; `rotate_api_key` filters them out and answers not-found.
 *   - **An expiry that has passed.** `rotate_api_key` gives the replacement the
 *     rotated key's `expires_at`, so rotating an expired key revokes a key in
 *     the same transaction and mints one that is already expired, spending the
 *     one display of a secret nobody can use. The row is still there —
 *     `deleted_at` is null — so the not-found guard does not catch it.
 *   - **An archived workspace** (`archivalRefusalFor`). A rotation mints fresh
 *     secret material, which is the thing archival exists to stop, so
 *     `rotate_api_key` refuses one whatever the key. This arrived late: the
 *     read model answered `rotatable` without it, and so advertised a rotation
 *     that could only fail on every surface except the app — which was right
 *     only because `key-row.tsx` carries a separate `archived` prop.
 *
 * The clock is passed in rather than read here, so the caller decides which
 * instant it is judging against and a test does not depend on the clock the
 * suite runs on.
 */
import { requestsReservedLedgerRunPurpose } from "@oxagen/oxagen/ledger-run-token";
import { requestsReservedCliSessionPurpose } from "@oxagen/oxagen/cli-session";
import { requestsReservedAgentCredentialPurpose } from "@oxagen/oxagen/agent-credential";
import { requestsReservedStellaTelemetryPurpose } from "./stella-telemetry-enrollment";
import {
  requestsReservedTachoGatewayPurpose,
  requestsReservedTachoPurpose,
} from "./tacho-enrollment";

/** The fields of an api_keys row that decide whether it may be rotated. */
export interface RotationCandidate {
  readonly scope: unknown;
  readonly expiresAt: Date | null;
  /** `deleted_at`. Null for a key that is still live. */
  readonly revokedAt: Date | null;
}

/**
 * The workspace a rotation would mint the replacement into.
 *
 * Archival is a property of the workspace rather than of the key, so it is a
 * second argument rather than a field of the candidate — but it decides
 * rotatability just as much, and it has to be answered in this file for the
 * same reason the rest is: `rotate_api_key` refuses an archived workspace
 * unconditionally, so a read model that does not know about archival advertises
 * a rotation that can only fail. The app happened to be right about this
 * because `key-row.tsx` has its own `archived` prop; the API and MCP have only
 * `rotatable`, and it lied to them.
 */
export interface RotationWorkspace {
  readonly name: string;
  /** `archived_at`. Null for a workspace still in use. */
  readonly archivedAt: Date | null;
}

/**
 * Why a rotation is refused. `denied` is an authorization answer — this key is
 * not yours to rotate; `conflict` is a state answer — this key is finished.
 */
export type RotationRefusal = AuthzRefusal | StateRefusal;

/** "This key is not yours to rotate." */
export interface AuthzRefusal {
  readonly kind: "denied";
  readonly log: string;
  readonly denial: string;
}

/**
 * "This key, or the workspace holding it, is finished."
 *
 * Named separately so a producer that can only ever give a state answer — such
 * as `archivalRefusalFor` — says so in its return type. The alternative is a
 * caller writing `if (refusal.kind !== "denied")` to narrow, which reads as a
 * guard but behaves as a silent fall-through the day that assumption breaks.
 */
export interface StateRefusal {
  readonly kind: "conflict" | "not_found";
  readonly log: string;
  readonly reason: string;
  readonly message: string;
}

interface ReservedPurpose {
  readonly matches: (scope: unknown) => boolean;
  readonly log: string;
  readonly denial: string;
}

const RESERVED_PURPOSES: readonly ReservedPurpose[] = [
  {
    matches: requestsReservedLedgerRunPurpose,
    log: "api.key.rotate: reserved ledger run credential",
    denial: "Run credentials refresh through evidence ingress",
  },
  {
    matches: requestsReservedTachoPurpose,
    log: "api.key.rotate: rejected — reserved Tacho host purpose",
    denial: "Forbidden: enrolled Tacho host keys require operator rotation",
  },
  {
    // The gateway key (ADR-078), refused here and not before this PR.
    //
    // Rotating it through this capability hands the operator a fresh secret
    // with nowhere to put it: the daemon reads the gateway credential from its
    // enrollment record, so a key rotated out from under it leaves the local
    // gateway serving nothing and the operator holding a string. What someone
    // reaching for this actually wants — a fresh gateway credential on a
    // working host — is revoke_tacho_enrollment followed by re-enrolling, and
    // that path only became whole in this change: retireEnrollmentKeys now
    // selects `purpose IN (tacho_host_v1, tacho_gateway_v1)`, so revoking the
    // enrollment retires this key rather than stranding it live.
    //
    // A separate predicate, deliberately: widening requestsReservedTachoPurpose
    // would change what every caller of it refuses, on reasoning
    // api.key.revoke's header rejects.
    matches: requestsReservedTachoGatewayPurpose,
    log: "api.key.rotate: rejected — reserved Tacho gateway purpose",
    denial:
      "Forbidden: the local MCP gateway key belongs to a Tacho enrollment; a fresh one comes from revoke_tacho_enrollment and re-enrolling the host, which is also what re-points the daemon at it",
  },
  {
    matches: requestsReservedAgentCredentialPurpose,
    log: "api.key.rotate: rejected — reserved agent credential purpose",
    denial:
      "Forbidden: agent credentials rotate through rotate_agent_credential",
  },
  {
    matches: requestsReservedStellaTelemetryPurpose,
    log: "api.key.rotate: rejected — reserved Stella telemetry purpose",
    denial:
      "Forbidden: enrolled Stella telemetry keys require operator rotation",
  },
  {
    matches: requestsReservedCliSessionPurpose,
    log: "api.key.rotate: rejected — reserved CLI session purpose",
    denial: "Forbidden: a CLI session key is replaced by `oxagen login`",
  },
];

/** The refusal `rotate_api_key` owes this key at `now`, or null when it may be rotated. */
export function rotationRefusalFor(
  key: RotationCandidate,
  now: number,
): RotationRefusal | null {
  const reserved = RESERVED_PURPOSES.find((p) => p.matches(key.scope));
  if (reserved) {
    return { kind: "denied", log: reserved.log, denial: reserved.denial };
  }
  // Revocation is the third reason, and it is why this predicate takes the
  // whole row rather than a scope and an expiry. `list_api_keys` deliberately
  // returns revoked keys so the roster can show them, and `rotate_api_key`
  // filters `deleted_at IS NULL` and answers not-found — it cannot tell a
  // revoked key from an absent one, and neither can this. Without it the read
  // model advertised a rotation that could only fail.
  if (key.revokedAt !== null) {
    return {
      kind: "not_found",
      log: "api.key.rotate: rejected — the key is already revoked",
      reason: "api_key_not_found",
      message:
        "Not found: API key does not exist, is not in this org, or is already revoked",
    };
  }
  if (key.expiresAt !== null && key.expiresAt.getTime() <= now) {
    return {
      kind: "conflict",
      log: "api.key.rotate: rejected — the key has expired",
      reason: "api_key_expired",
      message:
        "Conflict: this key has expired, and a rotation would copy the expiry that ended it onto the replacement. Create a new key instead.",
    };
  }
  return null;
}

/**
 * The refusal `rotate_api_key` owes the workspace a replacement would land in,
 * or null when that workspace is still in use.
 *
 * Separate from `rotationRefusalFor` because the two are established at
 * different moments and under different locks: the key's own disqualifiers come
 * off a row the handler has already read, while archival is only trustworthy
 * once the workspace row is locked (`.for("update")`), which is what stops an
 * `archive_workspace` committing between the check and the write.
 *
 * Ranked after the key's own reasons by every caller, so an expired or
 * service-owned key in an archived workspace still answers with the reason that
 * is about the key.
 */
export function archivalRefusalFor(
  workspace: RotationWorkspace,
): StateRefusal | null {
  if (workspace.archivedAt === null) return null;
  return {
    kind: "conflict",
    log: "api.key.rotate: rejected — the workspace is archived",
    reason: "workspace_archived",
    message: `${workspace.name} was archived on ${workspace.archivedAt.toISOString()}; a key cannot be rotated in an archived workspace`,
  };
}

/**
 * Whether `rotate_api_key` will replace this key at `now`, in this workspace.
 *
 * The reasons are every reason that is a property of the key or of the
 * workspace it lives in. The rest are properties of the actor — no principal,
 * no org, the org role — and `list_api_keys` is gated on the same role in the
 * same place, so a caller who can read the roster can rotate what the roster
 * says is rotatable.
 *
 * `workspace` is required rather than optional on purpose. It was added because
 * `list_api_keys` reported `rotatable: true` for a live key in an archived
 * workspace that `rotate_api_key` refuses unconditionally; making it required
 * means the compiler, not a reviewer, is what stops a caller answering this
 * question without archival in hand.
 *
 * `revoke_api_key` is unaffected by all of it: it ends a key whatever its
 * purpose, whatever its expiry, and whatever its workspace.
 */
export function isRotatableKey(
  key: RotationCandidate,
  now: number,
  workspace: RotationWorkspace,
): boolean {
  return (
    rotationRefusalFor(key, now) === null &&
    archivalRefusalFor(workspace) === null
  );
}

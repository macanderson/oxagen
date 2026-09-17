/**
 * What a machine-bound API key is allowed to invoke.
 *
 * ## The hole this closes
 *
 * An API key principal carries no `org_users` row, so `assertCallerRole`
 * returns early for one (`packages/handlers/src/lib/capability-role-guard.ts`)
 * and every role gate passes. Its docblock says the authority of such a key
 * "is the `scope` column on `auth.api_keys` … enforced at the auth layer."
 * That was true of nothing: `resolveApiKey` does not read `scope`, and
 * `checkIAM`'s tier fast-path allows every non-enterprise org outright, so a
 * key minted for one narrow machine job could invoke **any** capability on
 * any surface it could reach.
 *
 * That is load-bearing for Tacho. Enrollment mints the host key with
 * `scope.purpose = "tacho_host_v1"` and records the enrolling Owner/Admin as
 * its creator. With ADR-078's local MCP gateway, that key is what a connected
 * app's tool calls are forwarded with — so a connected desktop app held owner
 * authority over the workspace and could call MCP-only operations such as
 * `set_model_credential`, whose handlers accept `userId: null`. The mandate
 * the product is built on was decoration.
 *
 * This module is the enforcement the docblock promised: a key whose scope
 * names a purpose may invoke only what that purpose is for, and nothing else.
 *
 * ## Why here
 *
 * In `bootstrap.ts`'s adapter, **before** `checkIAM`, so it is:
 *
 *   - unconditional — it runs for every org tier, ahead of the fast-path that
 *     allows non-enterprise orgs without consulting IAM at all;
 *   - unforgettable — one gate on the single `invoke()` path, rather than a
 *     guard each handler has to remember (the pattern that produced this bug);
 *   - fail-closed — a purpose with no entry here is allowed nothing, so a
 *     machine credential added later is refused until somebody says what it is
 *     for.
 *
 * It constrains machine keys only. A key with no `purpose` is what
 * `oxagen login` mints for a person, and it keeps acting for its creator
 * exactly as before. `cli_session_v1` (`CLI_SESSION_SCOPE_PURPOSE`) carries a
 * purpose too, but it is not a machine credential: `resolveApiKey`
 * (`packages/auth/src/resolvers/api-key.ts`) resolves it to the *person* who
 * approved the `oxagen login` flow — re-checking their org/workspace
 * membership on every call — and treats every other purpose as a bare
 * machine key with `userId: null`. Before this exemption existed, every CLI
 * session key fell into the "unrecognised purpose" branch below and was
 * denied every capability, which broke `oxagen login`'s org/workspace picker
 * outright.
 */
import { CLI_SESSION_SCOPE_PURPOSE } from "@oxagen/auth/cli-auth";
import {
  hasColumn,
  HOST_GATEWAY_COLUMN,
  planeKeyFor,
  schema,
  withOrgPlaneSystemDb,
  withSystemDb,
} from "@oxagen/database";
import { getCapability, listCapabilities } from "@oxagen/oxagen";
import { and, eq, isNull } from "drizzle-orm";

/** The scope purpose Tacho enrollment mints the host's control-plane key with. */
export const TACHO_HOST_PURPOSE = "tacho_host_v1";

/** The scope purpose for the key the local MCP gateway serves tools with. */
export const TACHO_GATEWAY_PURPOSE = "tacho_gateway_v1";

/** The scope purpose a Stella operational-telemetry install is enrolled with. */
export const STELLA_TELEMETRY_PURPOSE = "stella_operational_telemetry_v1";

/**
 * Exactly what each machine purpose may invoke.
 *
 * These are enumerated, not derived, because a machine credential's job is
 * known when it is minted and should not silently widen when a capability is
 * added elsewhere. `tacho_gateway_v1` is the exception and is described below.
 */
export const MACHINE_KEY_CAPABILITIES: Readonly<
  Record<string, ReadonlySet<string>>
> = {
  // The three calls `createControlClient` makes, and nothing else. A host
  // reports events, fetches its mandate, and polls for commands; it does not
  // enroll, revoke, or read the fleet.
  [TACHO_HOST_PURPOSE]: new Set([
    "ingest_tacho_events",
    "get_tacho_bundle",
    "fetch_tacho_commands",
  ]),
  [STELLA_TELEMETRY_PURPOSE]: new Set(["ingest_stella_operational_telemetry"]),
};

/**
 * `tacho_gateway_v1` is the one purpose whose allowance is a rule rather than
 * a list, because the whole point of the connected tier is to serve the
 * workspace's toolbelt — a set that grows — and a hand-maintained list would
 * drift into either uselessness or over-grant.
 *
 * The rule is the mandate, stated once:
 *
 *   - the capability is exposed on `mcp`, so it is something a tool client is
 *     meant to call at all;
 *   - it does not mutate, so a connected app cannot change the workspace;
 *   - it is not high-sensitivity, so the read-only carve-out cannot be used to
 *     read secrets, credentials or audit material.
 *
 * Anything outside that is a deliberate mandate change, not an accident of
 * which contracts happen to exist. This is narrower than what a *wrapped*
 * agent may do, and deliberately so: a connected app has no hook, so a call it
 * makes is the only thing Oxagen sees of it.
 */
export function gatewayMayInvoke(capabilityName: string): boolean {
  const capability = getCapability(capabilityName);
  if (capability === undefined) return false;
  const surfaces: readonly string[] = capability.surfaces ?? ["api", "mcp"];
  if (!surfaces.includes("mcp")) return false;
  if (capability.mutates !== false) return false;
  return capability.sensitivity !== "high";
}

/**
 * Every capability the gateway mandate permits, as the local MCP gateway needs
 * it: a list, sorted, of what `gatewayMayInvoke` answers yes to.
 *
 * The rule stays here and is evaluated here. The host cannot run it —
 * `@oxagen/tacho` takes no `@oxagen/*` runtime dependency (ADR-078 §4), so it
 * has no way to read a capability's surfaces, mutation or sensitivity, and a
 * second copy of the rule living in the collector is precisely the drift that
 * constraint exists to prevent. The control plane signs the answer into the
 * policy bundle's `gateway_tools`, and the gateway filters its `tools/list`
 * against it. `machineKeyDenial` remains the enforcement; this is what stops
 * the app being shown tools that enforcement can only refuse.
 *
 * Sorted so the bundle's etag is stable across processes: registration order
 * depends on import order, and an etag that moved on every restart would make
 * every host refetch a mandate that had not changed.
 *
 * **`undefined` and `[]` are different answers, and the difference is the
 * control.** `[]` is a mandate: the rule ran over a registry that exists and
 * permitted nothing, so the gateway serves nothing. `undefined` is the
 * absence of an answer: the registry is empty, which never means "no
 * capability qualifies" — it means no contract has been imported into this
 * process yet, and a mandate derived from that would take a healthy fleet's
 * toolbelt to zero. So the two are returned as different values rather than
 * collapsed into one empty list, and the caller that puts this on the wire
 * omits the field only for `undefined`. Encoding "permits nothing" as absence
 * would be a fail-open: absence on this wire means *not told*, and the gateway
 * answers *not told* by serving the upstream list unfiltered.
 */
export function gatewayMandateTools(): string[] | undefined {
  const capabilities = listCapabilities();
  // An empty registry is an uninitialised process, not a policy decision.
  if (capabilities.length === 0) return undefined;
  return capabilities
    .map((capability) => capability.name)
    .filter((name) => gatewayMayInvoke(name))
    .sort();
}

/** What the gate was asked about. */
export interface MachineKeyCheck {
  orgId: string;
  apiKeyId: string | null | undefined;
  capabilityName: string;
  /**
   * The person this credential resolved to, if the surface kept it.
   *
   * Required for the `cli_session_v1` exemption below and for nothing else.
   * The exemption is sound only because `resolveApiKey` resolved the key to
   * its creator and re-checked their membership; a surface that threw that
   * identity away has not earned it. Passing the value in rather than
   * assuming it means the claim is checked at the point it is relied on.
   */
  userId: string | null | undefined;
}

/**
 * What reading a key's scope found.
 *
 * `missing` and `personal` are kept apart on purpose. They used to be the same
 * `undefined`, and that conflation was a hole: `resolveApiKey` and this gate
 * are two separate reads, so a key soft-deleted between them — which is exactly
 * what revocation does — vanished here and was read as a key that simply has no
 * purpose, i.e. a person's key acting for its creator. On a non-enterprise org
 * `checkIAM`'s tier fast-path then allows the capability outright, so a host key
 * racing its own revocation got one unrestricted invocation outside its mandate.
 *
 * A row this gate cannot see is not a row it may reason about.
 */
export type KeyScope =
  | { kind: "missing" }
  | { kind: "personal" }
  | {
      kind: "purpose";
      purpose: string;
      /**
       * The host this credential was minted for, when its scope names one.
       * Enrollment writes it (`lib/tacho-host-enroll.ts`) and
       * `api.key.create` refuses a caller-supplied reserved purpose, so a
       * purposed key's host id is the server's own record of which host the
       * credential belongs to.
       */
      hostEnrollmentId?: string;
    };

/**
 * The scope purpose on a key. `withSystemDb` because this runs inside the
 * kernel's IAM adapter, which is identity resolution: the answer decides
 * whether the caller may touch the tenant at all.
 *
 * `withSystemDb` also means RLS is not what hides a row here: a key absent from
 * this read is deleted, expired out of the org, or never existed.
 */
export async function readKeyScope(
  orgId: string,
  apiKeyId: string,
): Promise<KeyScope> {
  const key = await withSystemDb((tx) =>
    tx.query.apiKeys.findFirst({
      where: and(
        eq(schema.apiKeys.id, apiKeyId),
        eq(schema.apiKeys.orgId, orgId),
        isNull(schema.apiKeys.deletedAt),
      ),
      columns: { scope: true },
    }),
  );
  if (key === undefined) return { kind: "missing" };
  const scope = key.scope;
  if (scope === null || typeof scope !== "object") return { kind: "personal" };
  const purpose = (scope as { purpose?: unknown }).purpose;
  if (typeof purpose !== "string") return { kind: "personal" };
  const host = (scope as { host_enrollment_id?: unknown }).host_enrollment_id;
  return typeof host === "string"
    ? { kind: "purpose", purpose, hostEnrollmentId: host }
    : { kind: "purpose", purpose };
}

/**
 * Stamp the host's `gateway_last_seen_at` — the server's record that it
 * authorised a call on this host's gateway credential.
 *
 * Separate from the tier it feeds so the two can be reasoned about apart: this
 * function only ever records what happened, and `tacho.events.ingest` only ever
 * reads it. Nothing the submitter sends reaches either.
 *
 * Why the observation has to be the server's own (discussion_r4036718127, P1).
 * The tier used to be read off `oxagen.enforcement_tier` on the submitted
 * batch. `normalizeOtlp` kept unknown attributes verbatim, so anything holding
 * a host's local OTLP bearer could put that key on an ordinary record; the
 * daemon sealed it onto a chain that verifies and ingest promoted the session.
 * The seal proved the record was not altered after collection and nothing at
 * all about whether the value was true going in — a valid chain over a false
 * input is byte-for-byte a valid chain. Here the platform is not told: it
 * authenticated a server-minted, per-host `tacho_gateway_v1` credential and is
 * about to serve the call itself.
 *
 * A key whose scope names no host cannot be attributed to one, and is left
 * unrecorded rather than guessed at — an unattributable observation is not
 * evidence about any particular session.
 */
async function recordGatewayInvocation(
  orgId: string,
  hostEnrollmentId: string | undefined,
): Promise<void> {
  if (!hostEnrollmentId) return;
  // The ORGANISATION'S plane, not the shared one. `tacho.hosts` is tenant data
  // — every other path reads it through `withTenantDb` — so on a dedicated
  // plane a `withSystemDb` update matches no row and reports success, the
  // observation never arrives, and genuine connected-app sessions stay
  // classified `observe` for good (discussion_r4040617216). RLS is bypassed
  // because this runs at authorisation time, before any handler scope exists.
  const planeKey = await planeKeyFor(orgId);
  await withOrgPlaneSystemDb(orgId, async (tx) => {
    // Ask before writing. Production applies migrations by hand after the
    // deploy (#1275), so between the two this statement names a column the
    // database does not have; 42703 would abort the transaction and turn a
    // missing observation into a FAILED gateway call, denying traffic this
    // function only meant to take a note about (discussion_r4040352870).
    if (!(await hasColumn(tx, HOST_GATEWAY_COLUMN, planeKey))) return;
    await tx
      .update(schema.tachoHosts)
      .set({ gatewayLastSeenAt: new Date() })
      .where(
        and(
          eq(schema.tachoHosts.orgId, orgId),
          eq(schema.tachoHosts.publicId, hostEnrollmentId),
        ),
      );
  });
}

/**
 * Why this machine key may not invoke this capability, or undefined when it
 * may — or when the caller is not a machine key at all.
 *
 * The message names the purpose and the capability, because the operator who
 * sees it in a connected app has no other way to tell a mandate refusal from a
 * bug.
 */
export async function machineKeyDenial(
  check: MachineKeyCheck,
): Promise<string | undefined> {
  const { apiKeyId, orgId, capabilityName, userId } = check;
  if (!apiKeyId || !orgId) return undefined;

  const scope = await readKeyScope(orgId, apiKeyId);

  // The key is gone between `resolveApiKey` and here — a revocation landing
  // mid-request is the ordinary way that happens. Deny rather than fall through
  // to the personal-key path, which on a non-enterprise org allows everything.
  if (scope.kind === "missing") {
    return `Forbidden: this credential is no longer valid, so it may not invoke ${capabilityName}.`;
  }

  // No purpose: a person's key, acting for its creator. Unchanged.
  if (scope.kind === "personal") return undefined;

  const { purpose } = scope;

  // A CLI session key also acts for a person — its creator, whose org and
  // workspace membership `resolveApiKey` re-checks on every call — so it is
  // not a machine credential and not subject to a machine mandate. Without
  // this branch it reaches the unrecognised-purpose denial below and is
  // refused EVERY capability, which breaks `oxagen login` outright.
  //
  // The exemption is CONDITIONAL ON THE CALLER ACTUALLY CARRYING THAT PERSON,
  // because the reasoning above is a claim about identity and the claim has to
  // be true where it is used (discussion_r4041282083, P1). `apps/api` keeps
  // `resolution.userId`; `apps/mcp/src/context.ts` hard-codes `userId: null`
  // and discards it. On that surface an unconditional exemption is an
  // escalation, not a restoration: the key passes this gate, the
  // non-enterprise tier fast-path allows it, and `assertCallerRole` sees no
  // user and skips the role check — so a plain member reaches Owner/Admin-only
  // capabilities like `reveal_secret`. Denying instead is fail-closed and
  // costs only MCP access for CLI keys, which is already broken today.
  //
  // This exemption has been lost to a merge twice: #3222 added it, and #3178 —
  // branched before #3222 landed — took its own older copy of this file whole
  // and reverted it. The test file kept its unused CLI_SESSION_SCOPE_PURPOSE
  // import, so nothing went red. The tests in machine-key-scope.test.ts make a
  // third loss, and any future surface that drops the creator, fail loudly.
  if (purpose === CLI_SESSION_SCOPE_PURPOSE) {
    return userId
      ? undefined
      : `Forbidden: a CLI session key acts for the person who created it, and this surface resolved no such person, so it may not invoke ${capabilityName}.`;
  }

  if (purpose === TACHO_GATEWAY_PURPOSE) {
    // The observation the enforcement tier is derived from.
    //
    // This is the only place the control plane KNOWS a gateway call happened:
    // it authenticated the credential and is deciding the call. The tier used
    // to be read off an attribute on the submitted batch instead, which a
    // harness can set — OTLP attributes pass through the normalizer verbatim
    // and the daemon seals whatever it is handed, so the signature proved the
    // record was not altered after collection and nothing at all about whether
    // the value was true going in. Ingest now reads this column.
    //
    // Recorded BEFORE the mandate check, so a refusal is recorded too
    // (discussion_r4040685657). An earlier version stamped only the allowed
    // path, reasoning that a refused call is not a call Oxagen served and must
    // not raise a tier. That guarded the wrong thing. What must not raise a
    // tier is a CLIENT-ATTESTED claim; this is the server's own record that it
    // authenticated this host's gateway credential and ruled on the request.
    // A refusal is not weaker evidence of enforcement than a success — it is
    // the strongest there is, the case where Oxagen actually stopped
    // something, and it is exactly what the operator needs the session to be
    // able to show. Leaving it out meant a connected app whose first call was
    // outside the mandate produced a `-32002` the daemon filed as a gateway
    // `policy_decision` while the chain stayed `observe`, so the evidence
    // could not report the prevention that was the whole point.
    //
    // Awaited rather than fired and forgotten: a call this write did not
    // record is a call the tier will not reflect, and silently under-reporting
    // enforcement is the failure this whole path exists to end. It is one
    // indexed UPDATE by public id.
    await recordGatewayInvocation(orgId, scope.hostEnrollmentId);
    if (!gatewayMayInvoke(capabilityName)) {
      return `Forbidden: ${capabilityName} is outside this agent's mandate. A connected app may call read-only, non-sensitive workspace tools through the Oxagen gateway; changing that is a mandate change, made in Oxagen.`;
    }
    return undefined;
  }

  const allowed = MACHINE_KEY_CAPABILITIES[purpose];
  // An unrecognised purpose is allowed nothing. A machine credential this
  // build has never heard of is not a credential it can reason about.
  if (allowed === undefined) {
    return `Forbidden: this credential is bound to ${purpose}, which this deployment does not recognise, so it may not invoke ${capabilityName}.`;
  }
  return allowed.has(capabilityName)
    ? undefined
    : `Forbidden: this credential is bound to ${purpose} and may not invoke ${capabilityName}.`;
}

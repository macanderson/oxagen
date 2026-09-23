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
 * ## What it does not constrain
 *
 * It constrains machine keys only, and there are two kinds of key it lets
 * past.
 *
 * A key with **no `purpose`** is a plain org API key. It has always acted for
 * whoever holds it, under whatever role gate the handler runs, and this gate
 * leaves it exactly as it was. (It is no longer what `oxagen login` mints —
 * that changed in #2997, and the sentence that used to say otherwise here is
 * the belief this module's CLI-session bug was built on.)
 *
 * A key carrying **`cli_session_v1`** (`CLI_SESSION_SCOPE_PURPOSE`) is a
 * person's terminal session. `resolveApiKey`
 * (`packages/auth/src/resolvers/api-key.ts`) resolves it to the user who
 * approved the `oxagen login` flow, re-checking that user's org and workspace
 * membership on every call, and resolves every other key to `userId: null`.
 * So it is a person's credential — but only on a surface that took that
 * answer. `apps/mcp` discarded it, and a surface that discards it hands this
 * gate a credential with a person's exemption and no person: the handler role
 * gate (`assertCallerRole`) short-circuits on a context with no `userId`, and
 * on a non-enterprise org it is the only role gate that runs.
 *
 * The exemption is therefore conditional on the caller: `userId` is part of
 * the question, and a CLI session key presented with no resolved person is
 * **denied**, not exempted. That makes the paragraph above true by
 * construction rather than by the continued good behaviour of a file in
 * another package.
 *
 * The exemption has been lost once already — #3222 added it, and #3178's
 * squash, whose branch predated that merge, overwrote this file without it
 * while keeping the paragraph that describes it, so `oxagen login`'s
 * org/workspace picker was denied outright again. The tests below pin the
 * behaviour rather than the prose.
 */
import { LEDGER_RUN_SCOPE_PURPOSE } from "@oxagen/oxagen/ledger-run-token";
import { CLI_SESSION_SCOPE_PURPOSE } from "@oxagen/oxagen/cli-session";
import {
  ambientPlaneKey,
  GATEWAY_CHAIN_COLUMN,
  hasColumnFresh,
  HOST_GATEWAY_COLUMN,
  schema,
  withOrgPlaneSystemDb,
  withSystemDb,
} from "@oxagen/database";
import { getCapability, listCapabilities } from "@oxagen/oxagen";
import { and, eq, isNull, sql } from "drizzle-orm";

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
  // The enrolled daemon's four control calls, and nothing else. A host
  // reports events, fetches its mandate, polls for commands, and asks for a
  // repository-scoped git credential (ADR-151); it does not
  // enroll, revoke, or read the fleet. The command poll is `fetch_commands`
  // since ADR-025 renamed it from `fetch_tacho_commands`; this list kept the
  // old name, so every host's poll was refused and a pause or revoke never
  // reached a running agent. machine-key-scope.test.ts now checks these names
  // against the contracts themselves.
  [TACHO_HOST_PURPOSE]: new Set([
    "ingest_tacho_events",
    "get_tacho_bundle",
    "fetch_commands",
    // ADR-151: the git credential a wrapped run pushes with. Refused unless
    // the repository is bound to the host's workspace.
    "create_github_token",
  ]),
  [LEDGER_RUN_SCOPE_PURPOSE]: new Set(["ingest_run_frames"]),
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
   * The person this surface resolved the credential to, or null when it
   * resolved none.
   *
   * Required rather than optional so that adding a surface is a compile error
   * until it answers the question. A surface that cannot answer it has not
   * resolved a person, and `null` is the honest answer — which this gate reads
   * as "not a person's credential" for the one purpose whose exemption depends
   * on there being one.
   */
  userId: string | null | undefined;
  /**
   * The Tacho daemon chain a local MCP gateway is serving, as it named the
   * chain on the request (#3221).
   *
   * Read back only when the key's scope purpose is `tacho_gateway_v1`. On any
   * other credential it is carried here and dropped, because a value that
   * attests a gateway call means nothing on a credential that is not one.
   * It never reaches the denial decision — see `machineKeyDenial`.
   */
  gatewaySessionUuid?: string | null;
  /**
   * The genesis hash of that chain, which is what makes the id above evidence
   * rather than a name a forger could also write (#3221). Read back on the
   * same one credential and under the same rules.
   */
  gatewayChainGenesisHash?: string | null;
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
  chainSessionUuid: string | null,
  chainGenesisHash: string | null,
): Promise<void> {
  if (!hostEnrollmentId) return;
  // The ORGANISATION'S plane, not the shared one. `tacho.hosts` is tenant data
  // — every other path reads it through `withTenantDb` — so on a dedicated
  // plane a `withSystemDb` update matches no row and reports success, the
  // observation never arrives, and genuine connected-app sessions stay
  // classified `observe` for good (discussion_r4040617216). RLS is bypassed
  // because this runs at authorisation time, before any handler scope exists.
  await withOrgPlaneSystemDb(orgId, async (tx) => {
    // The plane the transaction was actually opened on, published by
    // `withOrgPlaneSystemDb` itself. This used to call `planeKeyFor(orgId)`
    // just above — a SECOND resolution of the same question, which can
    // disagree with the first if the organisation is repointed in between, and
    // then files the answer under a database the statement did not run on
    // (#3223).
    const planeKey = await ambientPlaneKey();
    // Ask before writing. Production applies migrations by hand after the
    // deploy (#1275), so between the two these statements name a column — and
    // a whole TABLE — the database does not have; 42703 and 42P01 both abort
    // the transaction, which would turn a missing observation into a FAILED
    // gateway call, denying traffic this function only meant to take a note
    // about (discussion_r4040352870). Probed separately rather than inferred
    // from one another: they ship in different migrations and either can be
    // the one still pending.
    // A cached miss cannot suppress this permanent observation after migration.
    const hostColumn = await hasColumnFresh(tx, HOST_GATEWAY_COLUMN, planeKey);
    const chains = await hasColumnFresh(tx, GATEWAY_CHAIN_COLUMN, planeKey);
    if (!hostColumn && !chains) return;

    // The host row, read once and by the server's own attribution: the public
    // id comes from the KEY'S scope, never from the request. An invocation
    // filed against a host the caller named would be the defect this whole
    // path exists to close, one layer down.
    const host = await tx.query.tachoHosts.findFirst({
      where: and(
        eq(schema.tachoHosts.orgId, orgId),
        eq(schema.tachoHosts.publicId, hostEnrollmentId),
      ),
      // Named, so a column the pending migration adds cannot join this read
      // and raise 42703 for a column it does not want
      // (discussion_r4040558842's failure, in this package).
      columns: { id: true, orgId: true, workspaceId: true },
    });
    if (host === undefined) return;

    if (hostColumn) {
      await tx
        .update(schema.tachoHosts)
        .set({ gatewayLastSeenAt: new Date() })
        .where(eq(schema.tachoHosts.id, host.id));
    }

    // The correlation (#3221). Without a chain id there is nothing to
    // correlate, and a row naming no chain is not evidence about any session —
    // so none is written, and the host observation above stands alone exactly
    // as it did before. That is the honest degradation: a daemon too old to
    // send the header keeps its sessions on the host's own mode rather than
    // being promoted on a correlation nobody made.
    //
    // UPSERT, one row per (host, chain) rather than one per call. A row per
    // call would be an append-only audit stream growing with gateway traffic
    // inside the transactional database, which is what AGENTS.md's storage
    // table assigns to ClickHouse. Nothing is lost: the per-call history is
    // already there and is richer — `recordGatewayCall` seals a `tool_call` or
    // `policy_decision` carrying the tool, the connected app and the outcome
    // onto this very chain, and ingest writes it through `insertTachoEvents`.
    // Postgres holds only the bounded fact ingest has to read inside a
    // transaction: this host's gateway served this chain, most recently then.
    //
    // A refusal advances `lastSeenAt` exactly as a success does. `outcome` is
    // still computed above because it is what the caller is told; it is not
    // stored here, because a call Oxagen stopped is evidence that Oxagen was
    // enforcing, which is the only thing the tier asks.
    if (chains && chainSessionUuid !== null) {
      const at = new Date();
      await tx
        .insert(schema.tachoGatewayChains)
        .values({
          orgId: host.orgId,
          workspaceId: host.workspaceId,
          hostId: host.id,
          chainSessionUuid,
          chainGenesisHash,
          firstSeenAt: at,
          lastSeenAt: at,
        })
        .onConflictDoUpdate({
          target: [
            schema.tachoGatewayChains.hostId,
            schema.tachoGatewayChains.chainSessionUuid,
          ],
          set: {
            // GREATEST, not assignment. Gateway calls are deliberately NOT
            // serialised — the forward was taken off the daemon's queue
            // because one slow connected-app call held every wrapped agent on
            // the machine — so two calls for the same chain can reach this
            // upsert out of order, and the later-committing one can carry the
            // older `at`. Assigning it would move `last_seen_at` BACKWARDS.
            //
            // That is not cosmetic. If a session row was created between the
            // two calls, a rewound timestamp reads as "this chain served no
            // gateway call during the session's lifetime", and if that batch
            // also seals the session the tier is wrong for good — the seal is
            // final and no later call can repair it.
            lastSeenAt: sql`GREATEST(${schema.tachoGatewayChains.lastSeenAt}, ${at})`,
            // COALESCE for the same reason, one type along: a chain's genesis
            // hash is constant, so a non-null value is always the right one and
            // a null only ever means "this caller did not state it". Assigning
            // unconditionally would let a daemon too old to send it erase what
            // a newer one proved, and leave the chain unpromotable.
            chainGenesisHash: sql`COALESCE(${chainGenesisHash}::text, ${schema.tachoGatewayChains.chainGenesisHash})`,
          },
        });
    }
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

  // No purpose: a plain org key, under whatever role gate its handler runs.
  if (scope.kind === "personal") return undefined;

  const { purpose } = scope;

  // A CLI session key is a person's terminal session, so it carries no machine
  // mandate — but only where a person came with it. `resolveApiKey` resolves
  // that person and re-checks their membership; a surface that drops the
  // answer leaves this gate a credential whose exemption rests on a person
  // nothing downstream can see, and `assertCallerRole` waves a context with no
  // `userId` straight through. Fail closed on the surface, not on the key.
  if (purpose === CLI_SESSION_SCOPE_PURPOSE) {
    return userId
      ? undefined
      : `Forbidden: this CLI session credential resolved to no person on this surface, so it may not invoke ${capabilityName}. A CLI session acts for the user who approved \`oxagen login\`; sign in again, or use a credential minted for this surface.`;
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
    const permitted = gatewayMayInvoke(capabilityName);
    await recordGatewayInvocation(
      orgId,
      scope.hostEnrollmentId,
      // The chain the caller named, which is what makes this record about a
      // SESSION rather than only about a host (#3221). Read only here, on the
      // one credential whose authentication it can attest anything about.
      check.gatewaySessionUuid ?? null,
      check.gatewayChainGenesisHash ?? null,
    );
    if (!permitted) {
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

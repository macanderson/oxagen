/**
 * The machine-key gate. These tests are the record of what an API-key
 * principal could do before it existed: `assertCallerRole` returns early for
 * one, and `checkIAM`'s tier fast-path allows every non-enterprise org, so a
 * key minted for one narrow job could invoke anything.
 */
import { tachoBundleGet } from "@oxagen/oxagen/contracts/tacho.bundle.get";
import { tachoGithubTokenIssue } from "@oxagen/oxagen/contracts/tacho.github_token.issue";
import { tachoCommandFetch } from "@oxagen/oxagen/contracts/tacho.command.fetch";
import { tachoEventsIngest } from "@oxagen/oxagen/contracts/tacho.events.ingest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
/** Every `tacho_hosts` write the gate made, in order. */
const hostUpdates: Array<Record<string, unknown>> = [];

/** The orgs whose PLANE the host write was opened against, in order. */
const hostWritePlanes: string[] = [];
/** Whether the database claims to have `gateway_last_seen_at` yet. */
let gatewayColumnPresent = true;
/** Whether it claims to have `tacho.gateway_chains` yet (#3221). */
let chainTablePresent = true;
/** Every `tacho.gateway_chains` upsert the gate made, in order. */
const chainUpserts: Array<Record<string, unknown>> = [];
/** The SET clause of each upsert, for the monotonicity assertions. */
const chainSets: Array<Record<string, unknown>> = [];
/**
 * The ROWS those upserts leave behind, keyed the way the unique index keys
 * them. Modelled rather than counted, because the property under test is that
 * the table is bounded by chains and not by calls.
 */
const chainRows = new Map<string, Record<string, unknown>>();
/** The host row the gate reads, or undefined for a host it cannot find. */
let hostRow: Record<string, unknown> | undefined = {
  id: "host-uuid",
  orgId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
};

const fakeTx = () => ({
  query: {
    apiKeys: { findFirst },
    tachoHosts: { findFirst: async () => hostRow },
  },
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        hostUpdates.push(values);
        return [];
      },
    }),
  }),
  insert: () => ({
    // One row per (host, chain): the gate upserts and only `lastSeenAt` moves.
    values: (values: Record<string, unknown>) => ({
      onConflictDoUpdate: async (args: {
        target: unknown[];
        set: Record<string, unknown>;
      }) => {
        chainUpserts.push(values);
        chainSets.push(args.set);
        // Keyed by the columns the statement ACTUALLY names as its conflict
        // target, not by the pair this fixture would have guessed. The mocked
        // `schema.tachoGatewayChains` maps each property to its SQL name, so a
        // target that forgets `chain_session_uuid` collapses two chains into
        // one row here exactly as the unique index would refuse to.
        const byColumn: Record<string, string> = {
          host_id: "hostId",
          chain_session_uuid: "chainSessionUuid",
        };
        const key = args.target
          .map((column) => String(values[byColumn[String(column)] ?? ""]))
          .join("\u0000");
        const existing = chainRows.get(key);
        chainRows.set(
          key,
          existing === undefined ? { ...values } : { ...existing, ...args.set },
        );
        return [];
      },
    }),
  }),
});

vi.mock("@oxagen/database", () => ({
  schema: {
    apiKeys: { id: "id", orgId: "org_id", deletedAt: "deleted_at" },
    tachoHosts: { id: "id", orgId: "org_id", publicId: "public_id" },
    tachoGatewayChains: {
      hostId: "host_id",
      chainSessionUuid: "chain_session_uuid",
    },
  },
  HOST_GATEWAY_COLUMN: {
    schema: "tacho",
    table: "hosts",
    column: "gateway_last_seen_at",
  },
  GATEWAY_CHAIN_COLUMN: {
    schema: "tacho",
    table: "gateway_chains",
    column: "chain_session_uuid",
  },
  // Per column, not one answer for both. The host column and the invocations
  // table ship in DIFFERENT migrations, so either can be the one still pending
  // and a shared answer would describe a state no deployment is ever in.
  // A read may retain a pre-migration miss. Writes must use the fresh seam.
  hasColumn: async () => false,
  hasColumnFresh: async (_tx: unknown, ref: { table: string }) =>
    ref.table === "hosts" ? gatewayColumnPresent : chainTablePresent,
  // The plane `withOrgPlaneSystemDb` opened the transaction on, published by
  // the seam rather than resolved a second time by the probe (#3223).
  ambientPlaneKey: async () => `plane-of:${hostWritePlanes.at(-1) ?? ""}`,
  withSystemDb: (fn: (tx: unknown) => unknown) => fn(fakeTx()),
  // The seam the host write must use. `withSystemDb` always targets the SHARED
  // plane, and `tacho.hosts` is tenant data, so on a dedicated plane that write
  // matches nothing and the observation never arrives
  // (discussion_r4040617216).
  withOrgPlaneSystemDb: (orgId: string, fn: (tx: unknown) => unknown) => {
    hostWritePlanes.push(orgId);
    return fn(fakeTx());
  },
}));

const getCapability = vi.fn();
const listCapabilities = vi.fn(() => [] as unknown[]);
vi.mock("@oxagen/oxagen", () => ({
  getCapability: (name: string) => getCapability(name) as unknown,
  listCapabilities: () => listCapabilities() as unknown,
}));

const {
  gatewayMandateTools,
  gatewayMayInvoke,
  machineKeyDenial,
  MACHINE_KEY_CAPABILITIES,
  STELLA_TELEMETRY_PURPOSE,
  TACHO_GATEWAY_PURPOSE,
  TACHO_HOST_PURPOSE,
} = await import("./machine-key-scope");

const { CLI_SESSION_SCOPE_PURPOSE } = await import(
  "@oxagen/oxagen/cli-session"
);

const ORG = "11111111-1111-4111-8111-111111111111";
/** The person a surface resolved a CLI session key to. */
const PERSON = "33333333-3333-4333-8333-333333333333";

function keyWithScope(scope: unknown): void {
  findFirst.mockResolvedValue({ scope });
}

beforeEach(() => {
  findFirst.mockReset();
  getCapability.mockReset();
  hostUpdates.length = 0;
  hostWritePlanes.length = 0;
  chainUpserts.length = 0;
  chainRows.clear();
  chainSets.length = 0;
  gatewayColumnPresent = true;
  chainTablePresent = true;
  hostRow = {
    id: "host-uuid",
    orgId: ORG,
    workspaceId: "22222222-2222-4222-8222-222222222222",
  };
  listCapabilities.mockReset();
  listCapabilities.mockReturnValue([]);
});

describe("a person's credential is untouched", () => {
  it("lets a session through without reading anything", async () => {
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: null,
        userId: null,
        capabilityName: "set_model_credential",
      }),
    ).toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("lets a key with no purpose through, as before", async () => {
    // A plain org API key. `oxagen login` used to mint these and no longer
    // does (#2997 gave it `cli_session_v1`); the comment that still said so
    // is the belief this gate's CLI-session bug was built on. What is true of
    // them is only that they carry no purpose, so this gate has nothing to
    // constrain them by and the handler's own role gate decides.
    keyWithScope({ note: "unscoped" });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_person",
        userId: null,
        capabilityName: "set_model_credential",
      }),
    ).toBeUndefined();
  });

  it("exempts a CLI session key from the mandate entirely, not from one entry", async () => {
    // `oxagen login`'s token exchange mints these with `purpose:
    // "cli_session_v1"`. `resolveApiKey` resolves that purpose to the
    // approving person (re-checked for org/workspace membership on every
    // call), so it must not fall into the "unrecognised purpose" branch
    // below — that regression denied the CLI's org/workspace picker every
    // capability outright, twice: once when #2997 introduced the purpose, and
    // again when #3178's squash overwrote the exemption #3222 had just added.
    //
    // `set_model_credential` is the second capability on purpose. It mutates
    // and is `sensitivity: "high"`, so it is outside even the widest machine
    // allowance this module grants (the gateway rule), and no
    // `MACHINE_KEY_CAPABILITIES` list contains it. A fix that merely
    // allow-listed `list_workspaces` somewhere would pass the first assertion
    // and fail this one: what is pinned here is that the key is not a machine
    // credential at all, not that one call was permitted.
    for (const capability of ["list_workspaces", "set_model_credential"]) {
      keyWithScope({ purpose: CLI_SESSION_SCOPE_PURPOSE });
      expect(
        await machineKeyDenial({
          orgId: ORG,
          apiKeyId: "aky_cli",
          userId: PERSON,
          capabilityName: capability,
        }),
        capability,
      ).toBeUndefined();
    }
  });

  it("denies a CLI session key that reached a surface which resolved no person", async () => {
    // The exemption above is justified by `resolveApiKey` resolving the key to
    // its creator. A surface that does not take that answer — `apps/mcp` did
    // not — presents a person's exemption with no person, and
    // `assertCallerRole` short-circuits on `!ctx.userId`, which at the
    // non-enterprise tier is the only role gate that runs. So the exemption is
    // conditional on the caller rather than on a file in another package
    // continuing to behave.
    keyWithScope({ purpose: CLI_SESSION_SCOPE_PURPOSE });
    const denial = await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_cli",
      userId: null,
      capabilityName: "set_model_credential",
    });
    expect(denial).toBeDefined();
    expect(denial).toContain("resolved to no person");
    expect(denial).toContain("set_model_credential");
  });

  it("treats a null scope as no purpose", async () => {
    keyWithScope(null);
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_null",
        userId: null,
        capabilityName: "query_ontology",
      }),
    ).toBeUndefined();
  });
});

describe("a key that is no longer there", () => {
  // `resolveApiKey` and this gate are two separate reads. Revocation soft-deletes
  // the row between them, and the row vanishing used to read as "no purpose" —
  // i.e. a person's key — which on a non-enterprise org the tier fast-path then
  // allows outright. A host key racing its own revocation got one unrestricted
  // invocation outside its mandate.
  it("denies rather than falling through to the personal-key path", async () => {
    findFirst.mockResolvedValue(undefined);
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_gone",
        userId: null,
        capabilityName: "query_ontology",
      }),
    ).toMatch(/no longer valid/);
  });

  it("denies a capability a live personal key would have been allowed", async () => {
    findFirst.mockResolvedValue(undefined);
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_gone",
        userId: null,
        capabilityName: "set_model_credential",
      }),
    ).toMatch(/set_model_credential/);
  });
});

describe("a ledger run credential", () => {
  it("may ingest evidence but cannot issue credentials or control another run", async () => {
    keyWithScope({ purpose: "ledger_run_v1" });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_run",
        userId: null,
        capabilityName: "ingest_run_frames",
      }),
    ).toBeUndefined();
    for (const capabilityName of [
      "create_run_token",
      "dispatch_command",
      "get_run_proof",
      "set_model_credential",
    ]) {
      expect(
        await machineKeyDenial({
          orgId: ORG,
          apiKeyId: "aky_run",
          userId: null,
          capabilityName,
        }),
      ).toContain(capabilityName);
    }
  });
});

describe("the Tacho host key", () => {
  it("names the control client's four capabilities as their contracts register them", () => {
    // A capability rename (ADR-025) left this list naming
    // `fetch_tacho_commands` after the contract became `fetch_commands`, and
    // every host's command poll was refused in production. The list is held
    // to the contracts' own names so the next rename fails here instead.
    expect(
      [...(MACHINE_KEY_CAPABILITIES[TACHO_HOST_PURPOSE] ?? [])].sort(),
    ).toEqual(
      [
        tachoBundleGet.name,
        tachoCommandFetch.name,
        tachoEventsIngest.name,
        tachoGithubTokenIssue.name,
      ].sort(),
    );
  });

  it("may make the four calls its control client makes", async () => {
    for (const capability of [
      "ingest_tacho_events",
      "get_tacho_bundle",
      "fetch_commands",
      "create_github_token",
    ]) {
      keyWithScope({
        purpose: TACHO_HOST_PURPOSE,
        host_enrollment_id: "tch_x",
      });
      expect(
        await machineKeyDenial({
          orgId: ORG,
          apiKeyId: "aky_h",
          userId: null,
          capabilityName: capability,
        }),
        capability,
      ).toBeUndefined();
    }
  });

  it("may NOT reach the operations it used to reach", async () => {
    // This is the finding. Every one of these passed before: the key has no
    // org_users row, so the role gate returned early, and a non-enterprise org
    // never reached IAM at all.
    for (const capability of [
      "set_model_credential",
      "delete_model_credential",
      "create_tacho_enrollment",
      "revoke_tacho_enrollment",
      "list_tacho_hosts",
      "dispatch_tacho_command",
    ]) {
      keyWithScope({ purpose: TACHO_HOST_PURPOSE });
      const denial = await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_h",
        userId: null,
        capabilityName: capability,
      });
      expect(denial, capability).toBeDefined();
      expect(denial).toContain(TACHO_HOST_PURPOSE);
      expect(denial).toContain(capability);
    }
  });

  it("cannot enroll or revoke, so a host cannot mint its own successor", async () => {
    keyWithScope({ purpose: TACHO_HOST_PURPOSE });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_h",
        userId: null,
        capabilityName: "create_tacho_enrollment",
      }),
    ).toBeDefined();
  });
});

describe("the gateway key", () => {
  const contract = (over: Record<string, unknown> = {}) => ({
    surfaces: ["api", "mcp"],
    mutates: false,
    sensitivity: "low",
    ...over,
  });

  it("may call a read-only, non-sensitive MCP capability", async () => {
    getCapability.mockReturnValue(contract());
    keyWithScope({ purpose: TACHO_GATEWAY_PURPOSE });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_g",
        userId: null,
        capabilityName: "query_ontology",
      }),
    ).toBeUndefined();
  });

  it("may not call anything that mutates", async () => {
    getCapability.mockReturnValue(contract({ mutates: true }));
    expect(gatewayMayInvoke("delete_workspace")).toBe(false);
  });

  it("may not call anything high-sensitivity, even read-only", async () => {
    // The read-only carve-out must not become a way to read secrets.
    getCapability.mockReturnValue(
      contract({ mutates: false, sensitivity: "high" }),
    );
    expect(gatewayMayInvoke("reveal_secret")).toBe(false);
  });

  it("may not call something that is not on the mcp surface", async () => {
    getCapability.mockReturnValue(contract({ surfaces: ["api"] }));
    expect(gatewayMayInvoke("internal_thing")).toBe(false);
  });

  it("may not call a capability this build does not know", async () => {
    getCapability.mockReturnValue(undefined);
    expect(gatewayMayInvoke("who_knows")).toBe(false);
  });

  it("defaults surfaces the way the registry does when a contract omits them", async () => {
    getCapability.mockReturnValue({ mutates: false, sensitivity: "low" });
    expect(gatewayMayInvoke("defaulted")).toBe(true);
  });

  it("says a refusal is a mandate decision, not a fault", async () => {
    getCapability.mockReturnValue(contract({ mutates: true }));
    keyWithScope({ purpose: TACHO_GATEWAY_PURPOSE });
    const denial = await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_g",
      userId: null,
      capabilityName: "delete_workspace",
    });
    expect(denial).toContain("mandate");
    expect(denial).toContain("delete_workspace");
  });
});

// ---------------------------------------------------------------------------
// The observation the enforcement tier is derived from
// ---------------------------------------------------------------------------
//
// discussion_r4036718127 (P1). The tier used to be read off an attribute on the
// submitted batch, which anything holding the local OTLP bearer can set. This
// is the other thing: the one moment the control plane KNOWS a gateway call
// happened, because it authenticated a server-minted, per-host credential and
// is about to serve the call. `tacho.events.ingest` derives `gateway` from the
// column this writes and from nothing a submitter sends.
describe("a served gateway call is recorded where the tier can read it", () => {
  const readOnlyMcp = { surfaces: ["api", "mcp"], mutates: false } as const;

  it("stamps the host on an ALLOWED call", async () => {
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_g",
        userId: null,
        capabilityName: "query_ontology",
      }),
    ).toBeUndefined();
    expect(hostUpdates).toHaveLength(1);
    expect(hostUpdates[0]?.["gatewayLastSeenAt"]).toBeInstanceOf(Date);
    // On the ORGANISATION'S plane. `tacho.hosts` is tenant data, so a write on
    // the shared plane would match nothing for an org with a dedicated one and
    // report success (discussion_r4040617216).
    expect(hostWritePlanes).toEqual([ORG]);
  });

  it("writes nothing when the migration has not been applied", async () => {
    // The column arrives with migration 20260917140000, which production
    // applies by hand after the deploy (#1275). Naming it before then raises
    // 42703, which aborts the transaction and turns a note into a DENIED
    // gateway call.
    gatewayColumnPresent = false;
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_g",
        userId: null,
        capabilityName: "query_ontology",
      }),
      // Still allowed: a missing observation is not a reason to refuse a call
      // the credential is entitled to make.
    ).toBeUndefined();
    expect(hostUpdates).toEqual([]);
  });

  it("records the first gateway call after migration without trusting a cached miss", async () => {
    gatewayColumnPresent = false;
    chainTablePresent = false;
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    const request = {
      orgId: ORG,
      apiKeyId: "aky_g",
      userId: null,
      capabilityName: "query_ontology",
      gatewaySessionUuid: "tachod-abc",
    };
    await machineKeyDenial(request);
    expect(hostUpdates).toEqual([]);
    expect(chainUpserts).toEqual([]);
    gatewayColumnPresent = true;
    chainTablePresent = true;
    await machineKeyDenial(request);
    expect(hostUpdates).toHaveLength(1);
    expect(chainUpserts).toHaveLength(1);
  });

  it("stamps the host on a call it REFUSED", async () => {
    // A refusal is not weaker evidence of enforcement than a success — it is
    // the strongest there is, the case where Oxagen actually stopped
    // something, and the case the operator most needs the session to show
    // (discussion_r4040685657).
    //
    // An earlier version asserted the opposite here, reasoning that a refused
    // call must not raise a tier. What must not raise a tier is a
    // CLIENT-ATTESTED claim. This is the server's own record that it
    // authenticated this host's gateway credential and ruled on the request,
    // which a refusal satisfies exactly as well as a success does.
    getCapability.mockReturnValue({ ...readOnlyMcp, mutates: true });
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    const denial = await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_g",
      userId: null,
      capabilityName: "delete_workspace",
    });
    // Still refused. Recording the attempt does not permit it.
    expect(denial).toMatch(/outside this agent's mandate/);
    expect(hostUpdates).toHaveLength(1);
    expect(hostUpdates[0]?.["gatewayLastSeenAt"]).toBeInstanceOf(Date);
    expect(hostWritePlanes).toEqual([ORG]);
  });

  it("records the CHAIN the gateway named, not just the host (#3221)", async () => {
    // The correlation. The host timestamp says a gateway call happened; this
    // row says which of the host's chains it happened for. Without it the
    // answer came from an attribute on the submitted batch, so a holder of the
    // host's control-plane key could point a real observation at any session.
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_g",
      userId: null,
      capabilityName: "query_ontology",
      gatewaySessionUuid: "tachod-abc",
    });
    expect(chainUpserts).toHaveLength(1);
    expect(chainUpserts[0]).toMatchObject({
      chainSessionUuid: "tachod-abc",
      // From the HOST ROW, resolved through the key's own scope — never from
      // anything the caller sent.
      hostId: "host-uuid",
      orgId: ORG,
    });
    expect(chainUpserts[0]?.["lastSeenAt"]).toBeInstanceOf(Date);
  });

  it("keeps one row per chain however many calls it serves", async () => {
    // The bound (AGENTS.md storage boundaries). A row per authorised call
    // would be an append-only audit stream growing with gateway traffic inside
    // the transactional database, which is what ClickHouse is for — and the
    // per-call history is already there, on the `tool_call` and
    // `policy_decision` events the daemon seals onto this very chain. Postgres
    // holds only what ingest must read inside a transaction.
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    for (let i = 0; i < 5; i += 1) {
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_g",
        userId: null,
        capabilityName: "query_ontology",
        gatewaySessionUuid: "tachod-abc",
      });
    }
    expect(chainUpserts).toHaveLength(5);
    expect(chainRows.size).toBe(1);
  });

  it("never moves last_seen_at backwards", async () => {
    // Gateway calls are deliberately not serialised — the forward was taken
    // off the daemon's queue because one slow connected-app call held every
    // wrapped agent on the machine — so two calls for the same chain can reach
    // the upsert out of order and the later-committing one can carry the OLDER
    // timestamp. Assigning it would rewind `last_seen_at`, and a session
    // created between the two would then read as having served no gateway call
    // during its lifetime. If that batch also seals the session, the tier is
    // wrong for good.
    //
    // Asserted on the statement rather than on a modelled row: the fixture
    // does not execute SQL, and a fake that pretended to would be asserting
    // its own guess at what GREATEST does.
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_g",
      userId: null,
      capabilityName: "query_ontology",
      gatewaySessionUuid: "tachod-abc",
    });
    const set = chainSets[0] ?? {};
    expect(JSON.stringify(set["lastSeenAt"])).toContain("GREATEST");
    // …and the genesis hash is coalesced for the same reason one type along: a
    // daemon too old to state it must not erase what a newer one proved.
    expect(JSON.stringify(set["chainGenesisHash"])).toContain("COALESCE");
  });

  it("keeps the chains of one host apart", async () => {
    // Bounded by chains, not collapsed to the host: the whole point of the
    // table is that it says WHICH chain, so two chains are two rows.
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    for (const chain of ["tachod-abc", "tachod-def"]) {
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_g",
        userId: null,
        capabilityName: "query_ontology",
        gatewaySessionUuid: chain,
      });
    }
    expect(chainRows.size).toBe(2);
  });

  it("records a refused call on the chain too", async () => {
    getCapability.mockReturnValue({ ...readOnlyMcp, mutates: true });
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    const denial = await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_g",
      userId: null,
      capabilityName: "delete_workspace",
      gatewaySessionUuid: "tachod-abc",
    });
    expect(denial).toMatch(/outside this agent's mandate/);
    // A call Oxagen stopped is evidence that Oxagen was enforcing, so it
    // advances `lastSeenAt` exactly as a success does. The ruling itself is not
    // stored here — it is in ClickHouse, on the `policy_decision` the daemon
    // sealed onto this very chain.
    expect(chainUpserts).toHaveLength(1);
    expect(chainUpserts[0]?.["chainSessionUuid"]).toBe("tachod-abc");
  });

  it("records no chain when the caller named none", async () => {
    // A daemon too old to send the header. A row naming no chain is not
    // evidence about any session, so none is written and the host timestamp
    // stands alone — which leaves the session on the host's own mode rather
    // than promoting it on a correlation nobody made.
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_g",
      userId: null,
      capabilityName: "query_ontology",
    });
    expect(hostUpdates).toHaveLength(1);
    expect(chainUpserts).toEqual([]);
  });

  it("records no chain while its migration is pending", async () => {
    // `tacho.gateway_chains` arrives in its own migration, applied by
    // hand after the deploy (#1275). Naming an absent TABLE raises 42P01,
    // which aborts the transaction exactly as a missing column does — and the
    // host stamp, whose own migration HAS landed, must still be written.
    chainTablePresent = false;
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_g",
        userId: null,
        capabilityName: "query_ontology",
        gatewaySessionUuid: "tachod-abc",
      }),
    ).toBeUndefined();
    expect(hostUpdates).toHaveLength(1);
    expect(chainUpserts).toEqual([]);
  });

  it("writes nothing for a host the key's scope names but the org lacks", async () => {
    // The enrollment was deleted between minting the key and this call. There
    // is no host to attribute the invocation to, and inventing one would file
    // evidence against a row that is not there.
    hostRow = undefined;
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_GATEWAY_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_g",
      userId: null,
      capabilityName: "query_ontology",
      gatewaySessionUuid: "tachod-abc",
    });
    expect(hostUpdates).toEqual([]);
    expect(chainUpserts).toEqual([]);
  });

  it("ignores a chain named on a credential that is not a gateway", async () => {
    // The header is carried for every caller and read back for exactly one
    // purpose. A chain id attested by a credential whose use it says nothing
    // about is not evidence, and must not become a row.
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_HOST_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    const allowed = [
      ...(MACHINE_KEY_CAPABILITIES[TACHO_HOST_PURPOSE] ?? []),
    ][0];
    await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_h",
      userId: null,
      capabilityName: allowed as string,
      gatewaySessionUuid: "tachod-abc",
    });
    expect(chainUpserts).toEqual([]);
  });

  it("records nothing for the HOST key, which serves no connected app", async () => {
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({
      purpose: TACHO_HOST_PURPOSE,
      host_enrollment_id: "tch_aaaaaaaaaaaaaaaaaaaaaa",
    });
    const allowed = [
      ...(MACHINE_KEY_CAPABILITIES[TACHO_HOST_PURPOSE] ?? []),
    ][0];
    expect(allowed).toBeDefined();
    await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_h",
      userId: null,
      capabilityName: allowed as string,
    });
    expect(hostUpdates).toHaveLength(0);
  });

  it("records nothing when the scope names no host", async () => {
    // An observation that cannot be attributed to a host is not evidence about
    // any session, and guessing which host it belonged to would be worse than
    // having no record at all.
    getCapability.mockReturnValue(readOnlyMcp);
    keyWithScope({ purpose: TACHO_GATEWAY_PURPOSE });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_g",
        userId: null,
        capabilityName: "query_ontology",
      }),
    ).toBeUndefined();
    expect(hostUpdates).toHaveLength(0);
  });
});

describe("fail closed", () => {
  it("allows nothing to a purpose this build has never heard of", async () => {
    keyWithScope({ purpose: "some_future_machine_v9" });
    const denial = await machineKeyDenial({
      orgId: ORG,
      apiKeyId: "aky_future",
      userId: null,
      capabilityName: "query_ontology",
    });
    expect(denial).toBeDefined();
    expect(denial).toContain("does not recognise");
  });

  it("keeps Stella's telemetry key to its one ingest call", async () => {
    keyWithScope({ purpose: STELLA_TELEMETRY_PURPOSE });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_s",
        userId: null,
        capabilityName: "ingest_stella_operational_telemetry",
      }),
    ).toBeUndefined();
    keyWithScope({ purpose: STELLA_TELEMETRY_PURPOSE });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_s",
        userId: null,
        capabilityName: "ingest_tacho_events",
      }),
    ).toBeDefined();
  });

  it("gives no purpose a capability another purpose owns", async () => {
    const host = MACHINE_KEY_CAPABILITIES[TACHO_HOST_PURPOSE];
    const stella = MACHINE_KEY_CAPABILITIES[STELLA_TELEMETRY_PURPOSE];
    for (const capability of host ?? []) {
      expect(stella?.has(capability)).toBeFalsy();
    }
  });

  it("does not give the gateway purpose an enumerated list to widen", async () => {
    // Its allowance is the rule in `gatewayMayInvoke`; an entry here would be
    // a second, quieter answer to the same question.
    expect(MACHINE_KEY_CAPABILITIES[TACHO_GATEWAY_PURPOSE]).toBeUndefined();
  });
});

describe("the mandate, materialised for the host that serves it", () => {
  /**
   * `gatewayMayInvoke` is a rule over the registry, and the local MCP gateway
   * cannot run it: `@oxagen/tacho` takes no `@oxagen/*` runtime dependency, so
   * it cannot read a capability's surfaces, mutation or sensitivity. Before
   * the answer was signed into the policy bundle, the gateway forwarded
   * `tools/list` unchanged and advertised everything — the app was shown tools
   * that enforcement could only refuse when one was selected, and a declared
   * `tool_ceiling` counted forbidden tools toward the limit.
   */
  const capability = (
    name: string,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    name,
    surfaces: ["api", "mcp"],
    mutates: false,
    sensitivity: "low",
    ...over,
  });

  function registry(...caps: Array<Record<string, unknown>>): void {
    listCapabilities.mockReturnValue(caps);
    getCapability.mockImplementation((name: string) =>
      caps.find((c) => c["name"] === name),
    );
  }

  it("lists exactly what the rule permits, and nothing else", () => {
    registry(
      capability("query_ontology"),
      capability("delete_workspace", { mutates: true }),
      capability("reveal_secret", { sensitivity: "high" }),
      capability("internal_thing", { surfaces: ["api"] }),
      capability("get_run"),
    );
    expect(gatewayMandateTools()).toEqual(["get_run", "query_ontology"]);
  });

  it("sorts, so an etag does not move with import order", () => {
    // The bundle's etag is a digest of its content. Registration order
    // follows import order, and an etag that moved on every restart would
    // make every host refetch a mandate that had not changed.
    registry(capability("z_tool"), capability("a_tool"), capability("m_tool"));
    expect(gatewayMandateTools()).toEqual(["a_tool", "m_tool", "z_tool"]);
  });

  it("answers undefined for an empty registry rather than guessing", () => {
    // Not `[]`. An empty registry is a process that has not imported its
    // contracts, and `[]` is a mandate permitting nothing — a real answer the
    // gateway acts on by serving no tools at all. Returning `[]` here would
    // hand a healthy fleet an empty toolbelt on the say-so of an import order.
    registry();
    expect(gatewayMandateTools()).toBeUndefined();
  });

  it("answers an empty list when the registry exists and permits nothing", () => {
    // The case the caller must be able to tell apart from the one above: a
    // populated registry whose every capability the rule refuses — a policy
    // change leaving only mutating or high-sensitivity MCP tools. That is a
    // decision, and it is stated as `[]`, never as silence.
    registry(
      capability("delete_workspace", { mutates: true }),
      capability("reveal_secret", { sensitivity: "high" }),
      capability("internal_thing", { surfaces: ["api"] }),
    );
    expect(gatewayMandateTools()).toEqual([]);
  });
});

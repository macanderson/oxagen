/**
 * The machine-key gate. These tests are the record of what an API-key
 * principal could do before it existed: `assertCallerRole` returns early for
 * one, and `checkIAM`'s tier fast-path allows every non-enterprise org, so a
 * key minted for one narrow job could invoke anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();
/** Every `tacho_hosts` write the gate made, in order. */
const hostUpdates: Array<Record<string, unknown>> = [];

/** The orgs whose PLANE the host write was opened against, in order. */
const hostWritePlanes: string[] = [];
/** Whether the database claims to have `gateway_last_seen_at` yet. */
let gatewayColumnPresent = true;

const fakeTx = () => ({
  query: { apiKeys: { findFirst } },
  update: () => ({
    set: (values: Record<string, unknown>) => ({
      where: async () => {
        hostUpdates.push(values);
        return [];
      },
    }),
  }),
});

vi.mock("@oxagen/database", () => ({
  schema: {
    apiKeys: { id: "id", orgId: "org_id", deletedAt: "deleted_at" },
    tachoHosts: { orgId: "org_id", publicId: "public_id" },
  },
  HOST_GATEWAY_COLUMN: {
    schema: "tacho",
    table: "hosts",
    column: "gateway_last_seen_at",
  },
  hasColumn: async () => gatewayColumnPresent,
  planeKeyFor: async (orgId: string) => `plane-of:${orgId}`,
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

const { CLI_SESSION_SCOPE_PURPOSE } = await import("@oxagen/auth/cli-auth");

const ORG = "11111111-1111-4111-8111-111111111111";

function keyWithScope(scope: unknown): void {
  findFirst.mockResolvedValue({ scope });
}

beforeEach(() => {
  findFirst.mockReset();
  getCapability.mockReset();
  hostUpdates.length = 0;
  hostWritePlanes.length = 0;
  gatewayColumnPresent = true;
  listCapabilities.mockReset();
  listCapabilities.mockReturnValue([]);
});

describe("a person's credential is untouched", () => {
  it("lets a session through without reading anything", async () => {
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: null,
        capabilityName: "set_model_credential",
      }),
    ).toBeUndefined();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("lets a key with no purpose act for its creator, as before", async () => {
    // `oxagen login` mints these. They carry no purpose and keep the
    // creator-derived authority the rest of the system expects.
    keyWithScope({ note: "cli" });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_person",
        capabilityName: "set_model_credential",
      }),
    ).toBeUndefined();
  });

  it("treats a null scope as no purpose", async () => {
    keyWithScope(null);
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_null",
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
        capabilityName: "set_model_credential",
      }),
    ).toMatch(/set_model_credential/);
  });
});

describe("the Tacho host key", () => {
  it("may make the three calls its control client makes", async () => {
    for (const capability of [
      "ingest_tacho_events",
      "get_tacho_bundle",
      "fetch_tacho_commands",
    ]) {
      keyWithScope({
        purpose: TACHO_HOST_PURPOSE,
        host_enrollment_id: "tch_x",
      });
      expect(
        await machineKeyDenial({
          orgId: ORG,
          apiKeyId: "aky_h",
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
        capabilityName: "query_ontology",
      }),
      // Still allowed: a missing observation is not a reason to refuse a call
      // the credential is entitled to make.
    ).toBeUndefined();
    expect(hostUpdates).toEqual([]);
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
      capabilityName: "delete_workspace",
    });
    // Still refused. Recording the attempt does not permit it.
    expect(denial).toMatch(/outside this agent's mandate/);
    expect(hostUpdates).toHaveLength(1);
    expect(hostUpdates[0]?.["gatewayLastSeenAt"]).toBeInstanceOf(Date);
    expect(hostWritePlanes).toEqual([ORG]);
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
        capabilityName: "ingest_stella_operational_telemetry",
      }),
    ).toBeUndefined();
    keyWithScope({ purpose: STELLA_TELEMETRY_PURPOSE });
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_s",
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

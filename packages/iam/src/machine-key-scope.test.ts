/**
 * The machine-key gate. These tests are the record of what an API-key
 * principal could do before it existed: `assertCallerRole` returns early for
 * one, and `checkIAM`'s tier fast-path allows every non-enterprise org, so a
 * key minted for one narrow job could invoke anything.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();

vi.mock("@oxagen/database", () => ({
  schema: {
    apiKeys: { id: "id", orgId: "org_id", deletedAt: "deleted_at" },
  },
  withSystemDb: (fn: (tx: unknown) => unknown) =>
    fn({ query: { apiKeys: { findFirst } } }),
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

const ORG = "11111111-1111-4111-8111-111111111111";

function keyWithScope(scope: unknown): void {
  findFirst.mockResolvedValue({ scope });
}

beforeEach(() => {
  findFirst.mockReset();
  getCapability.mockReset();
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

  it("treats a missing key and a null scope as no purpose", async () => {
    findFirst.mockResolvedValue(undefined);
    expect(
      await machineKeyDenial({
        orgId: ORG,
        apiKeyId: "aky_gone",
        capabilityName: "query_ontology",
      }),
    ).toBeUndefined();
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

  it("answers nothing for an empty registry rather than guessing", () => {
    registry();
    expect(gatewayMandateTools()).toEqual([]);
  });
});

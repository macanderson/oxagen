// The Tools writes through the real kernel seam: the viewer resolution
// and the kernel's invoke() are the only fakes, so each case shows what the
// person gets back and whether the capability ran — ok, invalid (refused
// before the kernel), and denied with the handler's reason (INV-19).
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const {
  addConnection,
  deleteApprovalRule,
  flipKillSwitch,
  importTools,
  readConnection,
  registerServer,
  removeProvider,
  saveApprovalRule,
  setApprovalRuleEnabled,
  setToolClassification,
} = await import("./actions");
const { approvalRuleListOutput, connectionGetOutput } = await import(
  "@/test/tools-outputs"
);

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

/** The same viewer without an accountable org role, for the gates in the actions. */
const member = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};
const refused = (reason: string) =>
  new kernel.HandlerError({ code: "forbidden", reason });

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("importTools", () => {
  const output = {
    serverId: "mcs_01k5s1",
    importDigest: "d1",
    tools: [
      {
        id: "tlv_1",
        toolId: "tol_1",
        slug: "a",
        name: "A",
        version: 1,
        checksum: "c",
        schemaOrigin: "imported" as const,
        consequenceTags: [],
        measures: {},
        effectIdPath: null,
        published: true,
      },
      {
        id: "tlv_2",
        toolId: "tol_2",
        slug: "b",
        name: "B",
        version: 2,
        checksum: "c",
        schemaOrigin: "imported" as const,
        consequenceTags: [],
        measures: {},
        effectIdPath: null,
        published: false,
      },
    ],
  };

  it("imports every pin when no tool is named, and counts what landed", async () => {
    invoke.mockResolvedValue(output);
    expect(
      await importTools("acme", "core-platform", {
        serverId: " mcs_01k5s1 ",
        tools: [],
      }),
    ).toEqual({
      ok: true,
      value: { importDigest: "d1", published: 1, unchanged: 1 },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "import_tools",
      { serverId: "mcs_01k5s1" },
      expect.objectContaining(TENANT),
    );
  });

  it("names only the pins the person picked, blanks dropped", async () => {
    invoke.mockResolvedValue(output);
    await importTools("acme", "core-platform", {
      serverId: "mcs_01k5s1",
      tools: [" get_page ", "", "create_page"],
    });
    expect(invoke).toHaveBeenCalledWith(
      "import_tools",
      { serverId: "mcs_01k5s1", tools: ["get_page", "create_page"] },
      expect.objectContaining(TENANT),
    );
  });

  it("is refused before the kernel when the server is not named", async () => {
    expect(
      await importTools("acme", "core-platform", { serverId: " ", tools: [] }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "serverId",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's reason when the role gate refuses it", async () => {
    invoke.mockRejectedValue(refused("org_role_required"));
    expect(
      await importTools("acme", "core-platform", {
        serverId: "mcs_01k5s1",
        tools: [],
      }),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });
});

describe("setToolClassification", () => {
  const draft = {
    toolVersionId: "tlv_01k5a1",
    riskGrade: "critical" as const,
    sideEffect: "irreversible" as const,
    egress: "third_party" as const,
    consequenceTags: ["moves_money"],
    dataClasses: ["payment"],
    measures: [
      {
        name: "amount",
        path: "$.amount",
        type: "money" as const,
        currencyPath: "$.currency",
        unit: null,
      },
    ],
    reason: "  Reclassified after the Stripe audit.  ",
  };

  it("carries the four axes and rebuilds the version's measures unchanged", async () => {
    invoke.mockResolvedValue({
      toolVersionId: "tlv_01k5a1",
      riskGrade: "critical",
      classification: {
        sideEffect: "irreversible",
        egress: "third_party",
        consequenceTags: ["moves_money"],
        measures: {
          amount: {
            path: "$.amount",
            type: "money",
            currencyPath: "$.currency",
          },
        },
        dataClasses: ["payment"],
      },
      classifiedAt: "2026-09-16T09:00:00.000Z",
    });
    expect(await setToolClassification("acme", "core-platform", draft)).toEqual(
      { ok: true, value: { classifiedAt: "2026-09-16T09:00:00.000Z" } },
    );
    expect(invoke).toHaveBeenCalledWith(
      "set_tool_classification",
      {
        toolVersionId: "tlv_01k5a1",
        riskGrade: "critical",
        classification: {
          sideEffect: "irreversible",
          egress: "third_party",
          consequenceTags: ["moves_money"],
          dataClasses: ["payment"],
          measures: {
            amount: {
              path: "$.amount",
              type: "money",
              currencyPath: "$.currency",
            },
          },
        },
        reason: "Reclassified after the Stripe audit.",
      },
      expect.objectContaining(TENANT),
    );
  });

  it("leaves a measure's optional fields off when the version did not carry them", async () => {
    invoke.mockResolvedValue({
      toolVersionId: "tlv_01k5a1",
      riskGrade: "low",
      classification: {
        sideEffect: "read",
        egress: "local",
        consequenceTags: [],
        measures: { rows: { path: "$.rows", type: "count", unit: "rows" } },
        dataClasses: [],
      },
      classifiedAt: "2026-09-16T09:00:00.000Z",
    });
    await setToolClassification("acme", "core-platform", {
      ...draft,
      riskGrade: "low",
      sideEffect: "read",
      egress: "local",
      consequenceTags: [],
      dataClasses: [],
      measures: [
        {
          name: "rows",
          path: "$.rows",
          type: "count",
          currencyPath: null,
          unit: "rows",
        },
      ],
      reason: "Downgraded.",
    });
    const [, input] = invoke.mock.calls[0] ?? [];
    expect(input).toMatchObject({
      classification: {
        measures: { rows: { path: "$.rows", type: "count", unit: "rows" } },
      },
    });
  });

  it("is refused before the kernel when no reason is given", async () => {
    expect(
      await setToolClassification("acme", "core-platform", {
        ...draft,
        reason: "   ",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "reason",
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("flipKillSwitch", () => {
  const output = {
    switchId: "emd_01k5c1",
    on: true,
    changed: true,
    denyGeneration: { org: 13, workspace: 4 },
    grantsRevoked: 0,
  };

  it.each([
    ["class", "moves_money"],
    ["tool_version", "tlv_01k5a1"],
    ["tool_server", "mcs_01k5s1"],
    ["connection", "mcrd_01k5c9"],
    ["agent", "agt_01k5g1"],
  ] as const)("flips a %s switch on with its reason", async (kind, target) => {
    invoke.mockResolvedValue(output);
    expect(
      await flipKillSwitch("acme", "core-platform", {
        kind,
        target: ` ${target} `,
        on: true,
        reason: "Suspected compromise.",
      }),
    ).toEqual({ ok: true, value: output });
    expect(invoke).toHaveBeenCalledWith(
      "set_kill_switch",
      {
        target: { kind, id: target },
        on: true,
        reason: "Suspected compromise.",
      },
      expect.objectContaining(TENANT),
    );
  });

  it.each(["operator", "workspace", "org"] as const)(
    "flips a %s switch, whose target the contract wants as a uuid",
    async (kind) => {
      invoke.mockResolvedValue({ ...output, on: false });
      await flipKillSwitch("acme", "core-platform", {
        kind,
        target: "7b000000-0000-4000-8000-000000000001",
        on: false,
        reason: "Cleared.",
      });
      expect(invoke).toHaveBeenCalledWith(
        "set_kill_switch",
        {
          target: { kind, id: "7b000000-0000-4000-8000-000000000001" },
          on: false,
          reason: "Cleared.",
        },
        expect.objectContaining(TENANT),
      );
    },
  );

  it.each([
    ["org", ctx.orgId],
    ["workspace", ctx.workspaceId],
  ] as const)(
    "supplies the %s uuid itself, because the page never prints one",
    async (kind, id) => {
      invoke.mockResolvedValue(output);
      expect(
        await flipKillSwitch("acme", "core-platform", {
          kind,
          target: null,
          on: true,
          reason: "Stop everything.",
        }),
      ).toEqual({ ok: true, value: output });
      expect(invoke).toHaveBeenCalledWith(
        "set_kill_switch",
        {
          target: { kind, id },
          on: true,
          reason: "Stop everything.",
        },
        expect.objectContaining(TENANT),
      );
    },
  );

  it("clears the workspace the card names, not the one in view", async () => {
    invoke.mockResolvedValue({ ...output, on: false });
    await flipKillSwitch("acme", "core-platform", {
      kind: "workspace",
      target: "7b000000-0000-4000-8000-0000000000ff",
      on: false,
      reason: "The sibling workspace is back.",
    });
    expect(invoke).toHaveBeenCalledWith(
      "set_kill_switch",
      {
        target: {
          kind: "workspace",
          id: "7b000000-0000-4000-8000-0000000000ff",
        },
        on: false,
        reason: "The sibling workspace is back.",
      },
      expect.objectContaining(TENANT),
    );
  });

  it("is refused before the kernel when a level that needs a target got none", async () => {
    expect(
      await flipKillSwitch("acme", "core-platform", {
        kind: "class",
        target: null,
        on: true,
        reason: "Stop money movement.",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "target.id",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports the grants a connection switch revoked", async () => {
    invoke.mockResolvedValue({ ...output, grantsRevoked: 31 });
    const result = await flipKillSwitch("acme", "core-platform", {
      kind: "connection",
      target: "mcrd_01k5c9",
      on: true,
      reason: "Key probe.",
    });
    expect(result.ok && result.value.grantsRevoked).toBe(31);
  });

  it("is refused before the kernel when the target is not a uuid the contract accepts", async () => {
    expect(
      await flipKillSwitch("acme", "core-platform", {
        kind: "org",
        target: "acme",
        on: true,
        reason: "Stop everything.",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "target.id",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's reason when the role gate refuses it", async () => {
    invoke.mockRejectedValue(refused("org_role_required"));
    expect(
      await flipKillSwitch("acme", "core-platform", {
        kind: "class",
        target: "moves_money",
        on: true,
        reason: "Stop money movement.",
      }),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });
});

describe("saveApprovalRule", () => {
  const stored = () => approvalRuleListOutput();
  /** What set_approval_rules answers: the list shape, which the action ignores past `ok`. */
  const written = () => approvalRuleListOutput();

  const draft = {
    id: " night-deploys ",
    name: " Deploys to staging at night ",
    tools: [" deploy__release ", ""],
    enabled: true,
    maxMeasures: {},
    allowTargets: { environment: ["staging"] },
    standingWindowMs: null,
    businessHours: null,
  };

  /** The stored rules as the write body carries them back: provenance and counters off. */
  const bodies = () =>
    stored().items.map((rule) => ({
      id: rule.id,
      name: rule.name,
      tools: rule.tools,
      enabled: rule.enabled,
      maxMeasures: rule.maxMeasures,
      allowTargets: rule.allowTargets,
      standingWindowMs: rule.standingWindowMs,
      businessHours: rule.businessHours,
    }));

  /** The nth stored rule body, as a value rather than a possibly-absent index. */
  const body = (n: number) => {
    const found = bodies()[n];
    if (found === undefined)
      throw new Error(`the fixture holds no rule ${String(n)}`);
    return found;
  };

  it("appends a new rule to the set as it stands now, trimmed", async () => {
    invoke.mockResolvedValueOnce(stored()).mockResolvedValueOnce(written());
    expect(
      await saveApprovalRule("acme", "core-platform", "create", draft, null),
    ).toEqual({ ok: true, value: { ruleId: "night-deploys" } });
    expect(invoke).toHaveBeenNthCalledWith(
      1,
      "list_approval_rules",
      {},
      expect.objectContaining(TENANT),
    );
    expect(invoke).toHaveBeenNthCalledWith(
      2,
      "set_approval_rules",
      {
        rules: [
          ...bodies(),
          {
            id: "night-deploys",
            name: "Deploys to staging at night",
            tools: ["deploy__release"],
            enabled: true,
            maxMeasures: {},
            allowTargets: { environment: ["staging"] },
            standingWindowMs: null,
            businessHours: null,
          },
        ],
        replaces: bodies(),
        saving: ["night-deploys"],
      },
      expect.objectContaining(TENANT),
    );
  });

  it("replaces the edited rule in place and sends every other rule back unchanged", async () => {
    invoke.mockResolvedValueOnce(stored()).mockResolvedValueOnce(written());
    const edit = {
      ...draft,
      id: "repeat-deploys",
      name: "Repeat deploys",
      tools: ["deploy__release"],
      standingWindowMs: 7_200_000,
    };
    const first = body(0);
    const rendered = body(1);
    expect(
      await saveApprovalRule("acme", "core-platform", "edit", edit, rendered),
    ).toEqual({ ok: true, value: { ruleId: "repeat-deploys" } });
    expect(invoke).toHaveBeenLastCalledWith(
      "set_approval_rules",
      {
        rules: [
          first,
          {
            id: "repeat-deploys",
            name: "Repeat deploys",
            tools: ["deploy__release"],
            enabled: true,
            maxMeasures: {},
            allowTargets: { environment: ["staging"] },
            standingWindowMs: 7_200_000,
            businessHours: null,
          },
        ],
        replaces: bodies(),
        saving: ["repeat-deploys"],
      },
      expect.objectContaining(TENANT),
    );
  });

  // The id is the audit citation: creating over one would rewrite a rule
  // receipts already cite, so the action refuses before it writes.
  it("refuses to create over an id already in the set, and writes nothing", async () => {
    invoke.mockResolvedValueOnce(stored());
    expect(
      await saveApprovalRule(
        "acme",
        "core-platform",
        "create",
        { ...draft, id: "small-refunds" },
        null,
      ),
    ).toEqual({ ok: false, reason: "conflict", code: "rule_id_taken" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("says the rule is gone when the one being edited left the set", async () => {
    invoke.mockResolvedValueOnce(stored());
    expect(
      await saveApprovalRule(
        "acme",
        "core-platform",
        "edit",
        { ...draft, id: "deleted-meanwhile" },
        { ...draft, id: "deleted-meanwhile" },
      ),
    ).toEqual({
      ok: false,
      reason: "not_found",
      code: "approval_rule_not_found",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("names the read that failed rather than writing over a set it could not see", async () => {
    invoke.mockRejectedValueOnce(refused("org_role_required"));
    const result = await saveApprovalRule(
      "acme",
      "core-platform",
      "create",
      draft,
      null,
    );
    expect(result).toEqual({
      ok: false,
      reason: "denied",
      code: "tools.read",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("says the store did not answer when the read fails, and writes nothing", async () => {
    invoke.mockRejectedValueOnce(new Error("socket hang up"));
    expect(
      await saveApprovalRule("acme", "core-platform", "create", draft, null),
    ).toEqual({
      ok: false,
      reason: "unavailable",
      code: "tool_registry_unavailable",
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // The write carries the set it was built from, so a rule another person
  // deleted or switched off between the read and the write is not written back.
  it("says the set changed when the handler finds it moved since the read", async () => {
    invoke.mockResolvedValueOnce(stored()).mockRejectedValueOnce(
      new kernel.HandlerError({
        code: "conflict",
        reason: "rule_set_changed",
      }),
    );
    expect(
      await saveApprovalRule("acme", "core-platform", "create", draft, null),
    ).toEqual({ ok: false, reason: "conflict", code: "rule_set_changed" });
  });

  // The dialog rendered the rule before this read, so `replaces` cannot speak
  // for the window the author had it open: it is built from the read. A rule
  // someone switched off meanwhile would be switched back on by the stale
  // editor body, which is the one change nobody asked for.
  it("refuses an edit of a rule that moved since the editor rendered it", async () => {
    invoke.mockResolvedValueOnce(stored());
    const rendered = body(1);
    expect(
      await saveApprovalRule(
        "acme",
        "core-platform",
        "edit",
        { ...rendered, name: "Repeat deploys" },
        { ...rendered, enabled: true },
      ),
    ).toEqual({ ok: false, reason: "conflict", code: "rule_changed" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // Two reads of one rule may hand its records back in different key orders,
  // which is not a change anyone made and must not refuse the save.
  it("takes a rendered rule whose records came back in another key order", async () => {
    const twoMeasures = approvalRuleListOutput({
      items: [
        {
          id: "small-refunds",
          name: "Small refunds to known customers",
          tools: ["stripe__create_refund@*"],
          enabled: true,
          maxMeasures: { amount: "50000000", rows: "10" },
          allowTargets: { counterparty: ["cus_*"], environment: ["prod"] },
          standingWindowMs: null,
          businessHours: null,
          createdBy: "usr_01k5a1",
          createdAt: "2026-09-12T10:00:00.000Z",
          authoredConsequences: ["moves_money"],
          hits30d: 0,
          skipped30d: 0,
        },
      ],
    });
    invoke.mockResolvedValueOnce(twoMeasures).mockResolvedValueOnce(written());
    const onlyRule = twoMeasures.items[0];
    if (onlyRule === undefined) throw new Error("the fixture holds one rule");
    expect(
      await saveApprovalRule(
        "acme",
        "core-platform",
        "edit",
        { ...onlyRule, name: "Small refunds" },
        {
          ...onlyRule,
          maxMeasures: { rows: "10", amount: "50000000" },
          allowTargets: { environment: ["prod"], counterparty: ["cus_*"] },
        },
      ),
    ).toEqual({ ok: true, value: { ruleId: "small-refunds" } });
  });

  it("returns the handler's reason when the save is refused", async () => {
    invoke.mockResolvedValueOnce(stored()).mockRejectedValueOnce(
      new kernel.HandlerError({
        code: "conflict",
        reason: "no_tool_matches",
      }),
    );
    expect(
      await saveApprovalRule("acme", "core-platform", "create", draft, null),
    ).toEqual({ ok: false, reason: "conflict", code: "no_tool_matches" });
  });

  it("is refused before the kernel writes when a ceiling is not an integer string", async () => {
    invoke.mockResolvedValueOnce(stored());
    const result = await saveApprovalRule(
      "acme",
      "core-platform",
      "create",
      { ...draft, maxMeasures: { amount: "12.50" } },
      null,
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).toHaveBeenCalledTimes(1);
  });
});

describe("setApprovalRuleEnabled", () => {
  it("switches one rule without sending the set", async () => {
    invoke.mockResolvedValue(approvalRuleListOutput());
    expect(
      await setApprovalRuleEnabled(
        "acme",
        "core-platform",
        "small-refunds",
        false,
      ),
    ).toEqual({ ok: true, value: { ruleId: "small-refunds", enabled: false } });
    expect(invoke).toHaveBeenCalledWith(
      "set_approval_rule_enabled",
      { ruleId: "small-refunds", enabled: false },
      expect.objectContaining(TENANT),
    );
  });

  it("returns the handler's reason when the role gate refuses it", async () => {
    invoke.mockRejectedValue(refused("org_role_required"));
    expect(
      await setApprovalRuleEnabled(
        "acme",
        "core-platform",
        "small-refunds",
        true,
      ),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });
});

describe("deleteApprovalRule", () => {
  it("removes the one rule it names", async () => {
    invoke.mockResolvedValue(approvalRuleListOutput());
    expect(
      await deleteApprovalRule("acme", "core-platform", "repeat-deploys"),
    ).toEqual({ ok: true, value: { ruleId: "repeat-deploys" } });
    expect(invoke).toHaveBeenCalledWith(
      "delete_approval_rule",
      { ruleId: "repeat-deploys" },
      expect.objectContaining(TENANT),
    );
  });

  it("is refused before the kernel when the id is not a rule id", async () => {
    expect(
      await deleteApprovalRule("acme", "core-platform", "Not A Slug"),
    ).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("addConnection", () => {
  const output = {
    connectionId: "7c000000-0000-4000-8000-0000000000c9",
    publicId: "con_01k5n9",
    status: "pending_setup" as const,
    connectorId: "linear",
    displayName: "Acme Linear",
  };

  it("sends the credential under the scheme picked and answers no part of it", async () => {
    invoke.mockResolvedValue(output);
    const result = await addConnection("acme", "core-platform", {
      connectorId: " linear ",
      displayName: " Acme Linear ",
      scheme: "bearer_token",
      secrets: { token: " tok-live-secret " },
      deliveryMethod: "",
    });
    expect(invoke).toHaveBeenCalledWith(
      "create_connection",
      {
        connectorId: "linear",
        displayName: "Acme Linear",
        // `scheme` is what the connectors read; `type` is what the handler
        // records as the connection's authScheme. Both name the same scheme.
        authCredential: {
          scheme: "bearer_token",
          type: "bearer_token",
          token: " tok-live-secret ",
        },
      },
      expect.objectContaining(TENANT),
    );
    // The value the page is handed carries the connection, never the secret.
    expect(result).toEqual({
      ok: true,
      value: {
        id: "con_01k5n9",
        status: "pending_setup",
        connectorId: "linear",
        displayName: "Acme Linear",
      },
    });
    expect(JSON.stringify(result)).not.toContain("tok-live-secret");
  });

  it("carries a delivery method only when one was typed", async () => {
    invoke.mockResolvedValue(output);
    await addConnection("acme", "core-platform", {
      connectorId: "linear",
      displayName: "Acme Linear",
      scheme: "api_key",
      secrets: { apiKey: "k" },
      deliveryMethod: " webhook ",
    });
    expect(invoke).toHaveBeenCalledWith(
      "create_connection",
      expect.objectContaining({ deliveryMethod: "webhook" }),
      expect.objectContaining(TENANT),
    );
  });

  it("is refused before the kernel when a scheme field is blank", async () => {
    expect(
      await addConnection("acme", "core-platform", {
        connectorId: "linear",
        displayName: "Acme Linear",
        scheme: "basic_auth",
        secrets: { username: "ops", password: "  " },
        deliveryMethod: "",
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "secrets",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's reason when the role gate refuses it", async () => {
    invoke.mockRejectedValue(refused("org_role_required"));
    expect(
      await addConnection("acme", "core-platform", {
        connectorId: "linear",
        displayName: "Acme Linear",
        scheme: "api_key",
        secrets: { apiKey: "k" },
        deliveryMethod: "",
      }),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });
});

describe("readConnection", () => {
  it("answers the connection as the drawer's view model, with no uuid on it", async () => {
    invoke.mockResolvedValue(connectionGetOutput());
    const result = await readConnection(
      "acme",
      "core-platform",
      " con_01k5n1 ",
    );
    expect(invoke).toHaveBeenCalledWith(
      "get_connection",
      { connectionId: "con_01k5n1" },
      expect.objectContaining(TENANT),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // INV-11: the contract carries the row's uuid and the view model does not.
    expect(result.value.id).toBe("con_01k5n1");
    expect(JSON.stringify(result.value)).not.toContain(
      "7c000000-0000-4000-8000-0000000000c1",
    );
  });

  it("reports a refused read with the permission the page names", async () => {
    // A read's denial is carried as the Tools page's own permission, not as
    // the handler's reason: `kernelRead` classifies it before the action does.
    invoke.mockRejectedValue(refused("org_role_required"));
    expect(await readConnection("acme", "core-platform", "con_01k5n1")).toEqual(
      { ok: false, reason: "denied", code: "tools.read" },
    );
  });
});

describe("registerServer", () => {
  const output = {
    mcpServerId: "mcs_01k5s9",
    healthStatus: "healthy" as const,
    discoveredTools: ["get_page"],
  };

  it("registers the server and answers the probe's health and pins", async () => {
    invoke.mockResolvedValue(output);
    expect(
      await registerServer("acme", "core-platform", {
        name: " Notion ",
        transportType: "streamable-http",
        endpointUrl: " https://mcp.notion.example/v1 ",
        authStrategy: "bearer",
        authConfig: { token: " secret-value " },
      }),
    ).toEqual({
      ok: true,
      value: {
        serverId: "mcs_01k5s9",
        healthStatus: "healthy",
        discoveredTools: ["get_page"],
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "register_mcp_server",
      {
        name: "Notion",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.notion.example/v1",
        authStrategy: "bearer",
        authConfig: { token: "secret-value" },
      },
      expect.objectContaining(TENANT),
    );
  });

  it("sends no auth config when the strategy carries no secret", async () => {
    invoke.mockResolvedValue(output);
    await registerServer("acme", "core-platform", {
      name: "Notion",
      transportType: "streamable-http",
      endpointUrl: "https://mcp.notion.example/v1",
      authStrategy: "none",
      authConfig: {},
    });
    expect(invoke).toHaveBeenCalledWith(
      "register_mcp_server",
      {
        name: "Notion",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.notion.example/v1",
        authStrategy: "none",
      },
      expect.objectContaining(TENANT),
    );
  });

  it("is refused before the kernel when a bearer strategy carries no secret", async () => {
    expect(
      await registerServer("acme", "core-platform", {
        name: "Notion",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.notion.example/v1",
        authStrategy: "bearer",
        authConfig: { token: "   " },
      }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "invalid_input",
      field: "authConfig",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a viewer without the org role the contract declares", async () => {
    // `register_mcp_server`'s handler asserts nothing and checkIAM fast-paths
    // a non-enterprise org, so this gate is the one that holds (#3258).
    requireViewer.mockResolvedValue(member);
    expect(
      await registerServer("acme", "core-platform", {
        name: "Notion",
        transportType: "streamable-http",
        endpointUrl: "https://mcp.notion.example/v1",
        authStrategy: "none",
        authConfig: {},
      }),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("removeProvider", () => {
  it("removes the provider through delete_mcp_server and answers that it went", async () => {
    invoke.mockResolvedValue({ mcpServerId: "mcs_01k5s9", deleted: true });
    expect(
      await removeProvider("acme", "core-platform", " mcs_01k5s9 "),
    ).toEqual({ ok: true, value: { deleted: true } });
    expect(invoke).toHaveBeenCalledWith(
      "delete_mcp_server",
      { mcpServerId: "mcs_01k5s9" },
      expect.objectContaining(TENANT),
    );
  });

  it("answers deleted: false for a provider that was already gone (negative)", async () => {
    invoke.mockResolvedValue({ mcpServerId: "mcs_01k5s9", deleted: false });
    expect(await removeProvider("acme", "core-platform", "mcs_01k5s9")).toEqual(
      { ok: true, value: { deleted: false } },
    );
  });

  it("passes on the handler's refusal with nothing removed (negative)", async () => {
    // The handler asserts an org Owner or Admin itself (INV-29), so the
    // refusal comes back from the kernel rather than from a gate here.
    invoke.mockRejectedValue(refused("org_role_required"));
    expect(await removeProvider("acme", "core-platform", "mcs_01k5s9")).toEqual(
      { ok: false, reason: "denied", code: "org_role_required" },
    );
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { BACKING, allMethods } from "@/data/backing";
import * as C from "@/data/contracts";
import { FIXTURE_TENANT } from "@/data/fixture-tenant";
import type { Read } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { DataSource, PortName } from "@/data/ports";
import { ORG_ONLY_WORKSPACE_ID, type Scope } from "@/data/scope";
import { FIXTURE_USER } from "@/server/fixture-session";
import { type FixtureOptions, createFixtureSource } from "./index";
import { seed } from "./seed";

const CORE: Scope = {
  orgId: FIXTURE_TENANT.orgId,
  workspaceId: FIXTURE_TENANT.workspaces["core-platform"],
};
const FINOPS: Scope = {
  orgId: FIXTURE_TENANT.orgId,
  workspaceId: FIXTURE_TENANT.workspaces.finops,
};
const ORG: Scope = {
  orgId: FIXTURE_TENANT.orgId,
  workspaceId: ORG_ONLY_WORKSPACE_ID,
};
/** A tenant the fixture does not hold. */
const FOREIGN_ORG: Scope = {
  orgId: "7f1c2a9e-0000-4000-8000-000000000000",
  workspaceId: FIXTURE_TENANT.workspaces["core-platform"],
};
/** The fixture organization with a workspace id it does not have. */
const UNKNOWN_WS: Scope = {
  orgId: FIXTURE_TENANT.orgId,
  workspaceId: "913d6df1-0000-4000-8000-000000000000",
};
const NOW = Date.parse("2026-09-11T16:00:00Z");

/** Arguments after the scope, per method, that name real seeded rows. */
const ARGS: Record<string, unknown[]> = {
  "runs.listRuns": [{ filter: "all" }],
  "runs.getRun": ["run_01K5RS7M2E8FJ3QW"],
  "runs.framesSince": ["run_01K5RS7M2E8FJ3QW", "-1"],
  "runs.transcript": ["run_01K5RS7M2E8FJ3QW"],
  "runs.runGraph": ["run_01K5RS7M2E8FJ3QW"],
  "runs.contextWindow": ["run_01K5RS7M2E8FJ3QW"],
  "runs.proof": ["run_01K5RQ4B9C7XTN2P"],
  "agents.getAgent": ["acme.core.release-manager"],
  "agents.toolbelt": ["acme.core.release-manager"],
  "agents.definition": ["acme.core.release-manager"],
  "agents.scores": ["acme.core.release-manager"],
  "agents.incidents": ["acme.core.release-manager"],
  "agents.mandates": ["acme.core.release-manager"],
  "agents.getMandate": ["mnd_7K2ETQ4"],
  "tools.policySimulation": ["pol_v42"],
  "spend.drill": ["agent", "acme.core.triage"],
  "spend.findingEvidence": ["fnd_01K5RTEG"],
  "spend.findingFix": ["fnd_01K5RT6C"],
  "audit.getReceipt": ["rcp_01K4X8M2E"],
  "shell.context": [FIXTURE_USER.id],
  "shell.notifications": [FIXTURE_USER.id],
  "shell.account": [FIXTURE_USER.id],
  "onboarding.installerOffer": ["gate"],
  "onboarding.firstFrameScript": [
    {
      flow: "gate",
      agentKey: "acme.core.perf-watch",
      harness: "claude-code",
      operator: "Marcus Bell",
    },
  ],
};

/** Methods whose arguments are not scope-first. */
const CALL: Record<
  string,
  (source: DataSource, scope: Scope) => Promise<Read<unknown>>
> = {
  "onboarding.invitation": (source) =>
    source.onboarding.invitation("invi_acme_pending"),
  "onboarding.gate": (source, scope) => source.onboarding.gate("gate", scope),
};

/**
 * Tenancy-grade lookups the state switch never applies to (like the fixture
 * tenancy in src/server): a page's error or denied state still renders inside
 * a resolved flow.
 */
const STATE_EXEMPT = new Set([
  "onboarding.namespaces",
  "onboarding.invitation",
]);
/** Unscoped: the invitation token is the capability, so there is no organization to refuse. */
const FENCE_EXEMPT = new Set(["onboarding.invitation"]);

/** Methods whose seeded row lives outside core-platform, with the scope that sees it. */
const SCOPE: Record<string, Scope> = {
  "agents.getMandate": FINOPS,
};

const list = <T extends z.ZodType>(schema: T) => z.array(schema);
/** The contract each method's value must parse through: the adapter cannot lie about a shape. */
const RESULT: Record<string, z.ZodType> = {
  "runs.listRuns": C.RunPage,
  "runs.getRun": C.RunDetail,
  "runs.framesSince": list(C.Frame),
  "runs.transcript": list(C.TranscriptEntry),
  "runs.runGraph": C.RunGraph,
  "runs.contextWindow": C.ContextWindow.nullable(),
  "runs.proof": C.RunProof.nullable(),
  "approvals.pending": list(C.ApprovalItem),
  "agents.listAgents": list(C.AgentRow),
  "agents.getAgent": C.AgentDetail,
  "agents.toolbelt": C.Toolbelt,
  "agents.definition": C.AgentDefinition,
  "agents.scores": C.AgentScores,
  "agents.incidents": list(C.Incident),
  "agents.mandates": list(C.Mandate),
  "agents.getMandate": C.MandateDetail,
  "iam.roles": list(C.Role),
  "iam.permissionCatalog": list(C.PermissionGroup),
  "tools.servers": list(C.ToolServer),
  "tools.toolVersions": list(C.ToolVersion),
  "tools.connections": list(C.Connection),
  "tools.observedSchemas": list(C.ObservedSchemaProposal),
  "tools.mandateLedger": list(C.MandateDetail),
  "tools.policyVersions": list(C.PolicyVersion),
  "tools.policySimulation": C.PolicySimulation.nullable(),
  "tools.killSwitches": list(C.KillSwitch),
  "tools.autoApprovalRules": list(C.AutoApprovalRule),
  "tools.assurance": C.AssuranceRun.nullable(),
  "ontology.classes": list(C.OntologyClass),
  "ontology.sources": list(C.Source),
  "ontology.repositories": list(C.Repository),
  "ontology.versions": list(C.OntologyVersion),
  "ontology.embeddingIndexes": list(C.EmbeddingIndex),
  "steering.records": list(C.SteeringRecord),
  "steering.proposals": list(C.SteeringProposal),
  "steering.effect": list(C.RecordEffect),
  "steering.retirementCandidates": list(C.RetirementCandidate),
  "spend.summary": C.SpendSummary,
  "spend.byOperator": list(C.SpendByOperator),
  "spend.byAgent": list(C.SpendByAgent),
  "spend.byModel": list(C.SpendByModel),
  "spend.byTool": list(C.SpendByTool),
  "spend.waste": C.WasteReport,
  "spend.drill": C.SpendDrill,
  "spend.findings": list(C.Finding),
  "spend.findingEvidence": C.FindingEvidence,
  "spend.findingFix": C.FindingFix,
  "spend.reconciliation": C.ReconciliationSummary,
  "spend.budgets": list(C.Budget),
  "org.organization": C.Organization,
  "org.members": list(C.Member),
  "org.invitations": list(C.Invitation),
  "org.workspaces": list(C.Workspace),
  "org.apiKeys": list(C.ApiKey),
  "org.dataPlanes": list(C.DataPlane),
  "org.modelFunding": C.ModelFunding,
  "billing.plan": C.BillingPlan,
  "billing.allowance": C.RunAllowance,
  "billing.meters": list(C.Meter),
  "billing.invoices": list(C.Invoice),
  "audit.events": list(C.AuditEvent),
  "audit.incidents": list(C.Incident),
  "audit.receipts": list(C.Receipt),
  "audit.getReceipt": C.Receipt,
  "audit.holds": list(C.LegalHold),
  "audit.exports": list(C.ArchiveExport),
  "audit.keys": list(C.EncryptionKey),
  "audit.erasure": list(C.ErasureRequest),
  "audit.retention": list(C.RetentionTier),
  "audit.assuranceHistory": list(C.AssuranceHistoryRow),
  "shell.context": C.ShellContext,
  "shell.navCounts": z.record(z.string(), C.NavCounts),
  "shell.notifications": C.NotificationFeed,
  "shell.people": list(C.Person),
  "shell.assistantEngine": C.AssistantEngine,
  "shell.recentRuns": list(C.CommandRun),
  "shell.account": C.AccountView,
  "onboarding.namespaces": C.FlowNamespaces,
  "onboarding.invitation": C.InvitationView,
  "onboarding.gate": C.OnboardingGate,
  "onboarding.installerOffer": C.InstallerOffer,
  "onboarding.firstFrameScript": C.FirstFrameScript,
  "onboarding.detectedRepository": C.DetectedRepository,
};

type Invoke = (
  source: DataSource,
  port: PortName,
  method: string,
  scope?: Scope,
) => Promise<Read<unknown>>;
const invoke: Invoke = (
  source,
  port,
  method,
  scope = SCOPE[`${port}.${method}`] ?? CORE,
) => {
  const call = CALL[`${port}.${method}`];
  if (call) return call(source, scope);
  const target = source[port] as unknown as Record<
    string,
    (...args: unknown[]) => Promise<Read<unknown>>
  >;
  const fn = target[method];
  if (!fn) throw new Error(`no method ${port}.${method}`);
  return fn(scope, ...(ARGS[`${port}.${method}`] ?? []));
};

function source(cookie?: string, overrides: Partial<FixtureOptions> = {}) {
  return createFixtureSource({
    seed,
    readState: () => Promise.resolve(cookie),
    loadingMs: 25,
    sleep: () => Promise.resolve(),
    now: () => NOW,
    ...overrides,
  });
}

const ok = <T>(read: Read<T>): T => {
  if (!read.ok)
    throw new Error(`expected a loaded read, got ${JSON.stringify(read)}`);
  return read.value;
};

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("MC_DATA", "fixture");
});
afterEach(() => {
  vi.unstubAllEnvs();
});

const methods = allMethods().map(({ port, method, backing }) => ({
  port,
  method,
  page: backing.page,
  name: `${port}.${method}`,
}));

describe("fixture source · loaded", () => {
  it("covers every method with a result contract", () => {
    expect(Object.keys(RESULT).sort()).toEqual(
      methods.map((m) => m.name).sort(),
    );
  });

  it.each(methods)(
    "$name returns a value its contract accepts",
    async ({ port, method, name }) => {
      const read = await invoke(source(), port, method);
      const schema = RESULT[name];
      if (!schema) throw new Error(`no schema for ${name}`);
      expect(schema.safeParse(ok(read)).success).toBe(true);
    },
  );
});

const switched = methods.filter((m) => !STATE_EXEMPT.has(m.name));

describe("fixture source · mc_state", () => {
  it.each(switched)(
    "$name fails with its page's §2.1 error code",
    async ({ port, method, page }) => {
      const cookie = page === "shell" ? "shell:error" : "error";
      expect(await invoke(source(cookie), port, method)).toEqual({
        ok: false,
        reason: "error",
        code: PAGE_FAILURES[page].error.code,
        status: PAGE_FAILURES[page].error.status,
      });
    },
  );

  it.each(switched)(
    "$name is denied on its page's permission",
    async ({ port, method, page }) => {
      expect(await invoke(source(`${page}:denied`), port, method)).toEqual({
        ok: false,
        reason: "denied",
        permission: PAGE_FAILURES[page].permission,
      });
    },
  );

  it.each(switched)(
    "$name reports the milestone and gap it waits on",
    async ({ port, method }) => {
      const table = BACKING[port] as Record<
        string,
        { milestone: string; gap: string }
      >;
      expect(
        await invoke(source("not_backed,shell:not_backed"), port, method),
      ).toEqual({
        ok: false,
        reason: "not_backed",
        milestone: table[method]?.milestone,
        gap: table[method]?.gap,
      });
    },
  );

  it.each(methods)(
    "$name has an empty value its contract accepts",
    async ({ port, method, name }) => {
      const read = await invoke(source("empty,shell:empty"), port, method);
      const schema = RESULT[name];
      if (!schema) throw new Error(`no schema for ${name}`);
      expect(schema.safeParse(ok(read)).success).toBe(true);
    },
  );

  it("empties lists, and leaves a page with no empty state loaded", async () => {
    const empty = source("empty");
    expect(ok(await empty.runs.listRuns(CORE, { filter: "all" })).rows).toEqual(
      [],
    );
    expect(ok(await empty.approvals.pending(CORE))).toEqual([]);
    expect(ok(await empty.runs.getRun(CORE, "run_01K5RS7M2E8FJ3QW")).id).toBe(
      "run_01K5RS7M2E8FJ3QW",
    );
    const mandate = ok(await empty.agents.getMandate(FINOPS, "mnd_7K2ETQ4"));
    expect(mandate.ledger).toEqual([]);
    expect(mandate.mandate.usage.remaining).toEqual(
      mandate.mandate.limits.perPeriod,
    );
    expect(await empty.agents.getMandate(CORE, "mnd_missing")).toMatchObject({
      reason: "error",
      status: 404,
    });
  });

  it("holds a loading read for the configured time, then resolves loaded", async () => {
    const sleep = vi.fn(() => Promise.resolve());
    const loading = source("fleet:loading", { sleep, loadingMs: 1234 });
    expect(
      ok(await loading.runs.listRuns(CORE, { filter: "all" })).rows.length,
    ).toBeGreaterThan(0);
    expect(sleep).toHaveBeenCalledWith(1234);
    await loading.spend.summary(CORE);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("scopes a state to its page: an error on Fleet leaves Spend loaded", async () => {
    const s = source("fleet:error");
    expect((await s.runs.listRuns(CORE, { filter: "all" })).ok).toBe(false);
    expect((await s.spend.summary(CORE)).ok).toBe(true);
  });

  it("keeps the shell loaded under a global error", async () => {
    expect(
      (await source("error").shell.notifications(CORE, FIXTURE_USER.id)).ok,
    ).toBe(true);
  });

  it("never switches the tenancy-grade onboarding lookups", async () => {
    const s = source("error,welcome:denied");
    expect(ok(await s.onboarding.namespaces(CORE))).toEqual({
      org: "acme",
      ws: "core",
    });
    expect(ok(await s.onboarding.namespaces(FINOPS)).ws).toBe("finops");
    expect(ok(await s.onboarding.invitation("invi_acme_pending")).status).toBe(
      "pending",
    );
  });

  it("reads the gate's states per flow: the gate is the welcome page, Register its own", async () => {
    const s = source("welcome:denied");
    expect(await s.onboarding.gate("gate", null)).toEqual({
      ok: false,
      reason: "denied",
      permission: "org.create",
    });
    expect((await s.onboarding.gate("register", CORE)).ok).toBe(true);
    expect(
      await source("register:denied").onboarding.gate("register", CORE),
    ).toMatchObject({ reason: "denied", permission: "agent.register" });
  });

  it("finds no invitation, namespace or foreign gate that is not there (negative)", async () => {
    const s = source();
    for (const token of ["invi_missing", "toString", "__proto__"])
      expect(await s.onboarding.invitation(token)).toMatchObject({
        code: "invitation_not_found",
        status: 404,
      });
    expect(await s.onboarding.namespaces(UNKNOWN_WS)).toMatchObject({
      code: "workspace_not_found",
      status: 404,
    });
    expect(await s.onboarding.namespaces(ORG)).toMatchObject({ status: 404 });
    expect(await s.onboarding.gate("gate", FOREIGN_ORG)).toMatchObject({
      code: "organization_not_found",
    });
  });

  it("fills the first frame in for the agent being wrapped", async () => {
    const script = ok(
      await source().onboarding.firstFrameScript(CORE, {
        flow: "register",
        agentKey: "acme.core.perf-watch",
        harness: "codex-cli",
        operator: "Marcus Bell",
      }),
    );
    expect(script.frames.map((f) => f.body).join(" ")).not.toMatch(/\{\w+\}/);
    expect(script.frames[0]?.body).toContain("harness=codex-cli");
    expect(script.frames[1]?.body).toContain("agent=acme.core.perf-watch");
  });

  it("reports the assistant engine down on assistant:down (W9)", async () => {
    expect(
      ok(await source("assistant:down").shell.assistantEngine(CORE)).status,
    ).toBe("down");
    expect(ok(await source().shell.assistantEngine(CORE)).status).toBe("up");
  });

  it("ignores the cookie in a production build (negative)", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const readState = vi.fn(() => Promise.resolve("error"));
    const read = await source(undefined, { readState }).runs.listRuns(CORE, {
      filter: "all",
    });
    expect(read.ok).toBe(true);
    expect(readState).not.toHaveBeenCalled();
  });

  it("ignores the cookie against live data (negative)", async () => {
    vi.stubEnv("MC_DATA", "live");
    expect((await source("denied").org.members(ORG)).ok).toBe(true);
  });
});

describe("fixture source · reads", () => {
  it("scopes workspace reads to the viewer's workspace", async () => {
    const core = ok(await source().runs.listRuns(CORE, { filter: "all" })).rows;
    const finops = ok(
      await source().runs.listRuns(FINOPS, { filter: "all" }),
    ).rows;
    expect(core.every((r) => r.workspaceSlug === "core-platform")).toBe(true);
    expect(finops.every((r) => r.workspaceSlug === "finops")).toBe(true);
    expect(core.length + finops.length).toBe(seed.runs.length);
    expect(
      ok(await source().agents.listAgents(FINOPS)).map((a) => a.key),
    ).toEqual(["acme.finops.invoice-bot"]);
    expect(
      ok(await source().approvals.pending(FINOPS)).map((a) => a.id),
    ).toEqual(["apr_01K5RN9T4"]);
  });

  it("reads organization scopes across workspaces", async () => {
    expect(
      ok(await source().runs.listRuns(ORG, { filter: "all" })).rows,
    ).toHaveLength(seed.runs.length);
  });

  it("filters Fleet by live and proven", async () => {
    const live = ok(await source().runs.listRuns(ORG, { filter: "live" })).rows;
    const proven = ok(
      await source().runs.listRuns(ORG, { filter: "proven" }),
    ).rows;
    expect(live.map((r) => r.status).sort()).toEqual(["live", "parked"]);
    expect(proven.every((r) => r.verdict === "flipped")).toBe(true);
    expect(proven.length).toBeGreaterThan(0);
  });

  it("does not show a run from another workspace (negative)", async () => {
    expect(await source().runs.getRun(FINOPS, "run_01K5RS7M2E8FJ3QW")).toEqual({
      ok: false,
      reason: "error",
      code: "run_not_found",
      status: 404,
    });
    expect(
      await source().agents.getAgent(FINOPS, "acme.core.triage"),
    ).toMatchObject({ code: "agent_not_found" });
  });

  it.each([
    ["runs.transcript", "runs", "transcript"],
    ["runs.runGraph", "runs", "runGraph"],
    ["runs.contextWindow", "runs", "contextWindow"],
    ["runs.proof", "runs", "proof"],
    ["agents.toolbelt", "agents", "toolbelt"],
    ["agents.definition", "agents", "definition"],
    ["agents.scores", "agents", "scores"],
    ["agents.incidents", "agents", "incidents"],
    ["agents.mandates", "agents", "mandates"],
  ] as const)(
    "%s is 404 for an unknown id (negative)",
    async (_name, port, method) => {
      const target = source()[port] as unknown as Record<
        string,
        (s: Scope, id: string) => Promise<Read<unknown>>
      >;
      expect(await target[method]?.(CORE, "nope_unknown")).toMatchObject({
        reason: "error",
        status: 404,
      });
    },
  );

  it.each([
    ["spend.drill", () => source().spend.drill(CORE, "tool", "nope")],
    [
      "spend.findingEvidence",
      () => source().spend.findingEvidence(CORE, "fnd_nope"),
    ],
    ["spend.findingFix", () => source().spend.findingFix(CORE, "fnd_nope")],
    ["audit.getReceipt", () => source().audit.getReceipt(CORE, "rcp_nope")],
    [
      "runs.framesSince",
      () => source().runs.framesSince(CORE, "run_nope", "0"),
    ],
  ] as const)("%s is 404 for an unknown id (negative)", async (_name, call) => {
    expect(await call()).toMatchObject({ reason: "error", status: 404 });
  });

  it("returns frames after a cursor, oldest first, up to a limit", async () => {
    const frames = ok(
      await source().runs.framesSince(CORE, "run_01K5RS7M2E8FJ3QW", "12", 2),
    );
    expect(frames.map((f) => f.seq)).toEqual(["13", "14"]);
    expect(
      ok(await source().runs.framesSince(CORE, "run_01K5RS7M2E8FJ3QW", "15")),
    ).toEqual([]);
    expect(
      ok(await source().runs.framesSince(CORE, "run_01K5RQ4B9C7XTN2P", "-1")),
    ).toEqual([]);
  });

  it("refuses a malformed cursor (negative)", async () => {
    expect(
      await source().runs.framesSince(CORE, "run_01K5RS7M2E8FJ3QW", "abc"),
    ).toEqual({
      ok: false,
      reason: "error",
      code: "invalid_cursor",
      status: 400,
    });
  });

  it("keeps a pending approval pending by re-basing its clock on now", async () => {
    const approvals = ok(await source().approvals.pending(ORG));
    const release = approvals.find((a) => a.id === "apr_01K5RS3K7");
    expect(release?.requestedAt).toBe(new Date(NOW - 47_000).toISOString());
    expect(release?.expiresAt).toBe(
      new Date(NOW - 47_000 + 600_000).toISOString(),
    );
    const expired = approvals.find((a) => a.id === "apr_01K5RH8M2");
    expect(expired?.status).toBe("expired");
    expect(expired?.expiresAt).toBe("2026-09-11T07:41:31Z");
  });

  it("filters approvals by run for the Run page strip", async () => {
    expect(
      ok(
        await source().approvals.pending(CORE, {
          runId: "run_01K5RS7M2E8FJ3QW",
        }),
      ).map((a) => a.id),
    ).toEqual(["apr_01K5RS3K7"]);
  });

  it("keeps the workspace filter when filtering approvals by run (negative)", async () => {
    // run_01K5RN8F3J2GHY6T is a finops run; a core-platform viewer must not see its approval.
    expect(
      ok(
        await source().approvals.pending(CORE, {
          runId: "run_01K5RN8F3J2GHY6T",
        }),
      ),
    ).toEqual([]);
    expect(
      ok(
        await source().approvals.pending(FINOPS, {
          runId: "run_01K5RN8F3J2GHY6T",
        }),
      ).map((a) => a.id),
    ).toEqual(["apr_01K5RN9T4"]);
  });

  it("shows an unknown workspace nothing (negative)", async () => {
    const s = source();
    expect(ok(await s.approvals.pending(UNKNOWN_WS))).toEqual([]);
    expect(
      ok(
        await s.approvals.pending(UNKNOWN_WS, {
          runId: "run_01K5RS7M2E8FJ3QW",
        }),
      ),
    ).toEqual([]);
    expect(
      ok(await s.runs.listRuns(UNKNOWN_WS, { filter: "all" })).rows,
    ).toEqual([]);
    expect(ok(await s.agents.listAgents(UNKNOWN_WS))).toEqual([]);
    expect(ok(await s.tools.autoApprovalRules(UNKNOWN_WS))).toEqual([]);
    expect(ok(await s.tools.mandateLedger(UNKNOWN_WS))).toEqual([]);
    expect(
      await s.runs.getRun(UNKNOWN_WS, "run_01K5RS7M2E8FJ3QW"),
    ).toMatchObject({ code: "run_not_found", status: 404 });
    expect(await s.agents.getMandate(UNKNOWN_WS, "mnd_7K2ETQ4")).toMatchObject({
      code: "mandate_not_found",
      status: 404,
    });
  });

  it("shows another organization nothing (negative)", async () => {
    const s = source();
    expect(await s.approvals.pending(FOREIGN_ORG)).toEqual({
      ok: false,
      reason: "error",
      code: "organization_not_found",
      status: 404,
    });
    expect(
      await s.approvals.pending(
        { ...FOREIGN_ORG, workspaceId: ORG_ONLY_WORKSPACE_ID },
        { runId: "run_01K5RS7M2E8FJ3QW" },
      ),
    ).toMatchObject({ ok: false, code: "organization_not_found" });
  });

  it.each(methods.filter((m) => !FENCE_EXEMPT.has(m.name)))(
    "$name refuses a scope from another organization (negative)",
    async ({ port, method }) => {
      for (const cookie of [undefined, "empty,shell:empty"]) {
        expect(
          await invoke(source(cookie), port, method, FOREIGN_ORG),
        ).toMatchObject({ ok: false, code: "organization_not_found" });
      }
    },
  );

  describe.each([
    ["core-platform", CORE],
    ["finops", FINOPS],
  ] as const)("spend under %s", (slug, scope) => {
    /** Every run id and agent key a spend read hands the page, from every drill and finding. */
    async function spendReferences() {
      const s = source();
      const runIds: string[] = [];
      const agentKeys: string[] = [];
      for (const row of ok(await s.spend.byAgent(scope)))
        agentKeys.push(row.agentKey);
      for (const r of ok(await s.spend.waste(scope)).worstRuns)
        runIds.push(r.runId);
      for (const d of seed.spend.drills) {
        const read = await s.spend.drill(scope, d.kind, d.id);
        if (!read.ok) continue;
        if (read.value.kind === "agent") agentKeys.push(read.value.id);
        for (const slice of read.value.agents)
          if (slice.key !== null) agentKeys.push(slice.key);
      }
      for (const f of ok(await s.spend.findings(scope))) {
        if (f.level === "agent") agentKeys.push(f.subject);
        const evidence = ok(await s.spend.findingEvidence(scope, f.id));
        if (evidence.who.agentKey) agentKeys.push(evidence.who.agentKey);
        for (const cited of evidence.runs)
          if (cited.runId) runIds.push(cited.runId);
        expect((await s.spend.findingFix(scope, f.id)).ok).toBe(true);
      }
      return { runIds, agentKeys };
    }

    it("links only to runs and agents the same scope can open (W4)", async () => {
      const s = source();
      const { runIds, agentKeys } = await spendReferences();
      expect(runIds.length).toBeGreaterThan(0);
      expect(agentKeys.length).toBeGreaterThan(0);
      for (const id of runIds)
        expect((await s.runs.getRun(scope, id)).ok, id).toBe(true);
      for (const key of agentKeys)
        expect((await s.agents.getAgent(scope, key)).ok, key).toBe(true);
    });

    it("hides the other workspace's spend drills, findings and evidence (negative)", async () => {
      const s = source();
      const visible = new Set(
        ok(await s.spend.findings(scope)).map((f) => f.id),
      );
      const others = seed.spend.findings.filter((f) => !visible.has(f.id));
      expect(others.length).toBeGreaterThan(0);
      for (const f of others) {
        expect(await s.spend.findingEvidence(scope, f.id)).toMatchObject({
          code: "finding_not_found",
          status: 404,
        });
        expect(await s.spend.findingFix(scope, f.id)).toMatchObject({
          code: "finding_not_found",
          status: 404,
        });
      }
      const foreignAgents = seed.agents.filter((a) => a.workspaceSlug !== slug);
      expect(foreignAgents.length).toBeGreaterThan(0);
      for (const a of foreignAgents)
        expect(await s.spend.drill(scope, "agent", a.key)).toMatchObject({
          code: "drill_not_found",
          status: 404,
        });
    });
  });

  it("spells out the finops finding a core-platform viewer cannot open (negative)", async () => {
    const s = source();
    // fnd_01K5RTGH is a tool finding whose evidence names acme.finops.invoice-bot
    // and cites two finops runs.
    expect(await s.spend.findingEvidence(CORE, "fnd_01K5RTGH")).toMatchObject({
      code: "finding_not_found",
    });
    expect(
      ok(await s.spend.byAgent(CORE)).map((r) => r.agentKey),
    ).not.toContain("acme.finops.invoice-bot");
    expect(
      await s.spend.drill(CORE, "agent", "acme.finops.invoice-bot"),
    ).toMatchObject({ code: "drill_not_found", status: 404 });
    const evidence = ok(await s.spend.findingEvidence(FINOPS, "fnd_01K5RTGH"));
    expect(evidence.runs.map((r) => r.runId)).toEqual([
      "run_01K5RN8F3J2GHY6T",
      "run_01K5RF2J7M3EDC5F",
      null,
    ]);
    expect(
      ok(await s.spend.waste(CORE)).worstRuns.map((r) => r.runId),
    ).not.toContain("run_01K5RN8F3J2GHY6T");
    // The organization scope still sees every workspace's spend.
    expect(ok(await s.spend.findings(ORG))).toHaveLength(
      seed.spend.findings.length,
    );
    expect(ok(await s.spend.byAgent(ORG))).toHaveLength(
      seed.spend.byAgent.length,
    );
  });

  it("shows a mandate only to the workspace of the agent that holds it (negative)", async () => {
    expect(await source().agents.getMandate(CORE, "mnd_7K2ETQ4")).toMatchObject(
      { code: "mandate_not_found", status: 404 },
    );
    expect(
      ok(await source().tools.mandateLedger(CORE)).map((d) => d.mandate.id),
    ).not.toContain("mnd_7K2ETQ4");
    expect(
      ok(await source().tools.mandateLedger(ORG)).map((d) => d.mandate.id),
    ).toContain("mnd_7K2ETQ4");
  });

  it("reads a mandate by its id, never the first mandate (W4)", async () => {
    const detail = ok(await source().agents.getMandate(FINOPS, "mnd_7K2ETQ4"));
    expect(detail.mandate.id).toBe("mnd_7K2ETQ4");
    expect(detail.ledger.map((e) => e.kind)).toEqual([
      "reserve",
      "settle",
      "settle",
      "release",
    ]);
    expect(await source().agents.getMandate(FINOPS, "mnd_nope")).toMatchObject({
      code: "mandate_not_found",
    });
  });

  it("filters tool versions by server and the simulation by version", async () => {
    const slack = ok(
      await source().tools.toolVersions(CORE, { serverId: "slack" }),
    );
    expect(slack.length).toBeGreaterThan(0);
    expect(slack.every((t) => t.serverId === "slack")).toBe(true);
    expect(
      ok(await source().tools.policySimulation(CORE, "pol_v41")),
    ).toBeNull();
  });

  it("returns a context window and proof only where the record has one", async () => {
    expect(
      ok(await source().runs.contextWindow(CORE, "run_01K5RP2D6H4KLM8V")),
    ).toBeNull();
    expect(
      ok(await source().runs.proof(CORE, "run_01K5RS7M2E8FJ3QW")),
    ).toBeNull();
    expect(
      ok(await source().runs.runGraph(CORE, "run_01K5RE9P4Q2WSX6C")).files,
    ).toEqual([]);
  });
});

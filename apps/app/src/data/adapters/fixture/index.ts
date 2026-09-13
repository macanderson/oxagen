// The fixture data source: the mockup's demo record behind every read port.
// Dev, Storybook and e2e only; src/data/source.ts selects it when
// NODE_ENV !== "production" and MC_DATA=fixture, and nothing else imports it.
//
// Every read passes through the `mc_state` switch (./state.ts) first, so one
// cookie can put any page in its loading, empty, error, denied or not-backed
// state with the page's own error code and permission (src/data/page-states.ts).
import { backingOf, notBackedFor } from "@/data/backing";
import type {
  ApprovalItem,
  Frame,
  RunDetail,
  RunGraph,
  RunRow,
  SpendSummary,
  WasteReport,
} from "@/data/contracts";
import { FIXTURE_TENANT, fixtureWorkspaceSlug } from "@/data/fixture-tenant";
import { type Read, denied, readError, readOk } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { DataSource, MethodName, PortName } from "@/data/ports";
import { ORG_ONLY_WORKSPACE_ID, type Scope } from "@/data/scope";
import { seed as defaultSeed } from "./seed";
import type { Seed } from "./seed-schema";
import {
  NO_STATE_SWITCH,
  isStateSwitchHonoured,
  parseStateSwitch,
  readStateCookie,
  stateFor,
} from "./state";

export type FixtureOptions = {
  seed: Seed;
  /** The raw `mc_state` cookie for the current request. */
  readState: () => Promise<string | undefined>;
  /** How long the `loading` state holds a read before it resolves loaded. */
  loadingMs: number;
  sleep: (ms: number) => Promise<void>;
  /** Wall clock, for re-basing approval countdowns so pending cards stay pending. */
  now: () => number;
};

const DEFAULT_LOADING_MS = 15_000;

const ZERO = { micros: "0", currency: "USD", basis: "mixed" } as const;
const USD_ZERO = { micros: "0", currency: "USD" } as const;
const EMPTY_GRAPH: RunGraph = {
  repositories: [],
  issues: [],
  artifacts: [],
  files: [],
};

const notFound = (what: string) => readError(`${what}_not_found`, 404);

function toRow(run: RunDetail): RunRow {
  const {
    model: _model,
    cacheHitRate: _cache,
    provenSpend: _proven,
    productiveRatio: _ratio,
    summary: _summary,
    touched: _touched,
    ...row
  } = run;
  return row;
}

export function createFixtureSource(options: FixtureOptions): DataSource {
  const { seed } = options;

  async function read<P extends PortName, T>(
    port: P,
    method: MethodName<P>,
    loaded: () => Read<T> | Promise<Read<T>>,
    /** Omitted for reads whose page has no empty state (§19): `empty` then reads loaded. */
    empty?: () => T,
  ): Promise<Read<T>> {
    const { page } = backingOf(port, method);
    const switches = isStateSwitchHonoured()
      ? parseStateSwitch(await options.readState())
      : NO_STATE_SWITCH;
    switch (stateFor(switches, page)) {
      case "loaded":
        return loaded();
      case "empty":
        return empty ? readOk(empty()) : loaded();
      case "loading":
        await options.sleep(options.loadingMs);
        return loaded();
      case "error":
        return readError(
          PAGE_FAILURES[page].error.code,
          PAGE_FAILURES[page].error.status,
        );
      case "denied":
        return denied(PAGE_FAILURES[page].permission);
      case "not_backed":
        return notBackedFor(port, method);
    }
  }

  /**
   * Workspace pages see their workspace; the organization-only scope sees every
   * workspace. Fails closed: another organization, or a workspace id the
   * fixture tenant does not have, sees nothing.
   */
  const inScope = (scope: Scope, workspaceSlug: string) => {
    if (scope.orgId !== FIXTURE_TENANT.orgId) return false;
    if (scope.workspaceId === ORG_ONLY_WORKSPACE_ID) return true;
    return fixtureWorkspaceSlug(scope.workspaceId) === workspaceSlug;
  };
  const found = <T>(value: T | undefined, what: string): Read<T> =>
    value === undefined ? notFound(what) : readOk(value);
  const keyed = <T>(record: Record<string, T>, id: string): T | undefined =>
    Object.hasOwn(record, id) ? record[id] : undefined;
  const runIn = (scope: Scope, runId: string) =>
    seed.runs.find((r) => r.id === runId && inScope(scope, r.workspaceSlug));
  const agentIn = (scope: Scope, key: string) =>
    seed.agents.find((a) => a.key === key && inScope(scope, a.workspaceSlug));

  /** A pending approval's clock runs from now, keeping the wait the mockup drew. */
  const rebase = (a: ApprovalItem): ApprovalItem => {
    const clock = seed.approvalClocks[a.id];
    if (a.status !== "pending" || !clock) return a;
    const requested = options.now() - clock.waitedSeconds * 1000;
    return {
      ...a,
      requestedAt: new Date(requested).toISOString(),
      expiresAt: new Date(
        requested + clock.timeoutSeconds * 1000,
      ).toISOString(),
    };
  };

  return fenceOrganization({
    runs: {
      listRuns: (scope, q) =>
        read(
          "runs",
          "listRuns",
          () => {
            const rows = seed.runs
              .filter((r) => inScope(scope, r.workspaceSlug))
              .filter((r) =>
                q.filter === "live"
                  ? r.status === "live" || r.status === "parked"
                  : q.filter === "proven"
                    ? r.verdict === "flipped"
                    : true,
              )
              .map(toRow);
            return readOk({ rows, next: null });
          },
          () => ({ rows: [], next: null }),
        ),
      getRun: (scope, runId) =>
        read("runs", "getRun", () => found(runIn(scope, runId), "run")),
      framesSince: (scope, runId, afterSeq, limit = 200) =>
        read(
          "runs",
          "framesSince",
          () => {
            if (!runIn(scope, runId)) return notFound("run");
            if (!/^-?\d+$/.test(afterSeq))
              return readError("invalid_cursor", 400);
            const after = BigInt(afterSeq);
            const frames: Frame[] = (keyed(seed.frames, runId) ?? [])
              .filter((f) => BigInt(f.seq) > after)
              .slice(0, Math.max(0, limit));
            return readOk(frames);
          },
          () => [],
        ),
      transcript: (scope, runId) =>
        read(
          "runs",
          "transcript",
          () =>
            runIn(scope, runId)
              ? readOk(keyed(seed.transcripts, runId) ?? [])
              : notFound("run"),
          () => [],
        ),
      runGraph: (scope, runId) =>
        read(
          "runs",
          "runGraph",
          () =>
            runIn(scope, runId)
              ? readOk(keyed(seed.runGraphs, runId) ?? EMPTY_GRAPH)
              : notFound("run"),
          () => EMPTY_GRAPH,
        ),
      contextWindow: (scope, runId) =>
        read(
          "runs",
          "contextWindow",
          () =>
            runIn(scope, runId)
              ? readOk(keyed(seed.contextWindows, runId) ?? null)
              : notFound("run"),
          () => null,
        ),
      proof: (scope, runId) =>
        read(
          "runs",
          "proof",
          () =>
            runIn(scope, runId)
              ? readOk(keyed(seed.proofs, runId) ?? null)
              : notFound("run"),
          () => null,
        ),
    },

    approvals: {
      pending: (scope, q) =>
        read(
          "approvals",
          "pending",
          () =>
            readOk(
              seed.approvals
                // The run filter narrows the scope; it never replaces it.
                .filter(
                  (a) =>
                    inScope(scope, a.workspaceSlug) &&
                    (!q?.runId || a.runId === q.runId),
                )
                .map(rebase),
            ),
          () => [],
        ),
    },

    agents: {
      listAgents: (scope) =>
        read(
          "agents",
          "listAgents",
          () =>
            readOk(
              seed.agents
                .filter((a) => inScope(scope, a.workspaceSlug))
                .map(
                  ({
                    identity: _i,
                    credential: _c,
                    definition: _d,
                    budget: _b,
                    roles: _r,
                    ...row
                  }) => row,
                ),
            ),
          () => [],
        ),
      getAgent: (scope, key) =>
        read("agents", "getAgent", () => found(agentIn(scope, key), "agent")),
      toolbelt: (scope, key) =>
        read(
          "agents",
          "toolbelt",
          () =>
            agentIn(scope, key)
              ? found(
                  seed.toolbelts.find((b) => b.agentKey === key),
                  "toolbelt",
                )
              : notFound("agent"),
          () => ({
            agentKey: key,
            mode: "full" as const,
            entries: [],
            outside: [],
            registryVersions: 0,
            fullBeltLimit: 40,
          }),
        ),
      definition: (scope, key) =>
        read("agents", "definition", () =>
          agentIn(scope, key)
            ? found(
                seed.definitions.find((d) => d.agentKey === key),
                "definition",
              )
            : notFound("agent"),
        ),
      scores: (scope, key) =>
        read("agents", "scores", () =>
          agentIn(scope, key)
            ? found(
                seed.scores.find((s) => s.agentKey === key),
                "scores",
              )
            : notFound("agent"),
        ),
      incidents: (scope, key) =>
        read(
          "agents",
          "incidents",
          () =>
            agentIn(scope, key)
              ? readOk(seed.audit.incidents.filter((i) => i.agentKey === key))
              : notFound("agent"),
          () => [],
        ),
      mandates: (scope, key) =>
        read(
          "agents",
          "mandates",
          () =>
            agentIn(scope, key)
              ? readOk(seed.mandates.filter((m) => m.agentKey === key))
              : notFound("agent"),
          () => [],
        ),
      getMandate: (scope, mandateId) => {
        // A mandate is as visible as the agent that holds it.
        const mandate = seed.mandates.find(
          (m) => m.id === mandateId && agentIn(scope, m.agentKey),
        );
        const ledger = seed.mandateLedger.filter(
          (e) => e.mandateId === mandateId,
        );
        return read(
          "agents",
          "getMandate",
          () => (mandate ? readOk({ mandate, ledger }) : notFound("mandate")),
          // The mockup's empty mandate: active, never drawn on, full authority remaining.
          mandate
            ? () => ({
                mandate: {
                  ...mandate,
                  usage: {
                    settled: USD_ZERO,
                    reserved: USD_ZERO,
                    remaining: mandate.limits.perPeriod,
                  },
                },
                ledger: [],
              })
            : undefined,
        );
      },
    },

    iam: {
      roles: () =>
        read(
          "iam",
          "roles",
          () => readOk(seed.roles),
          () => [],
        ),
      permissionCatalog: () =>
        read(
          "iam",
          "permissionCatalog",
          () => readOk(seed.permissionGroups),
          () => [],
        ),
    },

    tools: {
      servers: () =>
        read(
          "tools",
          "servers",
          () => readOk(seed.servers),
          () => [],
        ),
      toolVersions: (_scope, q) =>
        read(
          "tools",
          "toolVersions",
          () =>
            readOk(
              q?.serverId
                ? seed.toolVersions.filter((t) => t.serverId === q.serverId)
                : seed.toolVersions,
            ),
          () => [],
        ),
      connections: () =>
        read(
          "tools",
          "connections",
          () => readOk(seed.connections),
          () => [],
        ),
      observedSchemas: () =>
        read(
          "tools",
          "observedSchemas",
          () => readOk(seed.observedSchemas),
          () => [],
        ),
      mandateLedger: (scope) =>
        read(
          "tools",
          "mandateLedger",
          () =>
            readOk(
              seed.mandates
                .filter((mandate) => agentIn(scope, mandate.agentKey))
                .map((mandate) => ({
                  mandate,
                  ledger: seed.mandateLedger.filter(
                    (e) => e.mandateId === mandate.id,
                  ),
                })),
            ),
          () => [],
        ),
      policyVersions: () =>
        read(
          "tools",
          "policyVersions",
          () => readOk(seed.policyVersions),
          () => [],
        ),
      policySimulation: (_scope, id) =>
        read(
          "tools",
          "policySimulation",
          () =>
            readOk(
              seed.policySimulations.find((s) => s.policyVersionId === id) ??
                null,
            ),
          () => null,
        ),
      killSwitches: () =>
        read(
          "tools",
          "killSwitches",
          () => readOk(seed.killSwitches),
          () => [],
        ),
      autoApprovalRules: (scope) =>
        read(
          "tools",
          "autoApprovalRules",
          () =>
            readOk(
              seed.autoApprovalRules.filter((r) =>
                inScope(scope, r.workspaceSlug),
              ),
            ),
          () => [],
        ),
      assurance: () =>
        read(
          "tools",
          "assurance",
          () => readOk(seed.assurance),
          () => null,
        ),
    },

    ontology: {
      classes: () =>
        read(
          "ontology",
          "classes",
          () => readOk(seed.classes),
          () => [],
        ),
      sources: () =>
        read(
          "ontology",
          "sources",
          () => readOk(seed.sources),
          () => [],
        ),
      repositories: () =>
        read(
          "ontology",
          "repositories",
          () => readOk(seed.repositories),
          () => [],
        ),
      versions: () =>
        read(
          "ontology",
          "versions",
          () => readOk(seed.ontologyVersions),
          () => [],
        ),
      embeddingIndexes: () =>
        read(
          "ontology",
          "embeddingIndexes",
          () => readOk(seed.embeddingIndexes),
          () => [],
        ),
    },

    steering: {
      records: () =>
        read(
          "steering",
          "records",
          () => readOk(seed.records),
          () => [],
        ),
      proposals: () =>
        read(
          "steering",
          "proposals",
          () => readOk(seed.proposals),
          () => [],
        ),
      effect: () =>
        read(
          "steering",
          "effect",
          () => readOk(seed.recordEffects),
          () => [],
        ),
      retirementCandidates: () =>
        read(
          "steering",
          "retirementCandidates",
          () => readOk(seed.retirementCandidates),
          () => [],
        ),
    },

    spend: {
      summary: () =>
        read(
          "spend",
          "summary",
          () => readOk(seed.spend.summary),
          (): SpendSummary => ({
            ...seed.spend.summary,
            total: ZERO,
            proven: ZERO,
            accepted: ZERO,
            unproven: ZERO,
            productiveRatio: 0,
            cacheHitRate: 0,
            runs: 0,
            governedActions: 0,
          }),
        ),
      byOperator: () =>
        read(
          "spend",
          "byOperator",
          () => readOk(seed.spend.byOperator),
          () => [],
        ),
      byAgent: () =>
        read(
          "spend",
          "byAgent",
          () => readOk(seed.spend.byAgent),
          () => [],
        ),
      byModel: () =>
        read(
          "spend",
          "byModel",
          () => readOk(seed.spend.byModel),
          () => [],
        ),
      byTool: () =>
        read(
          "spend",
          "byTool",
          () => readOk(seed.spend.byTool),
          () => [],
        ),
      waste: () =>
        read(
          "spend",
          "waste",
          () => readOk(seed.spend.waste),
          (): WasteReport => ({
            total: ZERO,
            share: 0,
            runs: 0,
            causes: [],
            worstRuns: [],
          }),
        ),
      drill: (_scope, kind, id) =>
        read("spend", "drill", () =>
          found(
            seed.spend.drills.find((d) => d.kind === kind && d.id === id),
            "drill",
          ),
        ),
      findings: () =>
        read(
          "spend",
          "findings",
          () => readOk(seed.spend.findings),
          () => [],
        ),
      findingEvidence: (_scope, id) =>
        read("spend", "findingEvidence", () =>
          found(
            seed.spend.evidence.find((e) => e.findingId === id),
            "finding",
          ),
        ),
      findingFix: (_scope, id) =>
        read("spend", "findingFix", () =>
          found(
            seed.spend.fixes.find((f) => f.findingId === id),
            "finding",
          ),
        ),
      reconciliation: () =>
        read(
          "spend",
          "reconciliation",
          () => readOk(seed.spend.reconciliation),
          () => ({
            ...seed.spend.reconciliation,
            exceptions: 0,
            variance: ZERO,
          }),
        ),
      budgets: () =>
        read(
          "spend",
          "budgets",
          () => readOk(seed.spend.budgets),
          () => [],
        ),
    },

    org: {
      organization: () =>
        read(
          "org",
          "organization",
          () => readOk(seed.organization),
          () => seed.organization,
        ),
      members: () =>
        read(
          "org",
          "members",
          () => readOk(seed.members),
          () => [],
        ),
      invitations: () =>
        read(
          "org",
          "invitations",
          () => readOk(seed.invitations),
          () => [],
        ),
      workspaces: () =>
        read(
          "org",
          "workspaces",
          () => readOk(seed.workspaces),
          () => [],
        ),
      apiKeys: () =>
        read(
          "org",
          "apiKeys",
          () => readOk(seed.apiKeys),
          () => [],
        ),
      dataPlanes: () =>
        read(
          "org",
          "dataPlanes",
          () => readOk(seed.dataPlanes),
          () => [],
        ),
      modelFunding: () =>
        read(
          "org",
          "modelFunding",
          () => readOk(seed.modelFunding),
          () => ({ ...seed.modelFunding, routes: [] }),
        ),
    },

    billing: {
      plan: () =>
        read(
          "billing",
          "plan",
          () => readOk(seed.billing.plan),
          () => seed.billing.plan,
        ),
      allowance: () =>
        read(
          "billing",
          "allowance",
          () => readOk(seed.billing.allowance),
          () => seed.billing.allowance,
        ),
      meters: () =>
        read(
          "billing",
          "meters",
          () => readOk(seed.billing.meters),
          () => [],
        ),
      invoices: () =>
        read(
          "billing",
          "invoices",
          () => readOk(seed.billing.invoices),
          () => [],
        ),
    },

    audit: {
      events: () =>
        read(
          "audit",
          "events",
          () => readOk(seed.audit.events),
          () => [],
        ),
      incidents: () =>
        read(
          "audit",
          "incidents",
          () => readOk(seed.audit.incidents),
          () => [],
        ),
      receipts: () =>
        read(
          "audit",
          "receipts",
          () => readOk(seed.audit.receipts),
          () => [],
        ),
      getReceipt: (_scope, id) =>
        read("audit", "getReceipt", () =>
          found(
            seed.audit.receipts.find((r) => r.id === id),
            "receipt",
          ),
        ),
      holds: () =>
        read(
          "audit",
          "holds",
          () => readOk(seed.audit.holds),
          () => [],
        ),
      exports: () =>
        read(
          "audit",
          "exports",
          () => readOk(seed.audit.exports),
          () => [],
        ),
      keys: () =>
        read(
          "audit",
          "keys",
          () => readOk(seed.audit.keys),
          () => [],
        ),
      erasure: () =>
        read(
          "audit",
          "erasure",
          () => readOk(seed.audit.erasure),
          () => [],
        ),
      retention: () =>
        read(
          "audit",
          "retention",
          () => readOk(seed.audit.retention),
          () => [],
        ),
      assuranceHistory: () =>
        read(
          "audit",
          "assuranceHistory",
          () => readOk(seed.audit.assuranceHistory),
          () => [],
        ),
    },

    shell: {
      notifications: () =>
        read(
          "shell",
          "notifications",
          () => readOk(seed.notifications),
          () => [],
        ),
      people: () =>
        read(
          "shell",
          "people",
          () => readOk(seed.people),
          () => [],
        ),
      assistantEngine: () =>
        read(
          "shell",
          "assistantEngine",
          async () => {
            const switches = isStateSwitchHonoured()
              ? parseStateSwitch(await options.readState())
              : NO_STATE_SWITCH;
            return readOk({
              status: switches.assistantDown
                ? ("down" as const)
                : ("up" as const),
              checkedAt: new Date(options.now()).toISOString(),
            });
          },
          () => ({
            status: "up" as const,
            checkedAt: new Date(options.now()).toISOString(),
          }),
        ),
    },
  });
}

/**
 * Every read, org-level ones included, refuses a scope from another
 * organization before anything else runs: the fixture holds one tenant, and a
 * foreign org id sees none of it.
 */
function fenceOrganization(source: DataSource): DataSource {
  const fenced: Record<string, Record<string, unknown>> = {};
  for (const [port, methods] of Object.entries(source)) {
    const entries = Object.entries(
      methods as Record<string, (...args: unknown[]) => Promise<Read<unknown>>>,
    );
    fenced[port] = Object.fromEntries(
      entries.map(([name, fn]) => [
        name,
        (scope: Scope, ...args: unknown[]) =>
          scope.orgId === FIXTURE_TENANT.orgId
            ? fn(scope, ...args)
            : Promise.resolve(notFound("organization")),
      ]),
    );
  }
  return fenced as unknown as DataSource;
}

export const fixtureSource: DataSource = createFixtureSource({
  seed: defaultSeed,
  readState: readStateCookie,
  loadingMs: DEFAULT_LOADING_MS,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
});

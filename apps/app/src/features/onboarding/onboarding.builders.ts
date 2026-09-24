// Typed onboarding values for the gate and register component tests
// (ARCHITECTURE.md §5): a gate row, a first-frame read, and a DataSource that
// answers the onboarding and agents reads with what a test hands it.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type { AgentDetail } from "@/data/contracts/agents";
import type { FirstFrame, OnboardingGate } from "@/data/contracts/onboarding";
import type { RunPage } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";

export function onboardingGate(
  overrides: Partial<OnboardingGate> = {},
): OnboardingGate {
  return {
    step: "wrap",
    workspace: { id: "wrk_core", slug: "core-platform" },
    firstFrameAt: null,
    firstRunId: null,
    provisional: {
      until: "2026-09-29T00:00:00.000Z",
      mainRepoBoundAt: null,
      detectedRepository: {
        provider: "github",
        owner: "acme",
        name: "platform",
      },
    },
    ...overrides,
  };
}

export function firstFrame(overrides: Partial<FirstFrame> = {}): FirstFrame {
  return {
    agentId: "agt_releasebot",
    agentKey: "acme.core.release-bot",
    host: {
      hostEnrollmentId: "tch_mbp",
      enrolledAt: "2026-09-15T14:01:48.000Z",
      lastHeartbeatAt: "2026-09-15T14:02:00.000Z",
      hooksOk: true,
    },
    firstFrame: null,
    ...overrides,
  };
}

/**
 * The newest runs page, holding one row per id given: the installer's smoke
 * session and, for the negative case, a second run.
 */
export function runsPage(
  runs: { id: string; agentKey: string | null }[],
): Read<RunPage> {
  return {
    ok: true,
    value: {
      nextCursor: null,
      runs: runs.map(({ id, agentKey }) => ({
        id,
        source: "tacho",
        agentKey,
        operatorId: null,
        operatorKind: null,
        operatorName: null,
        status: "sealed",
        outcome: "completed",
        turns: 1,
        steps: 3,
        frames: 12,
        cost: null,
        model: null,
        machine: null,
        taskRef: null,
        name: "Installer smoke session",
        summary: null,
        replayGrade: null,
        verdict: null,
        enforcementTier: "harness",
        completenessGaps: [],
        canSummarize: false,
        startedAt: "2026-09-15T14:02:11.000Z",
        sealedAt: "2026-09-15T14:02:40.000Z",
      })),
    },
  };
}

type Reads = {
  state?: Read<OnboardingGate>;
  firstFrame?: Read<FirstFrame>;
  agent?: Read<AgentDetail>;
  /** The newest runs page, which the gate reads for the first-run banner. */
  runs?: Read<RunPage>;
};

type Calls = {
  state: Parameters<DataSource["onboarding"]["state"]>[];
  firstFrame: Parameters<DataSource["onboarding"]["firstFrame"]>[];
  agent: Parameters<DataSource["agents"]["get"]>[];
  runs: Parameters<DataSource["runs"]["list"]>[];
};

/** A DataSource that answers the reads a test hands it and refuses every other port. */
export function onboardingSource(reads: Reads): {
  source: DataSource;
  calls: Calls;
} {
  const calls: Calls = { state: [], firstFrame: [], agent: [], runs: [] };
  const refuse = (port: string) => () => {
    throw new Error(`${port} is not part of this test`);
  };
  const answer = <T>(read: Read<T> | undefined, port: string): Read<T> => {
    if (read === undefined) throw new Error(`${port} has no answer`);
    return read;
  };
  const source: DataSource = {
    runtimes: {
      list: refuse("runtimes.list"),
      agents: refuse("runtimes.agents"),
    },
    onboarding: {
      state: (...args: Parameters<DataSource["onboarding"]["state"]>) => {
        calls.state.push(args);
        return Promise.resolve(answer(reads.state, "onboarding.state"));
      },
      firstFrame: (
        ...args: Parameters<DataSource["onboarding"]["firstFrame"]>
      ) => {
        calls.firstFrame.push(args);
        return Promise.resolve(
          answer(reads.firstFrame, "onboarding.firstFrame"),
        );
      },
    },
    agents: {
      get: (...args: Parameters<DataSource["agents"]["get"]>) => {
        calls.agent.push(args);
        return Promise.resolve(answer(reads.agent, "agents.get"));
      },
      list: refuse("agents.list"),
      toolbelt: refuse("agents.toolbelt"),
      incidents: refuse("agents.incidents"),
    },
    pretenant: {
      orgs: refuse("pretenant.orgs"),
      workspaces: refuse("pretenant.workspaces"),
    },
    mandates: {
      list: refuse("mandates.list"),
      get: refuse("mandates.get"),
    },
    shell: {
      context: refuse("shell.context"),
      preferences: refuse("shell.preferences"),
    },
    runs: {
      list: (...args: Parameters<DataSource["runs"]["list"]>) => {
        calls.runs.push(args);
        return Promise.resolve(answer(reads.runs, "runs.list"));
      },
      get: refuse("runs.get"),
      frameBody: refuse("runs.frameBody"),
      cost: refuse("runs.cost"),
      transcript: refuse("runs.transcript"),
      chain: refuse("runs.transcript"),
      outputs: refuse("runs.transcript"),
      work: refuse("runs.transcript"),
      outcomesSettings: refuse("runs.transcript"),
    },
    approvals: {
      pending: refuse("approvals.pending"),
      resolved: refuse("approvals.resolved"),
    },
    billing: {
      plan: refuse("billing.plan"),
      usageCredits: refuse("billing.usageCredits"),
      retention: refuse("billing.retention"),
      bucket: refuse("billing.bucket"),
      contractRate: refuse("billing.contractRate"),
      invoices: refuse("billing.invoices"),
    },
    spend: {
      byGroup: refuse("spend.byGroup"),
      fleet: refuse("spend.fleet"),
      drill: refuse("spend.drill"),
      waste: refuse("spend.waste"),
      gatewayPolicy: refuse("spend.budgets"),
      budgets: refuse("spend.budgets"),
      findings: refuse("spend.findings"),
      findingEvidence: refuse("spend.findingEvidence"),
      priceBook: refuse("spend.priceBook"),
      unpricedModels: refuse("spend.unpricedModels"),
    },
    audit: {
      events: refuse("audit.events"),
      exportEvents: refuse("audit.exportEvents"),
    },
    org: {
      members: refuse("org.members"),
      roles: refuse("org.roles"),
      workspaces: refuse("org.workspaces"),
      apiKeys: refuse("org.apiKeys"),
      costCenters: refuse("org.costCenters"),
      modelCredential: refuse("org.modelCredential"),
      dataPlane: refuse("org.dataPlane"),
      sso: refuse("org.sso"),
    },
    skills: {
      inventory: refuse("skills.inventory"),
      configuration: refuse("skills.configuration"),
    },
    steering: {
      records: refuse("steering.records"),
      record: refuse("steering.record"),
      proposals: refuse("steering.proposals"),
      contextPr: refuse("steering.contextPr"),
      freshness: refuse("steering.freshness"),
      deliveries: refuse("steering.deliveries"),
    },
    tools: {
      versions: refuse("tools.versions"),
      grants: refuse("tools.grants"),
      killSwitches: refuse("tools.killSwitches"),
      approvalRules: refuse("tools.approvalRules"),
      connections: refuse("tools.connections"),
      mcpServers: refuse("tools.mcpServers"),
    },
  };
  return { source, calls };
}

// Typed onboarding values for the gate and register component tests
// (ARCHITECTURE.md §5): a gate row, a first-frame read, and a DataSource that
// answers the onboarding and agents reads with what a test hands it.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type { AgentDetail } from "@/data/contracts/agents";
import type { FirstFrame, OnboardingGate } from "@/data/contracts/onboarding";
import type { RunChain, RunDetail } from "@/data/contracts/run";
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

type Reads = {
  state?: Read<OnboardingGate>;
  firstFrame?: Read<FirstFrame>;
  agent?: Read<AgentDetail>;
  run?: Read<RunDetail>;
  chain?: Read<RunChain>;
};

type Calls = {
  state: Parameters<DataSource["onboarding"]["state"]>[];
  firstFrame: Parameters<DataSource["onboarding"]["firstFrame"]>[];
  agent: Parameters<DataSource["agents"]["get"]>[];
  run: Parameters<DataSource["runs"]["get"]>[];
  chain: Parameters<DataSource["runs"]["chain"]>[];
};

/** A DataSource that answers the reads a test hands it and refuses every other port. */
export function onboardingSource(reads: Reads): {
  source: DataSource;
  calls: Calls;
} {
  const calls: Calls = {
    state: [],
    firstFrame: [],
    agent: [],
    run: [],
    chain: [],
  };
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
      list: refuse("runs.list"),
      get: (...args: Parameters<DataSource["runs"]["get"]>) => {
        calls.run.push(args);
        return Promise.resolve(answer(reads.run, "runs.get"));
      },
      frameBody: refuse("runs.frameBody"),
      cost: refuse("runs.cost"),
      transcript: refuse("runs.transcript"),
      chain: (...args: Parameters<DataSource["runs"]["chain"]>) => {
        calls.chain.push(args);
        return Promise.resolve(answer(reads.chain, "runs.chain"));
      },
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

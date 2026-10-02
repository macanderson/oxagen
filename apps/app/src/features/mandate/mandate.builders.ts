// A DataSource answering the mandate page's two reads (ARCHITECTURE.md §5), and
// nothing else: the page reads `get_mandate`, then `list_agents` for the
// harness its agent registered (#4871), so every other port refuses and a test
// that accidentally reaches for one fails rather than passing on a stub. The
// mandate values themselves come from `@/test/mandate-views`, which four
// features share because no feature may reach into another's folder.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type { AgentPage } from "@/data/contracts/agents";
import type { MandateDetail } from "@/data/contracts/mandates";
import type { DataSource } from "@/data/ports";
import { type Read, readOk } from "@/data/read";
import { agentPage, enrolledAgent } from "@/test/steering-views";

/** The mandate fixture's agent, registered on Codex. */
const MANDATE_AGENTS = agentPage([
  enrolledAgent({
    slug: "invoice-bot",
    agentKey: "a-intel.core-platform.invoice-bot",
    harness: "codex",
  }),
]);

export function mandateSource(
  read: Read<MandateDetail> | undefined,
  agents: Read<AgentPage> = readOk(MANDATE_AGENTS),
) {
  const calls: unknown[][] = [];
  const agentCalls: unknown[][] = [];
  const refuse = () => Promise.reject(new Error("not a Mandate read"));
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse, named: refuse },
    conversations: { latest: refuse, list: refuse, byId: refuse },
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: {
      context: refuse,
      preferences: refuse,
      counts: refuse,
      notifications: refuse,
      assistantEngine: refuse,
    },
    billing: {
      plan: refuse,
      usageCredits: refuse,
      retention: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    runs: {
      list: refuse,
      get: refuse,
      frameBody: refuse,
      cost: refuse,
      turns: refuse,
      transcript: refuse,
      chain: refuse,
      commands: refuse,
      outputs: refuse,
      work: refuse,
      issues: refuse,
      context: refuse,
      findings: refuse,
    },
    approvals: { pending: refuse, resolved: refuse, resolvedSince: refuse },
    interjections: { open: refuse, forRun: refuse },
    agents: {
      list: (...args: unknown[]) => {
        agentCalls.push(args);
        return Promise.resolve(agents);
      },
      get: refuse,
      toolbelt: refuse,
      incidents: refuse,
    },
    spend: {
      byGroup: refuse,
      fleet: refuse,
      drill: refuse,
      waste: refuse,
      gatewayPolicy: refuse,
      budgets: refuse,
      findings: refuse,
      findingEvidence: refuse,
      priceBook: refuse,
      operatorRanking: refuse,
      perMergedPr: refuse,
      unpricedModels: refuse,
      unproductive: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: refuse,
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      dataPlane: refuse,
      slackConnection: refuse,
      workspaceFacts: refuse,
      sso: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    audit: {
      events: refuse,
      exportEvents: refuse,
      retention: refuse,
      bundle: refuse,
    },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      steeringPr: refuse,
      steeringPrDiff: refuse,
      freshness: refuse,
      layout: refuse,
      hub: refuse,
      workspaceMemories: refuse,
      workspaceMemory: refuse,
      memoryPrRecords: refuse,
      deliveries: refuse,
      memories: refuse,
      tree: refuse,
    },
    steeringRepo: { get: refuse },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: refuse,
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
      toolbelts: refuse,
      toolbelt: refuse,
    },
    mandates: {
      list: refuse,
      get: (...args: unknown[]) => {
        calls.push(args);
        return read === undefined
          ? Promise.reject(new Error("mandates.get was not expected"))
          : Promise.resolve(read);
      },
    },
  };
  return { source, calls, agentCalls };
}

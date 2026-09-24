// A DataSource answering the mandate page's reads (ARCHITECTURE.md §5) and
// nothing else: `get_mandate`, and beside it the agent (`get_agent`) and the
// org's members (`list_members`) that name the grant. Every other port refuses,
// so a test that accidentally reaches for one fails rather than passing on a
// stub. The mandate values themselves come from `@/test/mandate-views`, which
// four features share because no feature may reach into another's folder.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type { AgentDetail } from "@/data/contracts/agents";
import type { MandateDetail } from "@/data/contracts/mandates";
import type { MemberList } from "@/data/contracts/org";
import type { DataSource } from "@/data/ports";
import { type Read, readError } from "@/data/read";

/** The two reads that name the grant; each refuses unless a test supplies it. */
type Names = {
  members?: Read<MemberList>;
  agent?: Read<AgentDetail>;
};

export function mandateSource(
  read: Read<MandateDetail> | undefined,
  names: Names = {},
) {
  const calls: unknown[][] = [];
  const refuse = () => Promise.reject(new Error("not a Mandate read"));
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse },
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: { context: refuse, preferences: refuse },
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
      transcript: refuse,
      chain: refuse,
      outputs: refuse,
      work: refuse,
      outcomesSettings: refuse,
    },
    approvals: { pending: refuse, resolved: refuse },
    agents: {
      list: refuse,
      get: () =>
        Promise.resolve(names.agent ?? readError("agent_unavailable", 503)),
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
      unpricedModels: refuse,
    },
    onboarding: { state: refuse, firstFrame: refuse },
    org: {
      members: () =>
        Promise.resolve(names.members ?? readError("members_unavailable", 503)),
      roles: refuse,
      workspaces: refuse,
      apiKeys: refuse,
      costCenters: refuse,
      modelCredential: refuse,
      sso: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    audit: { events: refuse, exportEvents: refuse },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
      deliveries: refuse,
    },
    tools: {
      versions: refuse,
      grants: refuse,
      killSwitches: refuse,
      approvalRules: refuse,
      connections: refuse,
      mcpServers: refuse,
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
  return { source, calls };
}

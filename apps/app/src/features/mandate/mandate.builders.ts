// A DataSource answering the mandate page's one read (ARCHITECTURE.md §5), and
// nothing else: the page reads `get_mandate` alone, so every other port refuses
// and a test that accidentally reaches for one fails rather than passing on a
// stub. The mandate values themselves come from `@/test/mandate-views`, which
// four features share because no feature may reach into another's folder.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type { MandateDetail } from "@/data/contracts/mandates";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";

export function mandateSource(read: Read<MandateDetail> | undefined) {
  const calls: unknown[][] = [];
  const refuse = () => Promise.reject(new Error("not a Mandate read"));
  const source: DataSource = {
    runtimes: { list: refuse, agents: refuse },
    conversations: { latest: refuse },
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
      outputs: refuse,
      work: refuse,
      outcomesSettings: refuse,
    },
    approvals: { pending: refuse, resolved: refuse, resolvedSince: refuse },
    interjections: { open: refuse },
    agents: {
      list: refuse,
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
      unpricedModels: refuse,
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
      contextPr: refuse,
      freshness: refuse,
      hub: refuse,
      deliveries: refuse,
      memories: refuse,
      tree: refuse,
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

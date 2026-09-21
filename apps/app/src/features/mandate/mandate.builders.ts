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
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: { context: refuse, preferences: refuse },
    billing: {
      plan: refuse,
      usageCredits: refuse,
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
    },
    approvals: { pending: refuse, resolved: refuse },
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
      modelCredential: refuse,
    },
    skills: { inventory: refuse, configuration: refuse },
    audit: { events: refuse, exportEvents: refuse },
    steering: {
      records: refuse,
      record: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
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

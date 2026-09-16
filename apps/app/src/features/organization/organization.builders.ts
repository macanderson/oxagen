// Typed Organization values for the People and API keys component tests
// (ARCHITECTURE.md §5): one API key, and a DataSource that answers the three
// organization reads with what a test hands it while recording the arguments
// it was called with. Every other port refuses, so a section that reads
// outside its own port fails the test rather than passing on a stub.
// Importable from tests only (`testOnlyTarget` in src/test/arch/layers.ts).
import type { ApiKey, MemberList } from "@/data/contracts/org";
import type { WorkspaceChoice } from "@/data/contracts/shell";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";

export function apiKey(overrides: Partial<ApiKey> = {}): ApiKey {
  return {
    id: "aky_7k2m9q4x8r1t5v3w6y0z2a",
    name: "CI runner",
    prefix: "ox_liveliveli",
    createdAt: "2026-09-13T10:00:00.000Z",
    lastUsedAt: "2026-09-14T11:30:00.000Z",
    expiresAt: null,
    revokedAt: null,
    ...overrides,
  };
}

type OrgReads = {
  members?: Read<MemberList>;
  workspaces?: Read<WorkspaceChoice[]>;
  apiKeys?: Read<ApiKey[]>;
};

export function orgSource(reads: OrgReads): {
  source: DataSource;
  calls: Record<keyof OrgReads, unknown[][]>;
} {
  const calls: Record<keyof OrgReads, unknown[][]> = {
    members: [],
    workspaces: [],
    apiKeys: [],
  };
  const refuse = () => Promise.reject(new Error("not an Organization read"));
  const answer =
    <T>(read: Read<T> | undefined, name: keyof OrgReads) =>
    (...args: unknown[]): Promise<Read<T>> => {
      calls[name].push(args);
      return read === undefined
        ? Promise.reject(new Error(`org.${name} was not expected`))
        : Promise.resolve(read);
    };
  const source: DataSource = {
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: { context: refuse },
    billing: {
      plan: refuse,
      bucket: refuse,
      contractRate: refuse,
      invoices: refuse,
    },
    runs: { list: refuse },
    approvals: { pending: refuse },
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
    },
    org: {
      members: answer(reads.members, "members"),
      workspaces: answer(reads.workspaces, "workspaces"),
      apiKeys: answer(reads.apiKeys, "apiKeys"),
    },
    steering: { records: refuse, proposals: refuse, contextPr: refuse },
  };
  return { source, calls };
}

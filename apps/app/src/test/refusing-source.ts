import type { DataSource } from "@/data/ports";

/** A fixture supplies only the methods its feature actually reads. */
export type SourceOverrides<T = DataSource> = {
  [Group in keyof T]?: Partial<T[Group]>;
};

function mergeMethods<T extends object>(
  defaults: T,
  overrides: Partial<T> | undefined,
): T {
  const result = { ...defaults };
  for (const key of Object.keys(defaults) as Array<keyof T>) {
    const override = overrides?.[key];
    if (override !== undefined) result[key] = override;
  }
  return result;
}

/**
 * All unused reads reject. Keep the exhaustive port list here, so adding a
 * method changes this helper once and leaves unrelated feature fixtures alone.
 * DataSource checks completeness; SourceOverrides checks each supplied method.
 */
export function refusingSource(
  feature: string,
  overrides: SourceOverrides = {},
): DataSource {
  const refuse = (): Promise<never> =>
    Promise.reject(new Error(`not a ${feature} read`));
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
    },
    approvals: { pending: refuse, resolved: refuse },
    agents: { list: refuse, get: refuse, toolbelt: refuse, incidents: refuse },
    mandates: { list: refuse, get: refuse },
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
    audit: { events: refuse, exportEvents: refuse },
    skills: { inventory: refuse },
    steering: {
      records: refuse,
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
  };
  function mergeGroup<K extends keyof DataSource>(group: K): void {
    source[group] = mergeMethods<DataSource[K]>(
      source[group],
      overrides[group],
    );
  }
  for (const group of Object.keys(source) as Array<keyof DataSource>)
    mergeGroup(group);
  return source;
}

// Fixtures and a DataSource for the Tools tests: the view models the page
// renders, each built from the contract-parsed record through the same mapper
// the live port uses, so a fixture cannot drift from the contract.
import {
  toCredentialGrantPage,
  toKillSwitchBoard,
  toToolVersionPage,
} from "@/data/live/mappers/tools";
import type { DataSource } from "@/data/ports";
import type {
  CredentialGrantPage,
  KillSwitchBoard,
  ToolVersionPage,
} from "@/data/contracts/tools";
import {
  CredentialGrantPage as CredentialGrantPageShape,
  KILL_SWITCH_BOARD_LIMIT,
  KillSwitchBoard as KillSwitchBoardShape,
  ToolVersionPage as ToolVersionPageShape,
} from "@/data/contracts/tools";
import type { MandateList } from "@/data/contracts/mandates";
import type { Read } from "@/data/read";
import {
  credentialGrantListOutput,
  killSwitchListOutput,
  toolVersionListOutput,
} from "@/test/tools-outputs";

export function toolVersionPage(
  over: Parameters<typeof toolVersionListOutput>[0] = {},
): ToolVersionPage {
  return ToolVersionPageShape.parse(
    toToolVersionPage(toolVersionListOutput(over)),
  );
}

export function credentialGrantPage(
  over: Parameters<typeof credentialGrantListOutput>[0] = {},
): CredentialGrantPage {
  return CredentialGrantPageShape.parse(
    toCredentialGrantPage(credentialGrantListOutput(over)),
  );
}

export function killSwitchBoard(
  over: Parameters<typeof killSwitchListOutput>[0] = {},
  /** The limit the read asked for; pass the fixture's own length for a truncated board. */
  limit: number = KILL_SWITCH_BOARD_LIMIT,
): KillSwitchBoard {
  return KillSwitchBoardShape.parse(
    toKillSwitchBoard(killSwitchListOutput(over), limit),
  );
}

type ToolsReads = {
  versions?: Read<ToolVersionPage>;
  grants?: Read<CredentialGrantPage>;
  killSwitches?: Read<KillSwitchBoard>;
  /** The Mandates tab's read (#2957); built by `@/test/mandate-views`, which
   * three features share because no feature may reach into another's folder. */
  mandates?: Read<MandateList>;
};

/** A DataSource answering the Tools reads it was handed; `calls` records each read's arguments. */
export function toolsSource(reads: ToolsReads) {
  const calls: Record<keyof ToolsReads, unknown[][]> = {
    versions: [],
    grants: [],
    killSwitches: [],
    mandates: [],
  };
  const refuse = () => Promise.reject(new Error("not a Tools read"));
  const answer =
    <T>(read: Read<T> | undefined, name: keyof ToolsReads) =>
    (...args: unknown[]): Promise<Read<T>> => {
      calls[name].push(args);
      return read === undefined
        ? Promise.reject(new Error(`tools.${name} was not expected`))
        : Promise.resolve(read);
    };
  const source: DataSource = {
    pretenant: { orgs: refuse, workspaces: refuse },
    shell: { context: refuse },
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
    },
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
    skills: { inventory: refuse },
    audit: { events: refuse, exportEvents: refuse },
    steering: {
      records: refuse,
      proposals: refuse,
      contextPr: refuse,
      freshness: refuse,
    },
    tools: {
      versions: answer(reads.versions, "versions"),
      grants: answer(reads.grants, "grants"),
      killSwitches: answer(reads.killSwitches, "killSwitches"),
    },
    mandates: { list: answer(reads.mandates, "mandates") },
  };
  return { source, calls };
}

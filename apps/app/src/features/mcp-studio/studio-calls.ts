// The capabilities Studio calls beyond the draft and Review (#4678, part 3).
// Part 2 drew each screen against a typed stub in this module. Each one is now
// a call bound to a server action in actions.ts, which runs the capability for
// the workspace the page names:
//
//   - start_studio_discovery, get_studio_discovery and list_studio_tools:
//     lane M10 (#4682). Discovery progress after Add server, and the tools
//     discovery found.
//   - try_studio_tool: the Test tab, metered as a governed action (#4742).
//   - draft_studio_description: Draft on the tool panel, billed as in-app
//     agent spend (#4742).
//   - list_studio_findings: the Changes tab's findings (#4742).
//   - set_mcp_credential: the Connection tab's service secret and OAuth
//     client forms (#4742). Org Owner and Admin only.
//   - start_studio_listing and get_studio_listing: Add server's Local command
//     and registry package forms (ADR-233, #4756). A machine lists a new
//     server's tools before Review, and the dialog classifies them.
//   - registryPackagesOf: a registry entry's packages, with the arguments
//     each takes, from search_mcp_registry.
//
// A component takes each call as a prop, so a test passes a fake. A refusal
// reaches the page as a code, never as the handler's text. Try it is the one
// exception: a policy denial or an upstream failure is its answer, so the tab
// prints the handler's message.
//
// Client components import this module. It imports the server actions, which
// Next turns into references, and nothing server-only. A credential crosses
// only set_mcp_credential's input, which a form reads at submit and never
// holds in state.
import type {
  RegistryPackage,
  RegistryServer,
  ToolEgress,
  ToolRiskGrade,
  ToolSideEffect,
} from "@/data/contracts/tools";
import type {
  StudioListedTool,
  StudioListing,
} from "@oxagen/oxagen/contracts/tool.studio.listing.get";
import type { ActionResult } from "@/server/kernel";
import {
  draftStudioDescriptionAction,
  getStudioDiscoveryAction,
  getStudioListingAction,
  listStudioFindingsAction,
  listStudioToolsAction,
  setMcpCredentialAction,
  startStudioDiscoveryAction,
  startStudioListingAction,
  tryStudioToolAction,
} from "./actions";
import { codeOf, type Refused } from "./review-calls";
import type { StudioAt } from "./route";
import type { StudioFinding } from "./seams";

/** The capabilities this module binds, by the names their owners register. */
type StudioCapability =
  | "start_studio_discovery"
  | "get_studio_discovery"
  | "start_studio_listing"
  | "get_studio_listing"
  | "list_studio_tools"
  | "try_studio_tool"
  | "draft_studio_description"
  | "list_studio_findings"
  | "set_mcp_credential";

/**
 * A refusal with the handler's code (`denied`, `unavailable`, or the reason
 * the handler names). No message text reaches the app, so the page maps a
 * code it knows to its own copy.
 */
type Failed = { ok: false; reason: "failed"; code: string };

/**
 * A capability's answer as Studio reads it. The capability's output carries
 * no `ok`, as get_studio_draft returns `{ draft }`, so the call adds
 * `ok: true` to it, or refuses with the handler's code.
 */
type Answer<Output> = ({ ok: true } & Output) | Failed;

/**
 * One capability as Studio calls it, for the workspace the page names. A
 * control carries the name as `data-capability`, so a reader of the DOM can
 * follow it to the capability.
 */
type StudioCall<Name extends StudioCapability, Input, Result> = {
  /** The capability's registered name. */
  readonly name: Name;
  readonly call: (at: StudioAt, input: Input) => Promise<Result>;
};

function failed(result: Refused): Failed {
  return { ok: false, reason: "failed", code: codeOf(result) };
}

/** An action's output with `ok: true` added, or its refusal's code. */
function answer<Output extends object>(
  result: ActionResult<Output>,
): Answer<Output> {
  return result.ok ? { ok: true as const, ...result.value } : failed(result);
}

// ---- Discovery (lane M10 part 2) ------------------------------------------

/** One server's discovery. */
export type StudioDiscovery = {
  /** The discovery row's uuid. It stays the same across the server's runs. */
  id: string;
  /** The folder name under tools/servers/. */
  server: string;
  /** `mcs_…`, or null before the server has a registry row. */
  mcpServerId: string | null;
  /** waiting_for_machine: no machine in the server's groups has polled yet (#4772). */
  status: "queued" | "running" | "waiting_for_machine" | "succeeded" | "failed";
  /** True when the discovery has been queued or running for over an hour. */
  stalled: boolean;
  trigger:
    | "schedule"
    | "list_changed"
    | "push"
    | "registry_version"
    | "manual"
    | "lock_merged";
  requestedAt: string;
  requestedBy: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  /** What a finished discovery did about the lock. */
  outcome:
    | "unchanged"
    | "pr_opened"
    | "pr_updated"
    | "needs_digest"
    | "skipped"
    | null;
  toolCount: number | null;
  /** The machine that reported, for a local server or a registry package. */
  machine: string | null;
  sourceKind: string | null;
  sourceRepo: string | null;
  sourcePath: string | null;
  sourceRef: string | null;
  schedule: "on-change" | "daily" | "manual" | null;
  upstreamDigest: string | null;
  latestVersion: string | null;
  /** The sync steering PR this discovery opened or updated. */
  pr: { number: number; url: string; branch: string } | null;
  /** Tools the gateway hides until the sync steering PR merges. */
  withheld: readonly string[];
};

/**
 * One tool's classification. An imported tool's comes from tools.toml and is
 * confirmed. An available tool's is Studio's suggestion, unconfirmed, and the
 * page shows it grey.
 */
type StudioServerToolClassification = {
  risk: ToolRiskGrade;
  sideEffect: ToolSideEffect;
  egress: ToolEgress;
  impacts: readonly string[];
  confirmed: boolean;
  /**
   * What the suggestion came from, such as `annotations` or `fail_safe`, or
   * null once a person set the values. For an OpenAPI, GraphQL or gRPC
   * server, an available tool's suggestion falls back to `fail_safe`.
   */
  basis: string | null;
};

/**
 * One row of list_studio_tools. The rows run one per tools.toml key (state
 * imported), then one per snapshot tool that no imported key uses (state
 * available).
 */
type StudioServerTool = {
  /** The tools.toml key, or null for an available tool. */
  key: string | null;
  state: "imported" | "available";
  /** The upstream name, as the source offers it. */
  name: string;
  description: string | null;
  /** The description tools.toml sets over the upstream one, if any. */
  importedDescription: string | null;
  inputSchema: Readonly<Record<string, unknown>>;
  /** The MCP hints, or null when the source gives none. */
  annotations: Readonly<Record<string, unknown>> | null;
  /**
   * What the tool's definition costs the model, or null when unknown. For an
   * OpenAPI, GraphQL or gRPC server, an available tool's count leaves out its
   * title and outputSchema.
   */
  tokens: number | null;
  classification: StudioServerToolClassification;
  snapshotId: string | null;
  capturedAt: string | null;
  /** True while the gateway hides the tool until the sync steering PR merges. */
  withheld: boolean;
};

/** list_studio_tools' output: one server's tools and what they cost. */
export type StudioToolsList = {
  server: string;
  mcpServerId: string | null;
  /** The newest snapshot the rows read, or null before the first discovery. */
  snapshotId: string | null;
  capturedAt: string | null;
  exposure: { mode: "direct" | "search"; budget: number };
  /** The imported definitions' tokens against the budget; null when unknown. */
  tokens: { definitions: number | null; budget: number };
  /** How many tools tools.toml imports. */
  imported: number;
  /** How many tools the last snapshot offers. */
  offered: number;
  /** True when the definitions would fit better behind search. */
  searchRecommended: boolean;
  /** Why tools.toml did not compile, or null when it did. */
  compileError: string | null;
  tools: readonly StudioServerTool[];
};

type ServerInput = {
  /** The folder name under tools/servers/. */
  server: string;
};

/**
 * Ask for a discovery of one server now. Org Owner and Admin, and workspace
 * Owner and Member.
 */
export const startStudioDiscovery: StudioCall<
  "start_studio_discovery",
  ServerInput,
  Answer<{ discovery: StudioDiscovery }>
> = {
  name: "start_studio_discovery",
  call: async (at, { server }) =>
    answer(await startStudioDiscoveryAction(at.org, at.ws, server)),
};

/**
 * One server's latest discovery, or null before the first one. Workspace
 * Viewers may read it too.
 */
export const getStudioDiscovery: StudioCall<
  "get_studio_discovery",
  ServerInput,
  Answer<{ discovery: StudioDiscovery | null }>
> = {
  name: "get_studio_discovery",
  call: async (at, { server }) =>
    answer(await getStudioDiscoveryAction(at.org, at.ws, server)),
};

// ---- Listing (ADR-233, #4756) ---------------------------------------------

export type { StudioListedTool, StudioListing };

/** A local command's pin: the version it runs and its executable's SHA-256. */
export type StudioListingPin = {
  version: string;
  /** `sha256:` and 64 lowercase hex characters. */
  digest: string;
};

type ListingInput = {
  /** The folder name under tools/servers/. */
  server: string;
  /** The draft revision the person sees. */
  revision: number;
  /** A local command's pin. A registry package sends none. */
  pin?: StudioListingPin;
};

/**
 * Ask a machine in the draft's source.machines to list its tools. Org Owner
 * and Admin, and workspace Owner.
 */
export const startStudioListing: StudioCall<
  "start_studio_listing",
  ListingInput,
  Answer<{ listing: StudioListing }>
> = {
  name: "start_studio_listing",
  call: async (at, input) =>
    answer(await startStudioListingAction(at.org, at.ws, input)),
};

/** One draft's listing, or null when it has none. */
export const getStudioListing: StudioCall<
  "get_studio_listing",
  ServerInput,
  Answer<{ listing: StudioListing | null }>
> = {
  name: "get_studio_listing",
  call: async (at, { server }) =>
    answer(await getStudioListingAction(at.org, at.ws, server)),
};

export type StartStudioListing = typeof startStudioListing;
export type GetStudioListing = typeof getStudioListing;

/**
 * One server's tools: its tools.toml keys, then the snapshot tools no key
 * imports. Workspace Viewers may read it too.
 */
export const listStudioTools: StudioCall<
  "list_studio_tools",
  ServerInput,
  Answer<StudioToolsList>
> = {
  name: "list_studio_tools",
  call: async (at, { server }) =>
    answer(await listStudioToolsAction(at.org, at.ws, server)),
};

// ---- Test and Draft (#4742) -----------------------------------------------

/** One Test tab call: an imported tool, an environment and the arguments. */
type TryInput = {
  server: string;
  tool: string;
  /** The environment the operator picked, whose credential the gateway adds. */
  environment: string;
  /** The arguments, parsed from the JSON the person typed. */
  arguments: Readonly<Record<string, unknown>>;
};

export type TryResult =
  | {
      ok: true;
      /** What went upstream, as built before the gateway added the credential. */
      request: string;
      /** The upstream's answer, unshaped. */
      raw: string;
      /** What the model would receive after tools.toml's shaping. */
      shaped: string;
    }
  /** Policy denied the call or parked it for approval; the call still counts. */
  | { ok: false; reason: "denied"; message: string }
  /**
   * The upstream failed, with the handler's message, or the action was
   * refused before the call, with its code as the message.
   */
  | { ok: false; reason: "failed"; message: string };

/** Call one imported tool from Studio, metered as a governed action. */
export const tryStudioTool: StudioCall<"try_studio_tool", TryInput, TryResult> =
  {
    name: "try_studio_tool",
    call: async (at, input) => {
      const result = await tryStudioToolAction(at.org, at.ws, {
        server: input.server,
        tool: input.tool,
        environment: input.environment,
        arguments: { ...input.arguments },
      });
      if (!result.ok) {
        return { ok: false, reason: "failed", message: codeOf(result) };
      }
      const out = result.value;
      if (out.ok) {
        return {
          ok: true,
          request: out.request,
          raw: out.raw,
          shaped: out.shaped,
        };
      }
      return { ok: false, reason: out.reason, message: out.message };
    },
  };

export type TryStudioTool = typeof tryStudioTool;

type DraftResult =
  | { ok: true; description: string }
  /** The action was refused, with its code as the message. */
  | { ok: false; reason: "failed"; message: string };

/**
 * Draft one tool's description with the in-app agent, billed as in-app agent
 * spend. It writes nothing: a person who keeps the suggestion stages it as a
 * describe op.
 */
export const draftStudioDescription: StudioCall<
  "draft_studio_description",
  { server: string; tool: string },
  DraftResult
> = {
  name: "draft_studio_description",
  call: async (at, input) => {
    const result = await draftStudioDescriptionAction(at.org, at.ws, input);
    return result.ok
      ? { ok: true, description: result.value.description }
      : { ok: false, reason: "failed", message: codeOf(result) };
  },
};

export type DraftStudioDescription = typeof draftStudioDescription;

// ---- Findings and credentials (#4742, PR #4743) ---------------------------

/** list_studio_findings' output. */
type StudioFindingsList = {
  server: string;
  /** "draft" when the saved draft was checked, "published" for the production folder. */
  basis: "draft" | "published";
  /** The draft revision checked, or null for the production folder. */
  revision: number | null;
  tokens: { definitions: number; budget: number };
  /** Errors first, then warnings, then infos. */
  findings: readonly StudioFinding[];
};

/** The tool checks' findings on one server folder. Writes nothing. */
export const listStudioFindings: StudioCall<
  "list_studio_findings",
  ServerInput,
  Answer<StudioFindingsList>
> = {
  name: "list_studio_findings",
  call: async (at, { server }) =>
    answer(await listStudioFindingsAction(at.org, at.ws, server)),
};

export type ListStudioFindings = typeof listStudioFindings;

/**
 * One named credential. The kind decides the fields, and each kind refuses
 * the other's. A form reads these at submit, never holds them in state, and
 * never renders them back.
 */
export type SetMcpCredentialInput =
  | {
      /** Lowercase letters, digits and dashes, at most 63. */
      name: string;
      kind: "secret";
      secret: string;
    }
  | {
      name: string;
      kind: "oauth_client";
      clientId: string;
      clientSecret: string;
    };

/** Store a named credential in the vault. Org Owner and Admin only. */
export const setMcpCredential: StudioCall<
  "set_mcp_credential",
  SetMcpCredentialInput,
  Answer<{
    name: string;
    /** `oxagen:credential/<name>`, the value server.toml names. */
    reference: string;
    /** False when the call replaced a credential of that name. */
    created: boolean;
  }>
> = {
  name: "set_mcp_credential",
  call: async (at, input) =>
    answer(await setMcpCredentialAction(at.org, at.ws, input)),
};

export type SetMcpCredential = typeof setMcpCredential;

// ---- Registry packages (#4678) --------------------------------------------

export type { RegistryPackage } from "@/data/contracts/tools";

/**
 * A registry entry's packages, as search_mcp_registry carries them. An entry
 * whose transports include stdio offers at least one package.
 */
export function registryPackagesOf(
  server: RegistryServer,
): readonly RegistryPackage[] {
  return server.packages;
}

/** Whether a registry entry offers a remote, a package, or both. */
export function registryOffer(
  server: RegistryServer,
): "remote" | "package" | "both" | "none" {
  const remote = server.endpointUrl !== null;
  const pkg = server.transports.includes("stdio");
  if (remote && pkg) return "both";
  if (remote) return "remote";
  return pkg ? "package" : "none";
}

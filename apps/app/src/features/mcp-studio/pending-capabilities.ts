// The capabilities Studio calls before they exist (#4678, part 2 of a planned
// split). Each stub carries the capability's name, its input and output as
// the owning lane states them, and `available: false`. A control whose
// capability is not available renders disabled, with a one-line note. Part 3
// swaps each stub for a server action that calls the real capability once it
// merges. The owning lane may change a shape before then, and part 3 adjusts
// the call sites to match.
//
//   - start_studio_discovery, get_studio_discovery and list_studio_tools:
//     lane M10 part 2 (#4682). Discovery progress after Add server, and the
//     tools discovery found. The shapes follow M10's DiscoveryRow and
//     ServerTools (packages/handlers/src/mcp-studio/discovery), with dates as
//     ISO strings.
//   - try_studio_tool: Try it, metered as a governed action (#4742).
//   - draft_studio_description: Draft on the tool panel, billed as in-app
//     agent spend (#4742).
//   - list_studio_findings: the Changes tab's findings (#4742, PR #4743).
//   - set_mcp_credential: the Connection tab's service secret and OAuth
//     client forms (#4742, PR #4743). Org Owner and Admin only.
//   - registryPackagesOf: a registry entry's packages. search_mcp_registry
//     drops them today (toRegistryServer), and #4742 fixes that.
//
// This module imports nothing server-only, so client components import it.
// A credential crosses only set_mcp_credential's input, which a form reads at
// submit and never holds in state.
import type { RegistryServer } from "@/data/contracts/tools";
import type { StudioGap } from "./gaps";
import type { StudioFinding } from "./seams";

/** The capabilities this module stubs, by the names their owners register. */
type PendingCapability =
  | "start_studio_discovery"
  | "get_studio_discovery"
  | "list_studio_tools"
  | "try_studio_tool"
  | "draft_studio_description"
  | "list_studio_findings"
  | "set_mcp_credential";

/** The answer every stub gives: its capability has not merged. */
type NotBuilt = { ok: false; reason: "not_built"; gap: StudioGap };

/**
 * A refusal with the handler's code (`denied`, `unavailable`, or the reason
 * the handler names). No message text reaches the app, so the page maps a
 * code it knows to its own copy.
 */
type Refused = { ok: false; reason: "failed"; code: string };

/**
 * One capability as Studio calls it. A control carries the name as
 * `data-capability` and the gap as `data-gap`, so a reader of the DOM can
 * follow a disabled control to the work that enables it.
 */
type PendingCall<Name extends PendingCapability, Input, Result> = {
  /** The capability's registered name. Part 3 finds its call sites by it. */
  readonly name: Name;
  /** False until the capability merges. Its control renders disabled. */
  readonly available: boolean;
  /** The work that builds the capability. */
  readonly gap: StudioGap;
  readonly call: (input: Input) => Promise<Result | NotBuilt>;
};

function stub<Name extends PendingCapability, Input, Result>(
  name: Name,
  gap: StudioGap,
): PendingCall<Name, Input, Result> {
  const answer: NotBuilt = { ok: false, reason: "not_built", gap };
  return { name, available: false, gap, call: () => Promise.resolve(answer) };
}

// ---- Discovery (lane M10 part 2) ------------------------------------------

/** One server's discovery (M10's DiscoveryRow). */
export type StudioDiscovery = {
  /** The folder name under tools/servers/. */
  server: string;
  /** `mcs_…`, or null before the server has a registry row. */
  mcpServerId: string | null;
  status: "queued" | "running" | "succeeded" | "failed";
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

/** One tool the last discovery read (M10's ServerTool). */
export type StudioServerTool = {
  /** The upstream name, as the source offers it. */
  name: string;
  description: string | null;
  inputSchema: Readonly<Record<string, unknown>>;
  /** The MCP hints, or null when the source gives none. */
  annotations: Readonly<Record<string, unknown>> | null;
  snapshotId: string;
  capturedAt: string;
  /** True while the gateway hides the tool until the sync steering PR merges. */
  withheld: boolean;
};

type ServerInput = {
  /** The folder name under tools/servers/. */
  server: string;
};

/** Ask for a discovery of one server now. */
export const startStudioDiscovery = stub<
  "start_studio_discovery",
  ServerInput,
  { ok: true; discovery: StudioDiscovery } | Refused
>("start_studio_discovery", "discovery");

/** One server's latest discovery, or null before the first one. */
export const getStudioDiscovery = stub<
  "get_studio_discovery",
  ServerInput,
  { ok: true; discovery: StudioDiscovery | null } | Refused
>("get_studio_discovery", "discovery");

/** The tools one server's last discovery read. Empty before the first one. */
export const listStudioTools = stub<
  "list_studio_tools",
  ServerInput,
  | {
      ok: true;
      server: string;
      /** The newest snapshot row among the tools, or null with no tools. */
      snapshotId: string | null;
      capturedAt: string | null;
      tools: readonly StudioServerTool[];
    }
  | Refused
>("list_studio_tools", "discovery");

// ---- Try it and Draft (#4742) ---------------------------------------------

/** One Try it call: an imported tool, an environment and the arguments. */
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
  | NotBuilt
  /** Policy denied the call or parked it for approval; the call still counts. */
  | { ok: false; reason: "denied"; message: string }
  | { ok: false; reason: "failed"; message: string };

/** Call one imported tool from Studio, metered as a governed action. */
export const tryStudioTool = stub<"try_studio_tool", TryInput, TryResult>(
  "try_studio_tool",
  "capability",
);

export type TryStudioTool = typeof tryStudioTool;

type DraftResult =
  | { ok: true; description: string }
  | NotBuilt
  | { ok: false; reason: "failed"; message: string };

/**
 * Draft one tool's description with the in-app agent, billed as in-app agent
 * spend. It writes nothing: a person who keeps the suggestion stages it as a
 * describe op.
 */
export const draftStudioDescription = stub<
  "draft_studio_description",
  { server: string; tool: string },
  DraftResult
>("draft_studio_description", "capability");

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
export const listStudioFindings = stub<
  "list_studio_findings",
  ServerInput,
  { ok: true; list: StudioFindingsList } | Refused
>("list_studio_findings", "findings");

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
export const setMcpCredential = stub<
  "set_mcp_credential",
  SetMcpCredentialInput,
  | {
      ok: true;
      name: string;
      /** `oxagen:credential/<name>`, the value server.toml names. */
      reference: string;
      /** False when the call replaced a credential of that name. */
      created: boolean;
    }
  | Refused
>("set_mcp_credential", "credentials");

export type SetMcpCredential = typeof setMcpCredential;

// ---- Registry packages (#4742) --------------------------------------------

/** An argument a registry package takes (the registry's packageArguments). */
export type RegistryPackageArgument = {
  type: "named" | "positional";
  /** A named argument's flag, such as `--port`. source.arguments keys it by this. */
  name: string | null;
  /** A positional argument's hint. source.arguments keys it by this. */
  valueHint: string | null;
  isRequired: boolean;
  /** A secret takes its value from `${NAME}` only. */
  isSecret: boolean;
  /** A fixed value the registry says a person does not change. */
  value: string | null;
  /** The value when source.arguments sets none. */
  default: string | null;
};

/** One package a registry entry offers (the registry's `packages[]`). */
export type RegistryPackage = {
  /** npm, pypi, oci, nuget, or another type the local gateway does not run. */
  registryType: string;
  identifier: string;
  version: string | null;
  /** The package's transport. The local gateway runs stdio only. */
  transport: string;
  runtimeHint: string | null;
  packageArguments: readonly RegistryPackageArgument[];
  /** The variables the package reads. source.env lists every required one. */
  environmentVariables: readonly { name: string; isRequired: boolean }[];
};

/** The package types the local gateway runs (source.registry_type). */
export const REGISTRY_PACKAGE_TYPES = ["npm", "pypi", "oci", "nuget"] as const;

/**
 * A registry entry's packages, or null while search_mcp_registry drops them.
 * An entry whose transports include stdio offers at least one package.
 */
export function registryPackagesOf(
  _server: RegistryServer,
): readonly RegistryPackage[] | null {
  return null;
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

// seams.ts: what discovery reaches through, each with a production default
// (lane M10, #4682).
//
// Discovery reads the steering repo, resolves a credential, sends through a
// Transport, asks the local gateway, reads a linked repository, reads a
// registry catalog, and opens a steering PR. Each of those sits behind a seam
// here, so the tests run with fakes and another lane can install its part:
//
// - credentials: lane M8's CredentialSource over the workspace's vault rows
//   and its published servers (vaultCredentials). noCredentials refuses
//   every request, for a process with no vault.
// - local: the API's durable functions reach no machine, so their default
//   records the discovery as waiting for one (waitingLocalReporter). The MCP
//   process a machine polls runs it with gatewayLocalReporter over its
//   broker (./claim, #4772).
// - grpc: lane M3's importGrpc, which reads .proto files into tools and a
//   descriptor set.
// - opener: lane M11's toolsPullRequestOpener (#4688) opens the tools
//   steering PR. Until it merges, the default refuses.
import type {
  CredentialSource,
  GrpcInput,
  ImportResult,
  McpLockSource,
  McpTool,
  RegistryEntry,
  ServerSource,
  Transport,
} from "@oxagen/mcp-studio";
import {
  createCloudTransport,
  importGrpc,
  mcpToolSchema,
  registryEntrySchema,
} from "@oxagen/mcp-studio";
import { refusalText } from "@oxagen/tacho/local-servers";
import type { SteeringHost } from "../../context.steering.github";
import type { LocalGatewayBroker } from "../local-calls/broker";
import { discoverLocalTools } from "../local-calls/discovery";
import { launchSpecFor, machineGroupsOf } from "../local-calls/launch";
import type { MachineGroupReader } from "../local-calls/machines";
import { registryDigests, type RegistryDigests } from "./digests";
import { fetchText } from "./mcp-client";
import {
  DiscoveryRefused,
  WaitingForMachine,
  type DiscoveryScope,
} from "./types";

// ── Steering files ───────────────────────────────────────────────────────────

/** The production branch at one commit. */
export interface SteeringCheckout {
  /** The commit every read is pinned to. */
  commit: string;
  /** A file's text at the commit, or null when it is absent. */
  read(path: string): Promise<string | null>;
  /** Every file path under dir at the commit. */
  list(dir: string): Promise<string[]>;
  /**
   * Whether a steering PR is still open, whether it merged, and the head of
   * its branch. The head is what a commit onto an open PR is pinned to, so
   * the opener refuses one whose branch moved since the files were built. A
   * host that cannot tell the head answers null, and the commit goes
   * unpinned, as it did before the head was read.
   */
  pullRequest(
    number: number,
  ): Promise<{ open: boolean; merged: boolean; headSha: string | null }>;
}

export interface SteeringFiles {
  open(scope: DiscoveryScope): Promise<SteeringCheckout>;
}

/** The workspace's steering repo through the GitHub or GitLab host. */
export function hostSteeringFiles(host: SteeringHost): SteeringFiles {
  return {
    async open(scope) {
      const repo = await host.resolveRepository(scope);
      const commit = await host.branchHead(repo, repo.defaultBranch);
      if (commit === null) {
        throw new DiscoveryRefused(
          "no_server",
          `The steering repository has no ${repo.defaultBranch} branch.`,
        );
      }
      return {
        commit,
        read: (path) => host.readFile(repo, path, commit),
        list: (dir) => host.listFiles(repo, commit, dir),
        async pullRequest(number) {
          const pr = await host.getPullRequest(repo, number);
          return { open: pr.open, merged: pr.merged, headSha: pr.headSha };
        },
      };
    },
  };
}

// ── Credentials ──────────────────────────────────────────────────────────────

/** The CredentialSource for one workspace. */
export type DiscoveryCredentials = (scope: DiscoveryScope) => CredentialSource;

/** Refuses every request: for a process with no vault, and for tests. */
export const noCredentials: DiscoveryCredentials = () => ({
  resolve() {
    return Promise.reject(
      new DiscoveryRefused(
        "credential",
        "Discovery cannot read a stored credential yet, so a server with auth is not discovered.",
      ),
    );
  },
});

/**
 * Lane M8's CredentialSource for each workspace, built on first use. A
 * missing credential refuses the discovery with the source's message, so the
 * connect link the source also returns is never shown.
 */
export function vaultCredentials(
  build: (scope: DiscoveryScope) => Promise<CredentialSource>,
): DiscoveryCredentials {
  return (scope) => {
    let source: Promise<CredentialSource> | undefined;
    return {
      async resolve(request, signal) {
        source ??= build(scope);
        return (await source).resolve(request, signal);
      },
    };
  };
}

/** The vault rows and the published servers of one workspace. */
async function workspaceVault(
  scope: DiscoveryScope,
): Promise<CredentialSource> {
  const [{ createCredentialSource }, { postgresCredentialStore }, published] =
    await Promise.all([
      import("../credentials/source"),
      import("../credentials/store"),
      import("../credentials/published-manifest"),
    ]);
  const servers = await published.publishedServers(scope);
  return createCredentialSource({
    store: postgresCredentialStore(scope),
    server: (name) => servers.get(name),
    connectUrl: () => "",
  });
}

// ── Local servers ────────────────────────────────────────────────────────────

/** What one machine reported for a local server or a registry package. */
export interface LocalToolsReport {
  machine: string;
  server_version: string | undefined;
  tools: McpTool[];
}

export interface LocalToolsRequest {
  scope: DiscoveryScope;
  server: string;
  source: ServerSource;
  /** The served lock's source, which pins the package and its digest. */
  lockSource: McpLockSource;
  signal: AbortSignal;
}

export interface LocalToolsReporter {
  report(request: LocalToolsRequest): Promise<LocalToolsReport>;
}

/**
 * A server whose source.machines names no group runs nowhere. No machine can
 * claim its discovery, so it refuses rather than waits.
 */
function runsNowhere(server: string): DiscoveryRefused {
  return new DiscoveryRefused(
    "source",
    `${server} names no machine groups in source.machines, so no machine may run it. Add a group, then run discovery again.`,
  );
}

/**
 * The default in a process that reaches no machine: the API's durable
 * functions (#4772). It lists nothing and records the discovery as waiting for
 * a machine in the server's groups. The MCP process one of them polls claims
 * it and runs it through its broker. A server that names no groups refuses,
 * because nothing would ever claim it.
 */
export const waitingLocalReporter: LocalToolsReporter = {
  report({ server, source }) {
    const groups = machineGroupsOf(source);
    if (groups.length === 0) return Promise.reject(runsNowhere(server));
    return Promise.reject(new WaitingForMachine(server, groups));
  },
};

/** Refuses every local discovery, for a test that reaches no machine. */
export const noLocalReporter: LocalToolsReporter = {
  report() {
    return Promise.reject(
      new DiscoveryRefused(
        "unsupported",
        "Discovery cannot reach the local gateway yet, so a server that runs on machines is not discovered.",
      ),
    );
  },
};

export interface GatewayLocalReporterDeps {
  broker: LocalGatewayBroker;
  reader: MachineGroupReader;
  /** The machines in any of the groups, in a stable order. */
  machines(
    scope: DiscoveryScope,
    groups: readonly string[],
  ): Promise<readonly string[]>;
}

/**
 * Ask the first connected machine in the server's groups to start the server
 * and list its tools. A refusal from either side becomes a DiscoveryRefused
 * whose text says what to fix.
 */
export function gatewayLocalReporter(
  deps: GatewayLocalReporterDeps,
): LocalToolsReporter {
  return {
    async report({ scope, server, source, lockSource, signal }) {
      const groups = machineGroupsOf(source);
      const launch = launchSpecFor(server, lockSource, source);
      if (launch === undefined) {
        throw new DiscoveryRefused(
          "source",
          `The lock for ${server} names no package for a machine to run.`,
        );
      }
      if (groups.length === 0) throw runsNowhere(server);
      const machines = await deps.machines(scope, groups);
      const machine = machines.find((id) => deps.broker.connected(id));
      if (machine === undefined) {
        throw new DiscoveryRefused(
          "source",
          `No machine in ${groups.join(", ") || "any group"} is connected, so ${server} was not discovered.`,
        );
      }
      const result = await discoverLocalTools({
        scope,
        machine,
        groups,
        reader: deps.reader,
        broker: deps.broker,
        launch,
        signal,
      });
      if (!result.ok) {
        throw new DiscoveryRefused("source", refusalText(result.refusal));
      }
      // The gateway's wire keeps any object as an input schema. A lock needs
      // the MCP tool shape, whose input schema is an object schema.
      const tools: McpTool[] = [];
      for (const tool of result.report.tools) {
        const parsed = mcpToolSchema.safeParse(tool);
        if (!parsed.success) {
          const field = parsed.error.issues[0]?.path.join(".") || "shape";
          throw new DiscoveryRefused(
            "source",
            `${result.report.machine} reported a tool named ${JSON.stringify(tool.name)} for ${server} whose ${field} does not fit an MCP tool, so ${server} was not discovered.`,
          );
        }
        tools.push(parsed.data);
      }
      return {
        machine: result.report.machine,
        server_version: result.report.server_version,
        tools,
      };
    },
  };
}

// ── gRPC ─────────────────────────────────────────────────────────────────────

/**
 * Lane M3's importer: .proto files, or what server reflection returned, as
 * tools and the descriptor set compile needs.
 */
export type GrpcImporter = (input: GrpcInput) => Promise<ImportResult>;

// ── Definitions in a linked repository ───────────────────────────────────────

export interface DefinitionLocation {
  /** github.com/owner/name or gitlab.com/group/name. */
  repo: string;
  path: string;
  ref: string;
}

export interface DefinitionReader {
  /** The file's text and the commit it was read at. */
  read(
    scope: DiscoveryScope,
    location: DefinitionLocation,
    signal: AbortSignal,
  ): Promise<{ commit: string; text: string }>;
}

const COMMIT = /^[0-9a-f]{40}$/;

/** A minimal slice of the GitHub client, so a test can pass a fake. */
export interface DefinitionGitHub {
  getBranch(args: {
    owner: string;
    repo: string;
    branch: string;
  }): Promise<{ name: string; sha: string } | null>;
  listPathCommits(args: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
    limit?: number;
  }): Promise<Array<{ sha: string }>>;
  getFileContent(args: {
    owner: string;
    repo: string;
    path: string;
    ref?: string;
  }): Promise<string | null>;
}

/**
 * Read a definition from GitHub with the workspace's GitHub connection.
 *
 * The ref resolves to a commit first, so the lock pins what was read: a
 * 40-hex ref is the commit, a branch is its head, and a tag resolves to the
 * last commit on it that touched the path. GitLab is not read yet.
 */
export function githubDefinitionReader(
  client: (scope: DiscoveryScope, signal: AbortSignal) => Promise<DefinitionGitHub>,
): DefinitionReader {
  return {
    async read(scope, location, signal) {
      const [host, owner, ...rest] = location.repo.split("/");
      if (host !== "github.com") {
        throw new DiscoveryRefused(
          "unsupported",
          "Reading a definition from GitLab is not available yet.",
        );
      }
      if (
        owner === undefined ||
        owner === "" ||
        rest.length !== 1 ||
        rest[0] === ""
      ) {
        throw new DiscoveryRefused(
          "source",
          `The definition repo ${location.repo} is not a github.com/owner/name path.`,
        );
      }
      const repo = rest[0] as string;
      const github = await client(scope, signal);
      let commit: string | undefined;
      if (COMMIT.test(location.ref)) commit = location.ref;
      if (commit === undefined) {
        const branch = await github.getBranch({
          owner,
          repo,
          branch: location.ref,
        });
        commit = branch?.sha;
      }
      if (commit === undefined) {
        const [last] = await github.listPathCommits({
          owner,
          repo,
          path: location.path,
          ref: location.ref,
          limit: 1,
        });
        commit = last?.sha;
      }
      if (commit === undefined) {
        throw new DiscoveryRefused(
          "source",
          `${location.repo} has no ${location.path} at ${location.ref}.`,
        );
      }
      const text = await github.getFileContent({
        owner,
        repo,
        path: location.path,
        ref: commit,
      });
      if (text === null) {
        throw new DiscoveryRefused(
          "source",
          `${location.repo} has no ${location.path} at ${location.ref}.`,
        );
      }
      return { commit, text };
    },
  };
}

// ── Registry catalog ─────────────────────────────────────────────────────────

export interface RegistryCatalog {
  /** The catalog entry at version, or at the newest version for "latest". */
  entry(
    registry: string,
    server: string,
    version: string,
    signal: AbortSignal,
  ): Promise<RegistryEntry>;
}

/**
 * Read a catalog entry through the Transport, so the cloud route's address
 * checks apply to the registry too.
 */
export function transportRegistryCatalog(
  transport: () => Transport,
): RegistryCatalog {
  return {
    async entry(registry, server, version, signal) {
      const base = registry.replace(/\/+$/, "");
      const name = encodeURIComponent(server);
      const url = `${base}/v0.1/servers/${name}/versions/${encodeURIComponent(version)}`;
      const text = await fetchText({
        url,
        network: "cloud",
        transport: transport(),
        signal,
        accept: "application/json",
      });
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        throw new DiscoveryRefused(
          "source",
          `The registry's entry for ${server} ${version} is not JSON.`,
        );
      }
      const parsed = registryEntrySchema.safeParse(json);
      if (!parsed.success) {
        throw new DiscoveryRefused(
          "source",
          `The registry's entry for ${server} ${version} is not a server entry.`,
        );
      }
      return parsed.data;
    },
  };
}

// ── The tools steering PR ────────────────────────────────────────────────────

/** One file the steering PR writes, or deletes when content is null. */
export interface ToolsPullRequestFile {
  path: string;
  content: string | null;
}

export interface ToolsPullRequestInput {
  branch: string;
  title: string;
  body: string;
  commitMessage: string;
  files: ToolsPullRequestFile[];
  /** The open steering PR to update in place. */
  existing?: { number: number };
  /**
   * The commit the caller read to build `files`. A new branch starts here
   * rather than at the production head, so a commit that merged in between is
   * not reverted by a whole-file write. With `existing`, this is the head of
   * that PR's branch, and the opener refuses the call when the branch has
   * moved since.
   */
  at?: string;
}

export interface ToolsPullRequest {
  number: number;
  url: string;
  branch: string;
  headSha: string;
}

/** Lane M11's opener, in its shape (#4688). It runs no role check. */
export interface ToolsPullRequestOpener {
  open(
    scope: DiscoveryScope,
    input: ToolsPullRequestInput,
  ): Promise<ToolsPullRequest>;
}

/**
 * Refuses until lane M11's opener is installed. The refusal carries its own
 * code, no_opener, so a reader can tell a missing opener from one that
 * failed. The run that meets it still records the diff and keeps the changed
 * tools withheld.
 */
export const noToolsPullRequestOpener: ToolsPullRequestOpener = {
  open() {
    return Promise.reject(
      new DiscoveryRefused(
        "no_opener",
        "No tools steering PR opener is installed, so discovery cannot open the sync steering PR.",
      ),
    );
  },
};

// ── The installed set ────────────────────────────────────────────────────────

export interface DiscoverySeams {
  steering: SteeringFiles;
  credentials: DiscoveryCredentials;
  /** The Transport every remote request goes through. */
  transport(): Transport;
  local: LocalToolsReporter;
  grpc: GrpcImporter;
  definitions: DefinitionReader;
  catalog: RegistryCatalog;
  opener: ToolsPullRequestOpener;
  now(): Date;
  /**
   * Reads a registry package's digest from its public registry, so a package
   * on machines can move to a new catalog version (ADR-233). Without it, such
   * a move stops at needs_digest.
   */
  digests?: RegistryDigests;
}

let cloud: Transport | undefined;

/** One cloud Transport for the process, made on first use. */
function cloudTransport(): Transport {
  cloud ??= createCloudTransport();
  return cloud;
}

async function defaultSeams(): Promise<DiscoverySeams> {
  const [{ createSteeringHost }, { createGitHubClient }, { resolveGitHubToken }] =
    await Promise.all([
      import("../../context.steering.host"),
      import("@oxagen/github"),
      import("@oxagen/github/workspace-token"),
    ]);
  return {
    steering: hostSteeringFiles(createSteeringHost()),
    credentials: vaultCredentials(workspaceVault),
    transport: cloudTransport,
    local: waitingLocalReporter,
    grpc: importGrpc,
    definitions: githubDefinitionReader(async (scope, signal) =>
      createGitHubClient({
        token: await resolveGitHubToken({
          orgId: scope.orgId,
          workspaceId: scope.workspaceId,
        }),
        signal,
      }),
    ),
    catalog: transportRegistryCatalog(cloudTransport),
    opener: noToolsPullRequestOpener,
    now: () => new Date(),
    digests: registryDigests(),
  };
}

let installed: Partial<DiscoverySeams> = {};
let defaults: Promise<DiscoverySeams> | undefined;

/** Replace some seams: another lane's production binding, or a test's fakes. */
export function installDiscoverySeams(next: Partial<DiscoverySeams>): void {
  installed = { ...installed, ...next };
}

/** The seams in force: each installed one, else its default. */
export async function discoverySeams(): Promise<DiscoverySeams> {
  defaults ??= defaultSeams();
  return { ...(await defaults), ...installed };
}

/** Drop every installed seam. For tests. */
export function resetDiscoverySeams(): void {
  installed = {};
}

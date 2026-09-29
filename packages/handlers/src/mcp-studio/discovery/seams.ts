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
// - local: lane M15 installs gatewayLocalReporter with the live broker.
// - grpc: lane M3 builds gRPC reflection and descriptor reads.
// - opener: lane M11's toolsPullRequestOpener (#4688) opens the tools
//   steering PR. Until it merges, the default refuses.
import type {
  CredentialSource,
  McpLockSource,
  McpTool,
  RegistryEntry,
  ServerSource,
  Transport,
} from "@oxagen/mcp-studio";
import { createCloudTransport, registryEntrySchema } from "@oxagen/mcp-studio";
import { refusalText } from "@oxagen/tacho/local-servers";
import type { SteeringHost } from "../../context.steering.github";
import type { LocalGatewayBroker } from "../local-calls/broker";
import { discoverLocalTools } from "../local-calls/discovery";
import { launchSpecFor, machineGroupsOf } from "../local-calls/launch";
import type { MachineGroupReader } from "../local-calls/machines";
import { fetchText } from "./mcp-client";
import { DiscoveryRefused, type DiscoveryScope } from "./types";

// ── Steering files ───────────────────────────────────────────────────────────

/** The production branch at one commit. */
export interface SteeringCheckout {
  /** The commit every read is pinned to. */
  commit: string;
  /** A file's text at the commit, or null when it is absent. */
  read(path: string): Promise<string | null>;
  /** Every file path under dir at the commit. */
  list(dir: string): Promise<string[]>;
  /** Whether a steering PR is still open, and whether it merged. */
  pullRequest(number: number): Promise<{ open: boolean; merged: boolean }>;
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
          return { open: pr.open, merged: pr.merged };
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

/** Refuses until the local gateway's broker is installed. */
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
      return {
        machine: result.report.machine,
        server_version: result.report.server_version,
        tools: result.report.tools,
      };
    },
  };
}

// ── gRPC ─────────────────────────────────────────────────────────────────────

export interface GrpcDiscovery {
  /** The descriptor set and tools of a gRPC server. */
  discover(request: {
    scope: DiscoveryScope;
    server: string;
    signal: AbortSignal;
  }): Promise<never>;
}

/** Refuses until lane M3's gRPC import and reflection are built. */
export const noGrpcDiscovery: GrpcDiscovery = {
  discover() {
    return Promise.reject(
      new DiscoveryRefused(
        "unsupported",
        "gRPC discovery is not available yet.",
      ),
    );
  },
};

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
      if (host !== "github.com" || owner === undefined || rest.length !== 1) {
        throw new DiscoveryRefused(
          "unsupported",
          "Reading a definition from GitLab is not available yet.",
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

/** Refuses until lane M11's opener is installed. */
export const noToolsPullRequestOpener: ToolsPullRequestOpener = {
  open() {
    return Promise.reject(
      new DiscoveryRefused(
        "opener",
        "The tools steering PR is not available yet.",
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
  grpc: GrpcDiscovery;
  definitions: DefinitionReader;
  catalog: RegistryCatalog;
  opener: ToolsPullRequestOpener;
  now(): Date;
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
    local: noLocalReporter,
    grpc: noGrpcDiscovery,
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

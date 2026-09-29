// seams.test.ts: each seam discovery reaches through, and the production
// default behind it (lane M10, #4682). Every fake comes in through a seam or
// a module mock, so no test reaches the network, a vault, or another lane's
// code. The default credentials seam is never resolved here, because that
// would load lane M8's credential modules.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CredentialRequest,
  CredentialSource,
  McpLockSource,
  McpTool,
  ResolvedCredential,
  ServerSource,
  Transport,
} from "@oxagen/mcp-studio";
import { importGrpc } from "@oxagen/mcp-studio";
import {
  deliveryId,
  digestMismatch,
  notInGroup,
  refusalText,
  type Delivery,
  type Reply,
} from "@oxagen/tacho/local-servers";
import type {
  SteeringHost,
  SteeringRepository,
} from "../../context.steering.github";
import type { LocalGatewayBroker } from "../local-calls/broker";
import { MACHINE, readerOf } from "../local-calls/test-support";
import {
  discoverySeams,
  gatewayLocalReporter,
  githubDefinitionReader,
  hostSteeringFiles,
  installDiscoverySeams,
  noCredentials,
  noLocalReporter,
  noToolsPullRequestOpener,
  resetDiscoverySeams,
  transportRegistryCatalog,
  vaultCredentials,
  type DefinitionGitHub,
  type DefinitionLocation,
  type GatewayLocalReporterDeps,
  type GrpcImporter,
  type ToolsPullRequestOpener,
} from "./seams";
import { DiscoveryRefused, type DiscoveryScope } from "./types";

const mocks = vi.hoisted(() => {
  const steering = {
    resolveRepository: vi.fn<SteeringHost["resolveRepository"]>(),
    branchHead: vi.fn<SteeringHost["branchHead"]>(),
    readFile: vi.fn<SteeringHost["readFile"]>(),
    listFiles: vi.fn<SteeringHost["listFiles"]>(),
    getPullRequest: vi.fn<SteeringHost["getPullRequest"]>(),
  };
  return {
    steering,
    createSteeringHost: vi.fn(() => steering as unknown as SteeringHost),
    createGitHubClient:
      vi.fn<
        (options: { token: string; signal?: AbortSignal }) => DefinitionGitHub
      >(),
    resolveGitHubToken:
      vi.fn<
        (scope: { orgId: string; workspaceId: string }) => Promise<string>
      >(),
  };
});

vi.mock("../../context.steering.host", () => ({
  createSteeringHost: mocks.createSteeringHost,
}));
vi.mock("@oxagen/github", () => ({
  createGitHubClient: mocks.createGitHubClient,
}));
vi.mock("@oxagen/github/workspace-token", () => ({
  resolveGitHubToken: mocks.resolveGitHubToken,
}));

const SCOPE: DiscoveryScope = {
  orgId: "0192a8f0-0000-7000-8000-000000000001",
  workspaceId: "0192a8f0-0000-7000-8000-000000000002",
};

const OTHER_SCOPE: DiscoveryScope = {
  orgId: "0192a8f0-0000-7000-8000-000000000003",
  workspaceId: "0192a8f0-0000-7000-8000-000000000004",
};

const REPO: SteeringRepository = {
  provider: "github",
  owner: "acme",
  repo: "steering",
  fullName: "acme/steering",
  currentFullName: "acme/steering",
  defaultBranch: "production",
};

const HEAD = "1".repeat(40);
const COMMIT = "2".repeat(40);
const BRANCH_HEAD = "3".repeat(40);
const TAG_COMMIT = "4".repeat(40);

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** The DiscoveryRefused a promise rejects with. Anything else fails the test. */
async function refusalOf(promise: Promise<unknown>): Promise<DiscoveryRefused> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DiscoveryRefused) return error;
    throw error;
  }
  throw new Error("The promise resolved, and a refusal was expected.");
}

beforeEach(() => {
  resetDiscoverySeams();
  mocks.steering.resolveRepository.mockResolvedValue(REPO);
  mocks.steering.branchHead.mockResolvedValue(HEAD);
  mocks.steering.readFile.mockImplementation((_repo, path) =>
    Promise.resolve(path === "mcp/files/server.toml" ? "name = 'files'" : null),
  );
  mocks.steering.listFiles.mockResolvedValue(["mcp/files/server.toml"]);
  mocks.steering.getPullRequest.mockResolvedValue({
    baseRef: "production",
    headSha: HEAD,
    open: false,
    merged: true,
    mergeCommitSha: COMMIT,
    mergedAt: new Date("2026-09-28T12:00:00.000Z"),
  });
});

// ── Steering files ───────────────────────────────────────────────────────────

describe("hostSteeringFiles", () => {
  const files = hostSteeringFiles(mocks.steering as unknown as SteeringHost);

  it("pins every read to the head of the production branch", async () => {
    const checkout = await files.open(SCOPE);

    expect(mocks.steering.resolveRepository).toHaveBeenCalledWith(SCOPE);
    expect(mocks.steering.branchHead).toHaveBeenCalledWith(REPO, "production");
    expect(checkout.commit).toBe(HEAD);

    await expect(checkout.read("mcp/files/server.toml")).resolves.toBe(
      "name = 'files'",
    );
    expect(mocks.steering.readFile).toHaveBeenCalledWith(
      REPO,
      "mcp/files/server.toml",
      HEAD,
    );
    await expect(checkout.read("mcp/none/server.toml")).resolves.toBeNull();

    await expect(checkout.list("mcp")).resolves.toEqual([
      "mcp/files/server.toml",
    ]);
    expect(mocks.steering.listFiles).toHaveBeenCalledWith(REPO, HEAD, "mcp");
  });

  it("answers whether a steering PR is open, whether it merged, and its branch head", async () => {
    const checkout = await files.open(SCOPE);
    await expect(checkout.pullRequest(42)).resolves.toEqual({
      open: false,
      merged: true,
      headSha: HEAD,
    });
    expect(mocks.steering.getPullRequest).toHaveBeenCalledWith(REPO, 42);
  });

  it("answers a null branch head when the host does not know it", async () => {
    mocks.steering.getPullRequest.mockResolvedValueOnce({
      baseRef: "production",
      headSha: null,
      open: true,
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
    });
    const checkout = await files.open(SCOPE);
    await expect(checkout.pullRequest(7)).resolves.toEqual({
      open: true,
      merged: false,
      headSha: null,
    });
  });

  it("refuses a steering repository with no production branch", async () => {
    mocks.steering.branchHead.mockResolvedValueOnce(null);
    const refusal = await refusalOf(files.open(SCOPE));
    expect(refusal).toMatchObject({
      code: "no_server",
      message: "The steering repository has no production branch.",
    });
    expect(mocks.steering.readFile).not.toHaveBeenCalled();
  });
});

// ── Credentials ──────────────────────────────────────────────────────────────

const REQUEST: CredentialRequest = {
  server: "billing",
  environment: "production",
  reference: "oxagen:credential/billing",
  auth: { mode: "service", scheme: "bearer", apply: { type: "http_bearer" } },
  operator: undefined,
};

const BEARER: ResolvedCredential = { type: "bearer", token: "tok_live_1234" };

function vaultSource() {
  const resolve = vi.fn<CredentialSource["resolve"]>(() =>
    Promise.resolve(BEARER),
  );
  const source: CredentialSource = { resolve };
  const build = vi.fn<(scope: DiscoveryScope) => Promise<CredentialSource>>(
    () => Promise.resolve(source),
  );
  return { build, resolve };
}

describe("noCredentials", () => {
  it("refuses every request", async () => {
    const refusal = await refusalOf(
      noCredentials(SCOPE).resolve(REQUEST, signal()),
    );
    expect(refusal).toMatchObject({
      code: "credential",
      message:
        "Discovery cannot read a stored credential yet, so a server with auth is not discovered.",
    });
  });
});

describe("vaultCredentials", () => {
  it("builds nothing until the first request", () => {
    const { build } = vaultSource();
    vaultCredentials(build)(SCOPE);
    expect(build).not.toHaveBeenCalled();
  });

  it("builds the source once and passes each request and signal through", async () => {
    const { build, resolve } = vaultSource();
    const credentials = vaultCredentials(build)(SCOPE);
    const first = signal();
    const second = signal();

    await expect(credentials.resolve(REQUEST, first)).resolves.toEqual(BEARER);
    await expect(credentials.resolve(REQUEST, second)).resolves.toEqual(
      BEARER,
    );

    expect(build).toHaveBeenCalledTimes(1);
    expect(build).toHaveBeenCalledWith(SCOPE);
    expect(resolve).toHaveBeenNthCalledWith(1, REQUEST, first);
    expect(resolve).toHaveBeenNthCalledWith(2, REQUEST, second);
  });

  it("shares one build between requests that start together", async () => {
    const { build, resolve } = vaultSource();
    const credentials = vaultCredentials(build)(SCOPE);

    await Promise.all([
      credentials.resolve(REQUEST, signal()),
      credentials.resolve(REQUEST, signal()),
    ]);

    expect(build).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("builds a separate source for each workspace", async () => {
    const { build } = vaultSource();
    const vault = vaultCredentials(build);

    await vault(SCOPE).resolve(REQUEST, signal());
    await vault(OTHER_SCOPE).resolve(REQUEST, signal());

    expect(build).toHaveBeenCalledTimes(2);
    expect(build).toHaveBeenNthCalledWith(1, SCOPE);
    expect(build).toHaveBeenNthCalledWith(2, OTHER_SCOPE);
  });

  it("rejects with the error a failed build gives", async () => {
    const build = vi.fn<(scope: DiscoveryScope) => Promise<CredentialSource>>(
      () => Promise.reject(new Error("The vault is unavailable.")),
    );
    await expect(
      vaultCredentials(build)(SCOPE).resolve(REQUEST, signal()),
    ).rejects.toThrow("The vault is unavailable.");
  });
});

// ── Local servers ────────────────────────────────────────────────────────────

const PACKAGE = {
  name: "acme-files-mcp",
  version: "0.4.0",
  digest: `sha256:${"c".repeat(64)}`,
};

const LOCAL_LOCK: McpLockSource = {
  type: "local",
  command: "/opt/acme/bin/files-mcp",
  package: PACKAGE,
};

const LOCAL_SOURCE: ServerSource = {
  type: "local",
  command: "files-mcp",
  args: ["--root", "/srv/files"],
  env: ["WORK_DIR"],
  machines: ["dev-laptops"],
};

const REMOTE_LOCK: McpLockSource = {
  type: "remote",
  url: "https://files.example.com/mcp",
};

const REMOTE_SOURCE: ServerSource = {
  type: "remote",
  url: "https://files.example.com/mcp",
  transport: "http",
};

const TOOL: McpTool = {
  name: "read_file",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
  },
};

function toolsReply(delivery: Delivery): Promise<Reply> {
  return Promise.resolve<Reply>({
    kind: "tools",
    id: deliveryId(delivery),
    machine: MACHINE,
    server: "files",
    server_version: "0.4.0",
    tools: [TOOL],
    reported_at: "2026-09-28T12:00:00.000Z",
  });
}

function refusedReply(delivery: Delivery): Promise<Reply> {
  return Promise.resolve<Reply>({
    kind: "refused",
    id: deliveryId(delivery),
    machine: MACHINE,
    refusal: digestMismatch(),
  });
}

function reporterWith(options: {
  answer?: (delivery: Delivery) => Promise<Reply>;
  connected?: (machine: string) => boolean;
  machines?: readonly string[];
  groups?: Record<string, readonly string[]>;
}) {
  const answer = options.answer ?? toolsReply;
  const dispatch = vi.fn<LocalGatewayBroker["dispatch"]>(
    (_machine, delivery) => answer(delivery),
  );
  const broker: LocalGatewayBroker = {
    connected: options.connected ?? (() => true),
    dispatch,
    next: () => Promise.resolve(undefined),
    reply: () => ({ accepted: false, reason: "unknown_id" }),
  };
  const machines = vi.fn<GatewayLocalReporterDeps["machines"]>(() =>
    Promise.resolve(options.machines ?? [MACHINE]),
  );
  const reporter = gatewayLocalReporter({
    broker,
    reader: readerOf(options.groups ?? { [MACHINE]: ["dev-laptops"] }),
    machines,
  });
  return { reporter, dispatch, machines };
}

function localRequest(source: ServerSource, lockSource: McpLockSource) {
  return { scope: SCOPE, server: "files", source, lockSource, signal: signal() };
}

describe("noLocalReporter", () => {
  it("refuses every server that runs on machines", async () => {
    const refusal = await refusalOf(
      noLocalReporter.report(localRequest(LOCAL_SOURCE, LOCAL_LOCK)),
    );
    expect(refusal).toMatchObject({
      code: "unsupported",
      message:
        "Discovery cannot reach the local gateway yet, so a server that runs on machines is not discovered.",
    });
  });
});

describe("gatewayLocalReporter", () => {
  it("asks the first connected machine in the server's groups for its tools", async () => {
    const { reporter, dispatch, machines } = reporterWith({
      machines: ["tch_offline01", MACHINE, "tch_standby01"],
      connected: (machine) => machine !== "tch_offline01",
    });

    const report = await reporter.report(
      localRequest(LOCAL_SOURCE, LOCAL_LOCK),
    );

    expect(report).toEqual({
      machine: MACHINE,
      server_version: "0.4.0",
      tools: [TOOL],
    });
    expect(machines).toHaveBeenCalledWith(SCOPE, ["dev-laptops"]);
    expect(dispatch).toHaveBeenCalledTimes(1);
    const [machine, delivery] = dispatch.mock.calls[0] ?? [];
    expect(machine).toBe(MACHINE);
    expect(delivery).toMatchObject({
      kind: "discover",
      launch: {
        server: "files",
        command: "/opt/acme/bin/files-mcp",
        args: ["--root", "/srv/files"],
        env: ["WORK_DIR"],
        package: PACKAGE,
      },
    });
  });

  it("refuses a server whose lock names no package to run", async () => {
    const { reporter, dispatch, machines } = reporterWith({});
    const refusal = await refusalOf(
      reporter.report(localRequest(REMOTE_SOURCE, REMOTE_LOCK)),
    );
    expect(refusal).toMatchObject({
      code: "source",
      message: "The lock for files names no package for a machine to run.",
    });
    expect(machines).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("refuses when no machine in the groups is connected", async () => {
    const { reporter, dispatch } = reporterWith({
      machines: [MACHINE, "tch_standby01"],
      connected: () => false,
    });
    const refusal = await refusalOf(
      reporter.report(localRequest(LOCAL_SOURCE, LOCAL_LOCK)),
    );
    expect(refusal).toMatchObject({
      code: "source",
      message:
        "No machine in dev-laptops is connected, so files was not discovered.",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("says any group when the server names no machine group", async () => {
    const { reporter, machines } = reporterWith({ machines: [] });
    const source: ServerSource = { type: "local", command: "files-mcp" };
    const refusal = await refusalOf(
      reporter.report(localRequest(source, LOCAL_LOCK)),
    );
    expect(refusal).toMatchObject({
      code: "source",
      message:
        "No machine in any group is connected, so files was not discovered.",
    });
    expect(machines).toHaveBeenCalledWith(SCOPE, []);
  });

  it("turns the machine's refusal into its text", async () => {
    const { reporter } = reporterWith({ answer: refusedReply });
    const refusal = await refusalOf(
      reporter.report(localRequest(LOCAL_SOURCE, LOCAL_LOCK)),
    );
    expect(refusal).toMatchObject({
      code: "source",
      message: refusalText(digestMismatch()),
    });
  });

  it("refuses a reported tool whose input schema names no object type", async () => {
    // The gateway's wire keeps any object as an input schema, so the
    // reporter's own parse is what refuses this tool.
    const { reporter } = reporterWith({
      answer: (delivery) =>
        Promise.resolve<Reply>({
          kind: "tools",
          id: deliveryId(delivery),
          machine: MACHINE,
          server: "files",
          server_version: "0.4.0",
          tools: [{ name: "read_file", inputSchema: { properties: {} } }],
          reported_at: "2026-09-28T12:00:00.000Z",
        }),
    });
    const refusal = await refusalOf(
      reporter.report(localRequest(LOCAL_SOURCE, LOCAL_LOCK)),
    );
    expect(refusal).toMatchObject({
      code: "source",
      message: `${MACHINE} reported a tool named "read_file" for files whose inputSchema.type does not fit an MCP tool, so files was not discovered.`,
    });
    expect(refusal.message).toContain("inputSchema.type");
    expect(refusal.message).toContain(MACHINE);
  });

  it("refuses a connected machine outside the server's groups", async () => {
    const { reporter, dispatch } = reporterWith({
      groups: { [MACHINE]: ["ci-runners"] },
    });
    const refusal = await refusalOf(
      reporter.report(localRequest(LOCAL_SOURCE, LOCAL_LOCK)),
    );
    expect(refusal).toMatchObject({
      code: "source",
      message: refusalText(notInGroup(["dev-laptops"])),
    });
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// ── Definitions in a linked repository ───────────────────────────────────────

const DEFINITION = "openapi: 3.1.0\n";

function githubWith(parts: {
  branch?: string;
  commits?: string[];
  file?: string | null;
}) {
  return {
    getBranch: vi.fn<DefinitionGitHub["getBranch"]>((args) =>
      Promise.resolve(
        parts.branch === undefined
          ? null
          : { name: args.branch, sha: parts.branch },
      ),
    ),
    listPathCommits: vi.fn<DefinitionGitHub["listPathCommits"]>(() =>
      Promise.resolve((parts.commits ?? []).map((sha) => ({ sha }))),
    ),
    getFileContent: vi.fn<DefinitionGitHub["getFileContent"]>(() =>
      Promise.resolve(parts.file === undefined ? DEFINITION : parts.file),
    ),
  };
}

function readerOver(github: DefinitionGitHub) {
  const client = vi.fn<
    (scope: DiscoveryScope, signal: AbortSignal) => Promise<DefinitionGitHub>
  >(() => Promise.resolve(github));
  return { reader: githubDefinitionReader(client), client };
}

function at(ref: string, repo = "github.com/acme/api"): DefinitionLocation {
  return { repo, path: "specs/openapi.yaml", ref };
}

describe("githubDefinitionReader", () => {
  it("refuses a GitLab repository before it asks for a client", async () => {
    const { reader, client } = readerOver(githubWith({}));
    const refusal = await refusalOf(
      reader.read(SCOPE, at("main", "gitlab.com/acme/api"), signal()),
    );
    expect(refusal).toMatchObject({
      code: "unsupported",
      message: "Reading a definition from GitLab is not available yet.",
    });
    expect(client).not.toHaveBeenCalled();
  });

  it("refuses a repository that is not an owner and a name", async () => {
    const { reader, client } = readerOver(githubWith({}));
    for (const repo of [
      "github.com/acme",
      "github.com/acme/api/extra",
      "github.com//api",
    ]) {
      const refusal = await refusalOf(
        reader.read(SCOPE, at("main", repo), signal()),
      );
      expect(refusal).toMatchObject({
        code: "source",
        message: `The definition repo ${repo} is not a github.com/owner/name path.`,
      });
    }
    expect(client).not.toHaveBeenCalled();
  });

  it("reads at a 40-character commit without resolving it", async () => {
    const github = githubWith({ branch: BRANCH_HEAD });
    const { reader, client } = readerOver(github);
    const abort = signal();

    await expect(reader.read(SCOPE, at(COMMIT), abort)).resolves.toEqual({
      commit: COMMIT,
      text: DEFINITION,
    });

    expect(client).toHaveBeenCalledWith(SCOPE, abort);
    expect(github.getBranch).not.toHaveBeenCalled();
    expect(github.listPathCommits).not.toHaveBeenCalled();
    expect(github.getFileContent).toHaveBeenCalledWith({
      owner: "acme",
      repo: "api",
      path: "specs/openapi.yaml",
      ref: COMMIT,
    });
  });

  it("reads a branch at its head commit", async () => {
    const github = githubWith({ branch: BRANCH_HEAD });
    const { reader } = readerOver(github);

    await expect(reader.read(SCOPE, at("main"), signal())).resolves.toEqual({
      commit: BRANCH_HEAD,
      text: DEFINITION,
    });

    expect(github.getBranch).toHaveBeenCalledWith({
      owner: "acme",
      repo: "api",
      branch: "main",
    });
    expect(github.listPathCommits).not.toHaveBeenCalled();
    expect(github.getFileContent).toHaveBeenCalledWith(
      expect.objectContaining({ ref: BRANCH_HEAD }),
    );
  });

  it("reads a tag at the last commit that touched the path", async () => {
    const github = githubWith({ commits: [TAG_COMMIT, COMMIT] });
    const { reader } = readerOver(github);

    await expect(
      reader.read(SCOPE, at("v1.2.0"), signal()),
    ).resolves.toEqual({ commit: TAG_COMMIT, text: DEFINITION });

    expect(github.listPathCommits).toHaveBeenCalledWith({
      owner: "acme",
      repo: "api",
      path: "specs/openapi.yaml",
      ref: "v1.2.0",
      limit: 1,
    });
    expect(github.getFileContent).toHaveBeenCalledWith(
      expect.objectContaining({ ref: TAG_COMMIT }),
    );
  });

  it("refuses a ref where no commit touched the path", async () => {
    const github = githubWith({});
    const { reader } = readerOver(github);
    const refusal = await refusalOf(
      reader.read(SCOPE, at("v9.9.9"), signal()),
    );
    expect(refusal).toMatchObject({
      code: "source",
      message: "github.com/acme/api has no specs/openapi.yaml at v9.9.9.",
    });
    expect(github.getFileContent).not.toHaveBeenCalled();
  });

  it("refuses a path with no file at the resolved commit", async () => {
    const { reader } = readerOver(
      githubWith({ branch: BRANCH_HEAD, file: null }),
    );
    const refusal = await refusalOf(reader.read(SCOPE, at("main"), signal()));
    expect(refusal).toMatchObject({
      code: "source",
      message: "github.com/acme/api has no specs/openapi.yaml at main.",
    });
  });
});

// ── Registry catalog ─────────────────────────────────────────────────────────

const SERVER = "io.github.github/github-mcp-server";

const ENTRY = {
  server: {
    name: SERVER,
    description: "Issues, pull requests, and code on GitHub.",
    version: "0.18.0",
    remotes: [
      { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/" },
    ],
  },
};

async function* bodyOf(text: string): AsyncGenerator<Uint8Array> {
  yield new TextEncoder().encode(text);
}

function transportAnswering(status: number, text: string) {
  const cancel = vi.fn<() => void>();
  const http = vi.fn<Transport["http"]>(() =>
    Promise.resolve({ status, headers: [], body: bodyOf(text), cancel }),
  );
  const transport: Transport = {
    http,
    grpc: () => Promise.reject(new Error("The registry is not read by gRPC.")),
    local: () =>
      Promise.reject(new Error("The registry is not a local server.")),
  };
  return { transport, http, cancel };
}

describe("transportRegistryCatalog", () => {
  it("reads the entry at the version through the Transport", async () => {
    const { transport, http, cancel } = transportAnswering(
      200,
      JSON.stringify(ENTRY),
    );
    const catalog = transportRegistryCatalog(() => transport);

    const entry = await catalog.entry(
      "https://registry.example.com/",
      SERVER,
      "latest",
      signal(),
    );

    expect(entry).toMatchObject({
      server: { name: SERVER, version: "0.18.0" },
    });
    expect(http).toHaveBeenCalledTimes(1);
    const [request] = http.mock.calls[0] ?? [];
    expect(request).toMatchObject({
      network: "cloud",
      relay_credential: undefined,
      headers: [["Accept", "application/json"]],
      target: {
        kind: "http",
        scheme: "https",
        method: "GET",
        host: "registry.example.com",
        path: "/v0.1/servers/io.github.github%2Fgithub-mcp-server/versions/latest",
      },
    });
    expect(cancel).not.toHaveBeenCalled();
  });

  it("keeps the registry's own path and encodes the version", async () => {
    const { transport, http } = transportAnswering(200, JSON.stringify(ENTRY));
    const catalog = transportRegistryCatalog(() => transport);

    await catalog.entry(
      "https://registry.example.com/mirror//",
      SERVER,
      "0.18.0+build/7",
      signal(),
    );

    const [request] = http.mock.calls[0] ?? [];
    expect(request?.target.path).toBe(
      "/mirror/v0.1/servers/io.github.github%2Fgithub-mcp-server/versions/0.18.0%2Bbuild%2F7",
    );
  });

  it("refuses an entry the registry does not have", async () => {
    const { transport, cancel } = transportAnswering(404, "not found");
    const catalog = transportRegistryCatalog(() => transport);
    const refusal = await refusalOf(
      catalog.entry("https://registry.example.com", SERVER, "9.9.9", signal()),
    );
    expect(refusal.code).toBe("source");
    expect(refusal.message).toContain("HTTP 404");
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("refuses a reply that is not JSON", async () => {
    const { transport } = transportAnswering(200, "<html>busy</html>");
    const catalog = transportRegistryCatalog(() => transport);
    const refusal = await refusalOf(
      catalog.entry("https://registry.example.com", SERVER, "latest", signal()),
    );
    expect(refusal).toMatchObject({
      code: "source",
      message: `The registry's entry for ${SERVER} latest is not JSON.`,
    });
  });

  it("refuses JSON that is not a server entry", async () => {
    const { transport } = transportAnswering(
      200,
      JSON.stringify({ servers: [] }),
    );
    const catalog = transportRegistryCatalog(() => transport);
    const refusal = await refusalOf(
      catalog.entry("https://registry.example.com", SERVER, "latest", signal()),
    );
    expect(refusal).toMatchObject({
      code: "source",
      message: `The registry's entry for ${SERVER} latest is not a server entry.`,
    });
  });
});

// ── The tools steering PR ────────────────────────────────────────────────────

describe("noToolsPullRequestOpener", () => {
  it("refuses with its own code, so a missing opener reads apart from a failed one", async () => {
    const refusal = await refusalOf(
      noToolsPullRequestOpener.open(SCOPE, {
        branch: "oxagen/tools/files",
        title: "Update the tools of files",
        body: "Discovery found one new tool.",
        commitMessage: "Update the tools of files",
        files: [],
      }),
    );
    expect(refusal).toBeInstanceOf(DiscoveryRefused);
    expect(refusal.code).toBe("no_opener");
    expect(refusal.message).toBe(
      "No tools steering PR opener is installed, so discovery cannot open the sync steering PR.",
    );
  });
});

// ── The installed set ────────────────────────────────────────────────────────

describe("discoverySeams", () => {
  it("gives the refusing defaults for the lanes not yet installed", async () => {
    const seams = await discoverySeams();
    expect(seams.local).toBe(noLocalReporter);
    expect(seams.opener).toBe(noToolsPullRequestOpener);
    expect(typeof seams.credentials(SCOPE).resolve).toBe("function");
  });

  it("reads gRPC definitions with lane M3's importer", async () => {
    const seams = await discoverySeams();
    expect(seams.grpc).toBe(importGrpc);
  });

  it("keeps one cloud Transport and one set of defaults", async () => {
    const first = await discoverySeams();
    const second = await discoverySeams();
    expect(first.transport()).toBe(second.transport());
    expect(first.steering).toBe(second.steering);
    expect(first.catalog).toBe(second.catalog);
  });

  it("tells the time from the clock", async () => {
    const before = Date.now();
    const now = (await discoverySeams()).now();
    expect(now).toBeInstanceOf(Date);
    expect(now.getTime()).toBeGreaterThanOrEqual(before);
    expect(now.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it("reads the steering repository through the steering host", async () => {
    const checkout = await (await discoverySeams()).steering.open(SCOPE);
    expect(checkout.commit).toBe(HEAD);
    expect(mocks.steering.resolveRepository).toHaveBeenCalledWith(SCOPE);
  });

  it("reads a definition with the workspace's GitHub token", async () => {
    const github = githubWith({});
    mocks.resolveGitHubToken.mockResolvedValueOnce("ghs_workspace_token");
    mocks.createGitHubClient.mockReturnValueOnce(github);
    const abort = signal();

    const seams = await discoverySeams();
    await expect(
      seams.definitions.read(SCOPE, at(COMMIT), abort),
    ).resolves.toEqual({ commit: COMMIT, text: DEFINITION });

    expect(mocks.resolveGitHubToken).toHaveBeenCalledWith({
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
    });
    expect(mocks.createGitHubClient).toHaveBeenCalledWith({
      token: "ghs_workspace_token",
      signal: abort,
    });
  });

  it("puts an installed seam over its default and keeps the rest", async () => {
    const opener: ToolsPullRequestOpener = {
      open: () =>
        Promise.resolve({
          number: 7,
          url: "https://github.com/acme/steering/pull/7",
          branch: "oxagen/tools/files",
          headSha: HEAD,
        }),
    };
    installDiscoverySeams({ opener });

    const seams = await discoverySeams();
    expect(seams.opener).toBe(opener);
    expect(seams.local).toBe(noLocalReporter);
    expect(seams.grpc).toBe(importGrpc);
  });

  it("merges a second install with the first", async () => {
    const early = new Date("2026-09-28T08:00:00.000Z");
    const late = new Date("2026-09-28T09:00:00.000Z");
    const grpc: GrpcImporter = () => Promise.reject(new Error("no gRPC"));
    installDiscoverySeams({ now: () => early, local: noLocalReporter });
    installDiscoverySeams({ grpc, now: () => late });

    const seams = await discoverySeams();
    expect(seams.now()).toBe(late);
    expect(seams.local).toBe(noLocalReporter);
    expect(seams.grpc).toBe(grpc);
  });

  it("drops every installed seam on reset", async () => {
    const fixed = new Date("2026-09-28T08:00:00.000Z");
    installDiscoverySeams({ now: () => fixed });
    expect((await discoverySeams()).now()).toBe(fixed);

    resetDiscoverySeams();
    expect((await discoverySeams()).now()).not.toBe(fixed);
  });
});

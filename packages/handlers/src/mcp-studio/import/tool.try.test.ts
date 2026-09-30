// tool.try.test.ts: try_studio_tool over an in-memory steering repo.
// The importers, the build, the Cedar decision, and M6's executor are the real
// ones. The store, the host, the credential source, and the transport are
// fakes, and the billing folder comes from packages/mcp-studio/fixtures.
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("../../context.steering.host", () => ({
  createSteeringHost: vi.fn(() => {
    throw new Error("each test passes its own host");
  }),
}));

import { readFileSync } from "node:fs";
import {
  toManifestServer,
  type HttpTransportRequest,
  type HttpTransportResponse,
  type ManifestServer,
  type ResolvedCredential,
  type Transport,
} from "@oxagen/mcp-studio";
import { HandlerError } from "@oxagen/oxagen";
import type { ToolStudioTryInput } from "@oxagen/oxagen/contracts/tool.studio.try";
import { requireCedarRuntime, type AgentDeclaration, type CedarRuntime, type PolicyFile } from "@oxagen/policy";
import type { SteeringRepository } from "../../context.steering.github";
import { TEST_CTX } from "../../test-utils/fixtures";
import { buildStudioFolderView } from "./findings.list";
import type { StudioReviewHost } from "./review.open";
import { importSource } from "./source";
import { createTryStudioToolHandler, type PublishedSteering, type TryEmergencyStop } from "./tool.try";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A file under packages/mcp-studio/fixtures. */
function fixture(path: string): string {
  return readFileSync(new URL(`../../../../mcp-studio/fixtures/${path}`, import.meta.url), "utf8");
}

type Tree = Record<string, string>;

const REPO: SteeringRepository = {
  provider: "github",
  owner: "acme",
  repo: "steering",
  fullName: "acme/steering",
  currentFullName: "acme/steering",
  defaultBranch: "main",
};

const BILLING_CREDENTIAL = "oxagen:credential/billing-oauth-client";

/** The operator's access token. The tests check it never comes back. */
const TOKEN = "tok-try-5d1e7c90";

const AGENT: AgentDeclaration = {
  name: "a-intel.core.release-bot",
  operator: "priya",
  runtime: "ci-linux-01",
  harness: "claude-code",
};

const OTHER_AGENT: AgentDeclaration = {
  name: "a-intel.core.triage-bot",
  operator: "priya",
  runtime: "ci-linux-02",
  harness: "claude-code",
};

/** The billing folder as production holds it. */
function billingMain(): Tree {
  const paths = ["server.toml", "tools.toml", "tools.lock.json", "openapi.yaml", "tests/calls.jsonl", "tests/selection.jsonl"];
  return Object.fromEntries(paths.map((path) => [`tools/servers/billing/${path}`, fixture(`servers/billing/${path}`)]));
}

/** A stable fake commit sha for a branch. */
function headOf(branch: string): string {
  return Buffer.from(branch).toString("hex").padEnd(40, "0").slice(0, 40);
}

function fakeHost(refs: Record<string, Tree>) {
  const trees = new Map(Object.entries(refs).map(([branch, tree]) => [headOf(branch), tree]));
  return {
    resolveRepository: vi.fn(async () => REPO),
    branchHead: vi.fn(async (_repo: SteeringRepository, branch: string) => (branch in refs ? headOf(branch) : null)),
    readFile: vi.fn(async (_repo: SteeringRepository, path: string, ref: string) => trees.get(ref)?.[path] ?? null),
    listFiles: vi.fn(async (_repo: SteeringRepository, ref: string, dir: string) =>
      Object.keys(trees.get(ref) ?? {})
        .filter((path) => path.startsWith(`${dir}/`))
        .sort(),
    ),
  } satisfies Pick<StudioReviewHost, "resolveRepository" | "branchHead" | "readFile" | "listFiles">;
}

/** The billing server as the published version holds it: production's folder, compiled. */
let TWIN: ManifestServer;
let runtime: CedarRuntime;

beforeAll(async () => {
  runtime = await requireCedarRuntime();
  const host = fakeHost({ main: billingMain() });
  const { folder } = await buildStudioFolderView(
    {
      store: { get: vi.fn(async () => null) },
      host: () => host,
      credentials: async () => new Set([BILLING_CREDENTIAL]),
      importSource: (source) => importSource(source),
    },
    { orgId: TEST_CTX.orgId, workspaceId: TEST_CTX.workspaceId },
    "billing",
  );
  TWIN = toManifestServer(folder.compiled, folder.lock);
});

// ── Transport ────────────────────────────────────────────────────────────────

type Answer = { status: number; body: unknown; headers?: [string, string][] };

/** list_charges' recorded answer, with the operator's token echoed in one charge id. */
const CHARGES: Answer = {
  status: 200,
  body: {
    data: [
      { id: "ch_3P9", amount: 4000, currency: "usd", status: "succeeded" },
      { id: `ch_${TOKEN}`, amount: 12500, currency: "usd", status: "succeeded" },
    ],
  },
  headers: [["x-api-token", TOKEN]],
};

function response(answer: Answer): HttpTransportResponse {
  const bytes = new TextEncoder().encode(JSON.stringify(answer.body));
  return {
    status: answer.status,
    headers: [["content-type", "application/json"], ...(answer.headers ?? [])],
    body: (async function* () {
      yield bytes;
    })(),
    cancel: vi.fn(),
  };
}

function fakeTransport(answer: Answer | (() => never)) {
  const requests: HttpTransportRequest[] = [];
  const transport: Transport = {
    http: vi.fn(async (request: HttpTransportRequest) => {
      requests.push(request);
      if (typeof answer === "function") answer();
      return response(answer as Answer);
    }),
    grpc: vi.fn(async () => {
      throw new Error("billing is an OpenAPI server.");
    }),
    local: vi.fn(async () => {
      throw new Error("Try it sends only over the cloud network.");
    }),
  };
  return { transport, requests };
}

function header(request: HttpTransportRequest, name: string): string | undefined {
  return request.headers.find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

// ── Rig ──────────────────────────────────────────────────────────────────────

interface RigOptions {
  policies?: PolicyFile[];
  agents?: AgentDeclaration[];
  twin?: (twin: ManifestServer) => ManifestServer;
  published?: PublishedSteering | null;
  answer?: Answer | (() => never);
  credential?: ResolvedCredential;
  off?: { servers?: string[]; tools?: string[] };
  stop?: TryEmergencyStop | null;
}

function rig(options: RigOptions = {}) {
  const host = fakeHost({ main: billingMain() });
  const twin = options.twin === undefined ? TWIN : options.twin(structuredClone(TWIN));
  const published: PublishedSteering | null =
    options.published === undefined
      ? { workspace: "core-platform", version: 1, servers: [twin], policies: options.policies ?? [], agents: options.agents ?? [AGENT] }
      : options.published;
  const { transport, requests } = fakeTransport(options.answer ?? CHARGES);
  const resolve = vi.fn(async () => options.credential ?? ({ type: "bearer", token: TOKEN } as ResolvedCredential));
  const emergencyDeny = vi.fn(async () => options.stop ?? null);
  const warn = vi.fn();
  const handler = createTryStudioToolHandler({
    store: { get: vi.fn(async () => null) },
    authorize: vi.fn(async () => "u_1"),
    host: () => host,
    credentials: async () => new Set([BILLING_CREDENTIAL]),
    importSource: (source) => importSource(source),
    published: vi.fn(async () => published),
    cedar: async () => runtime,
    off: async () => ({ servers: new Set(options.off?.servers ?? []), tools: new Set(options.off?.tools ?? []) }),
    emergencyDeny,
    operatorRole: vi.fn(async () => undefined),
    credentialSource: () => ({ resolve }),
    transport: () => transport,
    now: () => Date.UTC(2026, 8, 29, 12),
    log: { warn },
  });
  return {
    requests,
    transport,
    resolve,
    emergencyDeny,
    warn,
    run: (input: Partial<ToolStudioTryInput> = {}) =>
      handler(
        {
          server: "billing",
          tool: "list_charges",
          environment: "sandbox",
          arguments: { customer_id: "cus_81" },
          ...input,
        },
        TEST_CTX,
      ),
  };
}

async function refusal(promise: Promise<unknown>): Promise<HandlerError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HandlerError) return err;
    throw err;
  }
  throw new Error("try_studio_tool did not refuse.");
}

const CLOSED: PolicyFile = {
  path: "policies/charges.cedar",
  text: '@id("charges.closed")\nforbid (principal, action == Action::"billing__list_charges", resource);\n',
};

const ASKS: PolicyFile = {
  path: "policies/charges.cedar",
  text: '@id("charges.ask")\n@decision("require_approval")\nforbid (principal, action == Action::"billing__list_charges", resource);\n',
};

// ── Tests ────────────────────────────────────────────────────────────────────

describe("try_studio_tool", () => {
  it("sends an allowed call to the sandbox and returns the request, the answer, and the shaped result", async () => {
    const t = rig();
    const out = await t.run();

    expect(out).toMatchObject({
      ok: true,
      server: "billing",
      tool: "billing__list_charges",
      environment: "sandbox",
      agent: AGENT.name,
      exchanges: 1,
      cut: [],
    });
    if (!out.ok) throw new Error(out.message);
    expect(out.shaped).toContain("ch_3P9");

    expect(t.requests).toHaveLength(1);
    const [sent] = t.requests;
    expect(sent?.target).toMatchObject({ method: "GET", host: "billing-sandbox.a-intel.com" });
    expect(sent?.target.path).toContain("/customers/cus_81/charges");
    expect(sent === undefined ? undefined : header(sent, "authorization")).toBe(`Bearer ${TOKEN}`);

    expect(t.resolve).toHaveBeenCalledWith(
      expect.objectContaining({ server: "billing", environment: "sandbox", reference: BILLING_CREDENTIAL, operator: "u_1" }),
      expect.anything(),
    );
    expect(t.emergencyDeny).toHaveBeenCalledWith(TEST_CTX, {
      server: "billing",
      tool: "billing__list_charges",
      credential: null,
      readOnly: true,
    });
  });

  it("removes the operator's token from the request, the raw answer, and the shaped result", async () => {
    const out = await rig().run();

    if (!out.ok) throw new Error(out.message);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.shaped).toContain("ch_[redacted]");
    expect(out.raw).toContain("[redacted]");
  });

  it("denies a call a published policy forbids and sends nothing", async () => {
    const t = rig({ policies: [CLOSED] });
    const out = await t.run();

    expect(out).toMatchObject({ ok: false, reason: "denied" });
    expect(out.ok ? "" : out.message).toContain("charges.closed");
    expect(t.transport.http).not.toHaveBeenCalled();
    expect(t.resolve).not.toHaveBeenCalled();
  });

  it("denies a call a policy sends for approval, because Try it opens none", async () => {
    const t = rig({ policies: [ASKS] });
    const out = await t.run();

    expect(out).toMatchObject({ ok: false, reason: "denied" });
    expect(out.ok ? "" : out.message).toContain("asks a person to approve");
    expect(t.transport.http).not.toHaveBeenCalled();
  });

  it("denies a call to a server or a tool that is switched off", async () => {
    const server = rig({ off: { servers: ["billing"] } });
    const offServer = await server.run();
    expect(offServer).toMatchObject({ ok: false, reason: "denied" });
    expect(offServer.ok ? "" : offServer.message).toContain("billing is switched off");
    expect(server.transport.http).not.toHaveBeenCalled();

    const tool = rig({ off: { tools: ["billing__list_charges"] } });
    const offTool = await tool.run();
    expect(offTool).toMatchObject({ ok: false, reason: "denied" });
    expect(offTool.ok ? "" : offTool.message).toContain("billing__list_charges is switched off");
    expect(tool.transport.http).not.toHaveBeenCalled();
  });

  it("denies a call a kill switch stops", async () => {
    const t = rig({ stop: { id: "ks_7", targetKind: "mcp_server", targetId: "billing", reason: "Charges are under review" } });
    const out = await t.run();

    expect(out).toMatchObject({ ok: false, reason: "denied" });
    expect(out.ok ? "" : out.message).toContain("Kill switch ks_7 on mcp server billing");
    expect(t.transport.http).not.toHaveBeenCalled();
  });

  it("reports an upstream error as failed, with the request and the answer", async () => {
    const out = await rig({ answer: { status: 404, body: { error: { message: "No such customer: cus_81" } } } }).run();

    expect(out).toMatchObject({ ok: false, reason: "failed" });
    if (out.ok) throw new Error("the call did not fail");
    expect(out.request).toBeDefined();
    expect(out.raw).toContain("404");
  });

  it("reports a transport failure as failed, without the token", async () => {
    const out = await rig({
      answer: () => {
        throw new Error(`connect ECONNREFUSED while sending Bearer ${TOKEN}`);
      },
    }).run();

    expect(out).toMatchObject({ ok: false, reason: "failed" });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it("returns the connect link when the operator has not signed in", async () => {
    const t = rig({
      credential: {
        type: "missing",
        message: "Connect your Billing API account in Oxagen, then retry.",
        connect_url: "https://oxagen.app/connect/billing",
      },
    });
    const out = await t.run();

    expect(out).toMatchObject({ ok: false, reason: "failed" });
    expect(out.ok ? "" : out.message).toContain("https://oxagen.app/connect/billing");
    expect(t.transport.http).not.toHaveBeenCalled();
  });

  it("refuses an environment off the cloud network", async () => {
    const err = await refusal(rig().run({ environment: "production" }));
    expect(err.reason).toBe("network_unsupported");
  });

  it("refuses an environment whose address differs from the published version", async () => {
    const t = rig({
      twin: (twin) => {
        const sandbox = twin.environments.sandbox;
        if (sandbox === undefined) throw new Error("the billing fixture has no sandbox");
        return { ...twin, environments: { ...twin.environments, sandbox: { ...sandbox, url: "https://billing-old.a-intel.com/v2" } } };
      },
    });
    const err = await refusal(t.run());
    expect(err.reason).toBe("environment_unpublished");
    expect(t.transport.http).not.toHaveBeenCalled();
  });

  it("refuses when the workspace has published no steering version", async () => {
    const err = await refusal(rig({ published: null }).run());
    expect(err.reason).toBe("no_published_policies");
  });

  it("asks for the agent when the workspace declares more than one", async () => {
    const t = rig({ agents: [AGENT, OTHER_AGENT] });
    const err = await refusal(t.run());
    expect(err.reason).toBe("agent_required");

    const out = await t.run({ agent: OTHER_AGENT.name });
    expect(out).toMatchObject({ ok: true, agent: OTHER_AGENT.name });
  });

  it("refuses a tool the folder does not have", async () => {
    const err = await refusal(rig().run({ tool: "delete_everything" }));
    expect(err.reason).toBe("tool_not_found");
  });
});

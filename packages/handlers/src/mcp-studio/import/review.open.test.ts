// review.open.test.ts: open_studio_review over an in-memory steering repo.
// The importers, the build, and the body are the real ones. The store and the
// opener are fakes, and each test reads back the commit the opener received.
import { describe, expect, it, vi } from "vitest";

vi.mock("../../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("../../context.steering.host", () => ({
  createSteeringHost: vi.fn(() => {
    throw new Error("each test passes its own host");
  }),
}));

import { readFileSync } from "node:fs";
import { HandlerError } from "@oxagen/oxagen";
import type { StudioDraftOp, StudioSource } from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import { parseToolsToml, type McpTools } from "@oxagen/mcp-studio";
import type { SteeringRepository } from "../../context.steering.github";
import type {
  ToolsPullRequestArgs,
  ToolsPullRequestOpener,
  ToolsPullRequestResult,
  ToolsPullRequestScope,
} from "../../tools.pr.open";
import { TEST_CTX } from "../../test-utils/fixtures";
import { createSaveStudioDraftHandler } from "./draft.save";
import { createOpenStudioReviewHandler, reviewBranch, type StudioReviewHost } from "./review.open";
import { importSource } from "./source";
import type { StoredStudioDraft, StudioDraftStore } from "./store";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A file under packages/mcp-studio/fixtures, read when a test asks for it. */
function fixture(path: string): string {
  return readFileSync(new URL(`../../../../mcp-studio/fixtures/${path}`, import.meta.url), "utf8");
}

function fixtureJson<T>(path: string): T {
  return JSON.parse(fixture(path)) as T;
}

/** A repository's files at one ref, by repository path. */
type Tree = Record<string, string>;

const REPO: SteeringRepository = {
  provider: "github",
  owner: "acme",
  repo: "steering",
  fullName: "acme/steering",
  currentFullName: "acme/steering",
  defaultBranch: "main",
};
const SCOPE = { orgId: TEST_CTX.orgId, workspaceId: TEST_CTX.workspaceId };
const COMMIT = "4be91d2c0a7e5f3b9d18e6a2c4f0b7d95e3a1c86";
const BILLING_CREDENTIAL = "oxagen:credential/billing-oauth-client";

function prUrl(n: number): string {
  return `https://github.com/acme/steering/pull/${n}`;
}

function folderTree(server: string, files: Record<string, string>): Tree {
  return Object.fromEntries(
    Object.entries(files).map(([path, text]) => [`tools/servers/${server}/${path}`, text]),
  );
}

/** The billing folder on the production branch, with a file Review does not manage. */
function billingMain(): Tree {
  const paths = [
    "server.toml",
    "tools.toml",
    "tools.lock.json",
    "openapi.yaml",
    "tests/calls.jsonl",
    "tests/selection.jsonl",
  ];
  return folderTree("billing", Object.fromEntries(paths.map((p) => [p, fixture(`servers/billing/${p}`)])));
}

/** The tree after a commit: each file written, and each null deleted. */
function applied(tree: Tree, files: ToolsPullRequestArgs["files"]): Tree {
  const next = { ...tree };
  for (const file of files) {
    if (file.content === null) delete next[file.path];
    else next[file.path] = file.content;
  }
  return next;
}

/** A server.toml for a server built from a definition at a URL, with no auth. */
function definitionServerToml(name: string, type: "graphql" | "grpc"): string {
  return [
    "#:schema https://oxagen.sh/schemas/mcp-server/v1.json",
    'schema = "mcp-server/v1"',
    `name = "${name}"`,
    `label = "Acme ${type}"`,
    'description = "Issues and ledger entries in the Acme services."',
    "",
    "[source]",
    `type = "${type}"`,
    'from = "url"',
    `url = "https://docs.acme.example/${type}"`,
    "",
    "[auth]",
    'mode = "none"',
    "",
    "[environments.prod]",
    'url = "https://api.acme.example/v1"',
    "",
    "[exposure]",
    'mode = "direct"',
    "",
    "[sync]",
    'schedule = "daily"',
    "",
  ].join("\n");
}

// ── Drafts and ops ───────────────────────────────────────────────────────────

type Classification = Omit<Extract<StudioDraftOp, { kind: "classify" }>, "kind" | "tool">;

function imp(tool: string): StudioDraftOp {
  return { kind: "import", tool };
}

function remove(tool: string): StudioDraftOp {
  return { kind: "remove", tool };
}

function classify(tool: string, c: Classification): StudioDraftOp {
  return { kind: "classify", tool, ...c };
}

const READ_TENANT: Classification = { risk: "low", sideEffect: "read", egress: "org_tenant", impacts: [] };
const READ_THIRD_PARTY: Classification = { risk: "low", sideEffect: "read", egress: "third_party", impacts: [] };

/** A saved test of list_charges, as Studio stages it: no credential header. */
const LIST_CHARGES_TEST: StudioDraftOp = {
  kind: "test",
  tool: "list_charges",
  environment: "sandbox",
  args: JSON.stringify({ customer_id: "cus_81" }),
  request: JSON.stringify({ method: "GET", path: "/customers/cus_81/charges" }),
  raw: JSON.stringify({ status: 200, body: { data: [{ id: "ch_3P9", amount: 4000 }] } }),
  shaped: JSON.stringify({ data: [{ id: "ch_3P9", amount: 4000 }] }),
};

function draft(fields: Partial<StoredStudioDraft> & { server: string }): StoredStudioDraft {
  return {
    serverId: null,
    ops: [],
    serverToml: null,
    source: null,
    revision: 1,
    pr: null,
    updatedAt: new Date("2026-09-28T12:00:00Z"),
    ...fields,
  };
}

/** The billing definition as Studio sends it. A null commit leaves the commit out. */
function billingSource(commit: string | null): StudioSource {
  return {
    type: "openapi",
    files: [{ path: "openapi.yaml", text: fixture("servers/billing/openapi.yaml") }],
    entry: "openapi.yaml",
    ...(commit === null ? {} : { commit }),
  };
}

function stripeSource(): StudioSource {
  return {
    type: "mcp",
    lockSource: fixtureJson<{ source: Record<string, unknown> }>("servers/stripe/tools.lock.json").source,
    tools: fixtureJson<{ tools: Record<string, unknown>[] }>("sources/stripe/tools-list.json").tools,
  };
}

function stripeDraft(ops: StudioDraftOp[]): StoredStudioDraft {
  return draft({
    server: "stripe",
    serverToml: fixture("servers/stripe/server.toml"),
    source: stripeSource(),
    ops,
  });
}

function billingFirstImport(commit: string | null): StoredStudioDraft {
  return draft({
    server: "billing",
    serverToml: fixture("servers/billing/server.toml"),
    source: billingSource(commit),
    ops: [
      imp("list_charges"),
      imp("get_charge"),
      classify("list_charges", READ_TENANT),
      classify("get_charge", READ_TENANT),
      LIST_CHARGES_TEST,
    ],
  });
}

// ── The rig ──────────────────────────────────────────────────────────────────

type OpenPr = { number: number; htmlUrl: string; body: string };

/** The fake head commit of a branch: its name in hex, cut or padded to 40 characters. */
function headOf(branch: string): string {
  return Buffer.from(branch).toString("hex").padEnd(40, "0").slice(0, 40);
}

/**
 * A repository whose branches are `refs`. Files are found by commit only, so a
 * read by branch name finds nothing, and every test proves Review reads the
 * commit it resolved.
 */
function fakeHost(refs: Record<string, Tree>, open: OpenPr | null) {
  const trees = new Map(Object.entries(refs).map(([branch, tree]) => [headOf(branch), tree]));
  return {
    resolveRepository: vi.fn(async () => REPO),
    branchHead: vi.fn(async (_repo: SteeringRepository, branch: string) =>
      branch in refs ? headOf(branch) : null,
    ),
    readFile: vi.fn(
      async (_repo: SteeringRepository, path: string, ref: string) => trees.get(ref)?.[path] ?? null,
    ),
    listFiles: vi.fn(async (_repo: SteeringRepository, ref: string, dir: string) =>
      Object.keys(trees.get(ref) ?? {})
        .filter((path) => path.startsWith(`${dir}/`))
        .sort(),
    ),
    findOpenPullRequest: vi.fn(async (): Promise<OpenPr | null> => open),
  } satisfies StudioReviewHost;
}

function fakeStore(stored: StoredStudioDraft | null) {
  return {
    get: vi.fn(async () => stored),
    save: vi.fn(async (): Promise<StoredStudioDraft> => {
      throw new Error("Review never saves the draft.");
    }),
    recordPr: vi.fn(async () => undefined),
  } satisfies StudioDraftStore;
}

function fakeOpener() {
  return {
    open: vi.fn(
      async (_scope: ToolsPullRequestScope, args: ToolsPullRequestArgs): Promise<ToolsPullRequestResult> => {
        const number = args.existing?.number ?? 41;
        return { number, url: prUrl(number), branch: args.branch, headSha: "3".repeat(40) };
      },
    ),
  } satisfies ToolsPullRequestOpener;
}

interface RigOptions {
  refs?: Record<string, Tree>;
  open?: OpenPr | null;
  credentials?: string[];
  authorize?: () => Promise<string | null>;
}

function rig(stored: StoredStudioDraft | null, options: RigOptions = {}) {
  const host = fakeHost(options.refs ?? { main: {} }, options.open ?? null);
  const store = fakeStore(stored);
  const opener = fakeOpener();
  const authorize = vi.fn(options.authorize ?? (async () => "u_1"));
  const handler = createOpenStudioReviewHandler({
    store,
    authorize,
    host: () => host,
    opener,
    credentials: async () => new Set(options.credentials ?? []),
    importSource: (source) => importSource(source),
  });
  return {
    host,
    store,
    opener,
    authorize,
    run: (input: { server: string; revision?: number }) => handler(input, TEST_CTX),
  };
}

async function refusal(promise: Promise<unknown>): Promise<HandlerError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HandlerError) return err;
    throw err;
  }
  throw new Error("Review did not refuse.");
}

/** The args of the opener's last call. */
function committed(opener: ReturnType<typeof fakeOpener>): ToolsPullRequestArgs {
  const call = opener.open.mock.calls.at(-1);
  if (call === undefined) throw new Error("The opener was not called.");
  return call[1];
}

/** The commit's paths, relative to the server's folder. */
function paths(args: ToolsPullRequestArgs, server: string): string[] {
  const dir = `tools/servers/${server}/`;
  return args.files.map((file) => {
    expect(file.path.startsWith(dir)).toBe(true);
    return file.path.slice(dir.length);
  });
}

function fileOf(args: ToolsPullRequestArgs, server: string, path: string): string {
  const file = args.files.find((f) => f.path === `tools/servers/${server}/${path}`);
  if (file === undefined || file.content === null) throw new Error(`The commit writes no ${path}.`);
  return file.content;
}

function toolsOf(args: ToolsPullRequestArgs, server: string): NonNullable<McpTools["tools"]> {
  const parsed = parseToolsToml(fileOf(args, server, "tools.toml"));
  if (!parsed.ok) throw new Error(`tools.toml does not parse: ${JSON.stringify(parsed.issues)}`);
  return parsed.value.tools ?? {};
}

function lockOf(args: ToolsPullRequestArgs, server: string): { source: Record<string, unknown>; tools: Record<string, unknown> } {
  return JSON.parse(fileOf(args, server, "tools.lock.json")) as {
    source: Record<string, unknown>;
    tools: Record<string, unknown>;
  };
}

function callsOf(text: string): { tool: string; arguments: unknown }[] {
  expect(text.endsWith("\n")).toBe(true);
  return text
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { tool: string; arguments: unknown });
}

// ── First imports ────────────────────────────────────────────────────────────

describe("open_studio_review on a first import", () => {
  it("writes an OpenAPI server's folder and records the PR on the draft", async () => {
    const r = rig(billingFirstImport(COMMIT), { credentials: [BILLING_CREDENTIAL] });
    const out = await r.run({ server: "billing", revision: 1 });

    const args = committed(r.opener);
    expect(args.branch).toBe("tools/billing");
    expect(args.existing).toBeUndefined();
    expect(args.title).toBe("Add the billing server");
    expect(args.commitMessage).toBe(
      "Add the billing server\n\nStudio draft revision 1: 2 imported, 0 removed, 0 reclassified.",
    );
    expect(paths(args, "billing")).toStrictEqual([
      "openapi.yaml",
      "server.toml",
      "tests/calls.jsonl",
      "tools.lock.json",
      "tools.toml",
    ]);
    expect(fileOf(args, "billing", "server.toml")).toBe(fixture("servers/billing/server.toml"));

    const tools = toolsOf(args, "billing");
    expect(Object.keys(tools)).toStrictEqual(["list_charges", "get_charge"]);
    expect(tools.list_charges).toMatchObject({
      operation: "listCharges",
      risk: "low",
      side_effect: "read",
      egress: "org_tenant",
    });
    expect(tools.get_charge).toMatchObject({ operation: "getCharge", risk: "low" });

    const lock = lockOf(args, "billing");
    expect(lock.source).toMatchObject({ type: "openapi", from: "repository", commit: COMMIT });
    expect(Object.keys(lock.tools).sort()).toStrictEqual(["get_charge", "list_charges"]);

    const calls = callsOf(fileOf(args, "billing", "tests/calls.jsonl"));
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ tool: "list_charges", arguments: { customer_id: "cus_81" } });

    expect(args.body).toContain("## Imported tools\n\n- `list_charges`\n- `get_charge`");
    expect(args.body).toContain("## Removed tools\n\nNone.");
    expect(args.body).toContain("## Saved tests\n\n- `list_charges`");
    expect(args.body).toContain("tokens against a budget of 8000.");

    expect(out).toMatchObject({
      number: 41,
      url: prUrl(41),
      branch: "tools/billing",
      headSha: "3".repeat(40),
      imported: ["list_charges", "get_charge"],
      removed: [],
      reclassified: [],
    });
    expect(out.tokens.budget).toBe(8000);
    expect(out.tokens.definitions).toBeGreaterThan(0);
    expect(r.store.recordPr).toHaveBeenCalledWith(SCOPE, "billing", {
      number: 41,
      url: prUrl(41),
      branch: "tools/billing",
    });
  });

  it("writes a GraphQL server's folder with the SDL vendored", async () => {
    const r = rig(
      draft({
        server: "tracker",
        serverToml: definitionServerToml("tracker", "graphql"),
        source: { type: "graphql", sdl: fixture("graphql/schema.graphql") },
        ops: [imp("issue"), classify("issue", READ_THIRD_PARTY)],
      }),
    );
    const out = await r.run({ server: "tracker" });

    const args = committed(r.opener);
    expect(args.branch).toBe("tools/tracker");
    expect(paths(args, "tracker")).toStrictEqual(["schema.graphql", "server.toml", "tools.lock.json", "tools.toml"]);
    expect(fileOf(args, "tracker", "schema.graphql")).toBe(fixture("graphql/schema.graphql"));
    expect(toolsOf(args, "tracker").issue).toMatchObject({ field: "Query.issue", egress: "third_party" });
    expect(lockOf(args, "tracker").source).toMatchObject({ type: "graphql", from: "url" });
    expect(out.imported).toStrictEqual(["issue"]);
  });

  it("writes a gRPC server's folder with the proto files under proto/", async () => {
    const r = rig(
      draft({
        server: "ledger",
        serverToml: definitionServerToml("ledger", "grpc"),
        source: { type: "grpc", files: [{ path: "proto/ledger.proto", text: fixture("grpc/ledger.proto") }] },
        ops: [imp("get_entry"), classify("get_entry", READ_TENANT)],
      }),
    );
    const out = await r.run({ server: "ledger" });

    const args = committed(r.opener);
    expect(paths(args, "ledger")).toStrictEqual(["proto/ledger.proto", "server.toml", "tools.lock.json", "tools.toml"]);
    expect(fileOf(args, "ledger", "proto/ledger.proto")).toBe(fixture("grpc/ledger.proto"));
    expect(toolsOf(args, "ledger").get_entry).toMatchObject({ method: "a_intel.ledger.v1.Ledger/GetEntry" });
    expect(lockOf(args, "ledger").source).toMatchObject({ type: "grpc", from: "url" });
    expect(out.imported).toStrictEqual(["get_entry"]);
  });

  it("writes an MCP server's folder with the lock source Studio recorded", async () => {
    const r = rig(stripeDraft([imp("list_charges"), classify("list_charges", READ_THIRD_PARTY)]));
    const out = await r.run({ server: "stripe" });

    const args = committed(r.opener);
    expect(args.title).toBe("Add the stripe server");
    expect(paths(args, "stripe")).toStrictEqual(["server.toml", "tools.lock.json", "tools.toml"]);
    const entry = toolsOf(args, "stripe").list_charges;
    expect(entry).toMatchObject({ risk: "low", side_effect: "read", egress: "third_party" });
    expect(entry).not.toHaveProperty("upstream");
    const lock = lockOf(args, "stripe");
    expect(lock.source).toStrictEqual(fixtureJson<{ source: unknown }>("servers/stripe/tools.lock.json").source);
    expect(Object.keys(lock.tools)).toStrictEqual(["list_charges"]);
    expect(out.imported).toStrictEqual(["list_charges"]);
  });

  it("refuses a repository definition that names no commit", async () => {
    const r = rig(billingFirstImport(null), { credentials: [BILLING_CREDENTIAL] });
    const err = await refusal(r.run({ server: "billing" }));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("source_commit_missing");
    expect(r.opener.open).not.toHaveBeenCalled();
  });
});

// ── Changes to a folder on main ──────────────────────────────────────────────

describe("open_studio_review on a folder already on main", () => {
  it("reclassifies a tool and commits only the files that change", async () => {
    const medium: Classification = { risk: "medium", sideEffect: "read", egress: "org_tenant", impacts: [] };
    const r = rig(draft({ server: "billing", ops: [classify("list_charges", medium)] }), {
      refs: { main: billingMain() },
      credentials: [BILLING_CREDENTIAL],
    });
    const out = await r.run({ server: "billing" });

    expect(out.reclassified).toStrictEqual([{ tool: "list_charges", before: READ_TENANT, after: medium }]);
    expect(out.imported).toStrictEqual([]);
    expect(out.removed).toStrictEqual([]);

    const args = committed(r.opener);
    expect(args.title).toBe("Update tools for billing");
    // Every read and the new branch use the one production commit Review
    // resolved, so a merge during the import cannot sit under this commit.
    expect(args.at).toBe(headOf("main"));
    expect(r.host.branchHead).toHaveBeenCalledWith(REPO, "main");
    for (const call of r.host.readFile.mock.calls) expect(call[2]).toBe(headOf("main"));
    for (const call of r.host.listFiles.mock.calls) expect(call[1]).toBe(headOf("main"));
    const changed = paths(args, "billing");
    expect(changed).toContain("tools.toml");
    for (const kept of ["server.toml", "openapi.yaml", "tests/calls.jsonl", "tests/selection.jsonl"]) {
      expect(changed).not.toContain(kept);
    }
    expect(args.files.every((file) => file.content !== null)).toBe(true);

    const tools = toolsOf(args, "billing");
    expect(tools.list_charges).toMatchObject({ operation: "listCharges", risk: "medium", paginate: "cursor" });
    expect(tools.create_refund).toMatchObject({ risk: "high", side_effect: "irreversible", impacts: ["moves_money"] });
    expect(args.body).toContain(
      "- `list_charges` from risk low, side effect read, egress org_tenant, no impacts to risk medium, side effect read, egress org_tenant, no impacts",
    );
  });

  it("removes a tool and drops its recorded calls", async () => {
    const r = rig(draft({ server: "billing", ops: [remove("list_charges")] }), {
      refs: { main: billingMain() },
      credentials: [BILLING_CREDENTIAL],
    });
    const out = await r.run({ server: "billing" });

    expect(out.removed).toStrictEqual(["list_charges"]);
    expect(out.reclassified).toStrictEqual([]);

    const args = committed(r.opener);
    expect(Object.keys(toolsOf(args, "billing"))).toStrictEqual(["create_refund"]);
    expect(Object.keys(lockOf(args, "billing").tools)).toStrictEqual(["create_refund"]);
    const calls = fileOf(args, "billing", "tests/calls.jsonl");
    const refundLine = fixture("servers/billing/tests/calls.jsonl").split("\n")[0];
    expect(calls).toBe(`${refundLine}\n`);
    expect(callsOf(calls).map((call) => call.tool)).toStrictEqual(["create_refund"]);
    expect(args.body).toContain("## Removed tools\n\n- `list_charges`");
  });

  it("refuses a draft that matches main", async () => {
    const first = rig(stripeDraft([imp("list_charges"), classify("list_charges", READ_THIRD_PARTY)]));
    await first.run({ server: "stripe" });
    const main = applied({}, committed(first.opener).files);

    const again = rig(stripeDraft([imp("list_charges"), classify("list_charges", READ_THIRD_PARTY)]), {
      refs: { main },
    });
    const err = await refusal(again.run({ server: "stripe" }));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("draft_unchanged");
    expect(err.message).toContain("matches main");
    expect(again.opener.open).not.toHaveBeenCalled();
    expect(again.store.recordPr).not.toHaveBeenCalled();
  });
});

// ── The refusal ──────────────────────────────────────────────────────────────

describe("open_studio_review refuses", () => {
  it("while an imported tool lacks a risk, a side effect, or an egress", async () => {
    const r = rig(
      stripeDraft([imp("list_charges"), classify("list_charges", READ_THIRD_PARTY), imp("create_refund")]),
    );
    const err = await refusal(r.run({ server: "stripe" }));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("tools_unclassified");
    expect(err.message).toBe(
      "Every imported tool needs a risk, a side effect, and an egress before Review opens a steering PR. Classify create_refund.",
    );
    expect(r.opener.open).not.toHaveBeenCalled();
    expect(r.store.recordPr).not.toHaveBeenCalled();
  });

  it("a saved test that carries a credential, whose value reaches no row, file, or PR body", async () => {
    const secret = "sk_live_51Hx9QeZ";
    const withCredential: StudioDraftOp = {
      ...LIST_CHARGES_TEST,
      request: JSON.stringify({
        method: "GET",
        path: "/customers/cus_81/charges",
        headers: { Authorization: `Bearer ${secret}` },
      }),
    };
    const first = billingFirstImport(COMMIT);
    const ops = [...first.ops.filter((op) => op.kind !== "test"), withCredential];
    const r = rig({ ...first, ops }, { credentials: [BILLING_CREDENTIAL] });

    // The save refuses the test, so no row holds it.
    const save = createSaveStudioDraftHandler({ store: r.store, authorize: r.authorize });
    const saveErr = await refusal(save({ server: "billing", ops, revision: 1 }, TEST_CTX));
    expect(saveErr.reason).toBe("test_holds_credential");
    expect(saveErr.message).not.toContain(secret);
    expect(r.store.save).not.toHaveBeenCalled();

    // A row that holds one anyway, such as a row stored before the save
    // checked tests, opens no PR, so no branch file or PR body carries it.
    const err = await refusal(r.run({ server: "billing", revision: 1 }));
    expect(err.reason).toBe("test_holds_credential");
    expect(err.message).not.toContain(secret);
    expect(r.opener.open).not.toHaveBeenCalled();
    expect(r.store.recordPr).not.toHaveBeenCalled();
  });

  it("a repository without its production branch", async () => {
    const r = rig(stripeDraft([]), { refs: {} });
    const err = await refusal(r.run({ server: "stripe" }));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("production_branch_missing");
    expect(err.message).toBe("acme/steering has no main branch.");
    expect(r.host.listFiles).not.toHaveBeenCalled();
    expect(r.opener.open).not.toHaveBeenCalled();
  });

  it("a server with no draft", async () => {
    const r = rig(null);
    const err = await refusal(r.run({ server: "stripe" }));
    expect(err.code).toBe("not_found");
    expect(err.reason).toBe("draft_not_found");
    expect(r.host.resolveRepository).not.toHaveBeenCalled();
  });

  it("a revision the stored draft has moved past", async () => {
    const r = rig({ ...stripeDraft([]), revision: 2 });
    const err = await refusal(r.run({ server: "stripe", revision: 1 }));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("draft_revision_stale");
    expect(r.host.resolveRepository).not.toHaveBeenCalled();
  });

  it("a person without the role, before it reads the draft", async () => {
    const r = rig(stripeDraft([]), {
      authorize: async () => {
        throw new HandlerError({ code: "forbidden", reason: "role_required", message: "No." });
      },
    });
    const err = await refusal(r.run({ server: "stripe" }));
    expect(err.code).toBe("forbidden");
    expect(r.store.get).not.toHaveBeenCalled();
  });
});

// ── An open steering PR ──────────────────────────────────────────────────────

describe("open_studio_review with a steering PR open on the branch", () => {
  const ops = (): StudioDraftOp[] => [imp("list_charges"), classify("list_charges", READ_THIRD_PARTY)];
  const open: OpenPr = { number: 7, htmlUrl: prUrl(7), body: "" };
  const refs = (): Record<string, Tree> => ({ main: {}, "tools/stripe": {} });

  it("adds a commit to the open PR", async () => {
    const r = rig(stripeDraft(ops()), { refs: refs(), open });
    const out = await r.run({ server: "stripe" });

    expect(r.host.findOpenPullRequest).toHaveBeenCalledWith(REPO, { head: reviewBranch("stripe"), base: "main" });
    const args = committed(r.opener);
    expect(args.existing).toStrictEqual({ number: 7 });
    // The branch's files were read at this commit, and the opener refuses a
    // branch that moved off it.
    expect(args.at).toBe(headOf("tools/stripe"));
    expect(paths(args, "stripe")).toStrictEqual(["server.toml", "tools.lock.json", "tools.toml"]);
    expect(out.number).toBe(7);
    expect(r.store.recordPr).toHaveBeenCalledWith(SCOPE, "stripe", {
      number: 7,
      url: prUrl(7),
      branch: "tools/stripe",
    });
  });

  it("refuses when the branch already holds every edit", async () => {
    const first = rig(stripeDraft(ops()));
    await first.run({ server: "stripe" });
    const branch = applied({}, committed(first.opener).files);

    const r = rig(stripeDraft(ops()), { refs: { main: {}, "tools/stripe": branch }, open });
    const err = await refusal(r.run({ server: "stripe" }));
    expect(err.reason).toBe("draft_unchanged");
    expect(err.message).toBe("Steering PR #7 already holds every edit in the stripe draft.");
    expect(r.opener.open).not.toHaveBeenCalled();
  });

  it("opens a new PR when the open one closed before the write", async () => {
    const r = rig(stripeDraft(ops()), { refs: refs(), open });
    r.opener.open.mockRejectedValueOnce(
      new HandlerError({ code: "conflict", reason: "tools_pr_not_open", message: "PR #7 is closed." }),
    );
    const out = await r.run({ server: "stripe" });

    expect(r.opener.open).toHaveBeenCalledTimes(2);
    expect(r.opener.open.mock.calls[0]?.[1].existing).toStrictEqual({ number: 7 });
    expect(r.opener.open.mock.calls[1]?.[1].existing).toBeUndefined();
    expect(r.opener.open.mock.calls[1]?.[1].at).toBe(headOf("main"));
    expect(out.number).toBe(41);
  });

  it("opens a new PR when the branch is gone before Review reads it", async () => {
    const r = rig(stripeDraft(ops()), { refs: { main: {} }, open });
    const out = await r.run({ server: "stripe" });

    expect(r.opener.open).toHaveBeenCalledTimes(1);
    const args = committed(r.opener);
    expect(args.existing).toBeUndefined();
    expect(args.at).toBe(headOf("main"));
    expect(out.number).toBe(41);
  });

  it("passes on a branch that moved after Review read it", async () => {
    const r = rig(stripeDraft(ops()), { refs: refs(), open });
    r.opener.open.mockRejectedValueOnce(
      new HandlerError({ code: "conflict", reason: "tools_branch_moved", message: "tools/stripe moved." }),
    );
    const err = await refusal(r.run({ server: "stripe" }));
    expect(err.reason).toBe("tools_branch_moved");
    expect(r.opener.open).toHaveBeenCalledTimes(1);
    expect(r.store.recordPr).not.toHaveBeenCalled();
  });

  it("passes on any other refusal from the opener", async () => {
    const r = rig(stripeDraft(ops()), { refs: refs(), open });
    r.opener.open.mockRejectedValueOnce(
      new HandlerError({ code: "conflict", reason: "tools_check_failed", message: "The check failed." }),
    );
    const err = await refusal(r.run({ server: "stripe" }));
    expect(err.reason).toBe("tools_check_failed");
    expect(r.opener.open).toHaveBeenCalledTimes(1);
    expect(r.store.recordPr).not.toHaveBeenCalled();
  });
});

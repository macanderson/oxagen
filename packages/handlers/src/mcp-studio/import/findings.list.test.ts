// findings.list.test.ts: list_studio_findings over an in-memory steering repo.
// The importers, the build, and lint are the real ones. The store and the host
// are fakes, and the billing folder comes from packages/mcp-studio/fixtures.
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
import type { SteeringRepository } from "../../context.steering.github";
import { TEST_CTX } from "../../test-utils/fixtures";
import { createListStudioFindingsHandler } from "./findings.list";
import type { StudioReviewHost } from "./review.open";
import { importSource } from "./source";
import type { StoredStudioDraft } from "./store";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** A file under packages/mcp-studio/fixtures. */
function fixture(path: string): string {
  return readFileSync(new URL(`../../../../mcp-studio/fixtures/${path}`, import.meta.url), "utf8");
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
const COMMIT = "4be91d2c0a7e5f3b9d18e6a2c4f0b7d95e3a1c86";
const BILLING_CREDENTIAL = "oxagen:credential/billing-oauth-client";

/** The billing folder on the production branch. */
function billingMain(): Tree {
  const paths = [
    "server.toml",
    "tools.toml",
    "tools.lock.json",
    "openapi.yaml",
    "tests/calls.jsonl",
    "tests/selection.jsonl",
  ];
  return Object.fromEntries(paths.map((p) => [`tools/servers/billing/${p}`, fixture(`servers/billing/${p}`)]));
}

type Classification = Omit<Extract<StudioDraftOp, { kind: "classify" }>, "kind" | "tool">;

const READ_TENANT: Classification = { risk: "low", sideEffect: "read", egress: "org_tenant", impacts: [] };

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

/** The billing definition as Studio sends it, read at COMMIT. */
function billingSource(): StudioSource {
  return {
    type: "openapi",
    files: [{ path: "openapi.yaml", text: fixture("servers/billing/openapi.yaml") }],
    entry: "openapi.yaml",
    commit: COMMIT,
  };
}

// ── The rig ──────────────────────────────────────────────────────────────────

/** The fake head commit of a branch: its name in hex, cut or padded to 40 characters. */
function headOf(branch: string): string {
  return Buffer.from(branch).toString("hex").padEnd(40, "0").slice(0, 40);
}

/** A repository whose branches are `refs`. Files are found by commit only. */
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

interface RigOptions {
  refs?: Record<string, Tree>;
  credentials?: string[];
  authorize?: () => Promise<string | null>;
}

function rig(stored: StoredStudioDraft | null, options: RigOptions = {}) {
  const host = fakeHost(options.refs ?? { main: {} });
  const store = { get: vi.fn(async () => stored) };
  const authorize = vi.fn(options.authorize ?? (async () => "u_1"));
  const imports = vi.fn((source: StudioSource) => importSource(source));
  const handler = createListStudioFindingsHandler({
    store,
    authorize,
    host: () => host,
    credentials: async () => new Set(options.credentials ?? []),
    importSource: imports,
  });
  return {
    host,
    store,
    authorize,
    imports,
    run: (input: { server: string }) => handler(input, TEST_CTX),
  };
}

async function refusal(promise: Promise<unknown>): Promise<HandlerError> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof HandlerError) return err;
    throw err;
  }
  throw new Error("list_studio_findings did not refuse.");
}

const ORDER: Record<"error" | "warning" | "info", number> = { error: 0, warning: 1, info: 2 };

/** Each finding's rule, level, tool, and field. */
function found(findings: { rule: string; level: string; tool: string | null; field: string | null }[]) {
  return findings.map(({ rule, level, tool, field }) => [rule, level, tool, field]);
}

// ── The production folder ────────────────────────────────────────────────────

describe("list_studio_findings on a server with no draft", () => {
  it("checks the production folder and returns no findings when it is clean", async () => {
    const r = rig(null, { refs: { main: billingMain() }, credentials: [BILLING_CREDENTIAL] });
    const out = await r.run({ server: "billing" });

    expect(out).toMatchObject({ server: "billing", basis: "published", revision: null, findings: [] });
    expect(out.tokens.budget).toBe(8000);
    expect(out.tokens.definitions).toBeGreaterThan(0);
    // Every read uses the one production commit the handler resolved.
    expect(r.host.branchHead).toHaveBeenCalledWith(REPO, "main");
    for (const call of r.host.readFile.mock.calls) expect(call[2]).toBe(headOf("main"));
    for (const call of r.host.listFiles.mock.calls) expect(call[1]).toBe(headOf("main"));
    expect(r.imports).not.toHaveBeenCalled();
  });

  it("returns lint's findings with each one's level, tool, field, message, and fix", async () => {
    const r = rig(null, { refs: { main: billingMain() }, credentials: [] });
    const out = await r.run({ server: "billing" });

    expect(out.findings).toStrictEqual([
      {
        rule: "unknown_credential",
        level: "error",
        tool: null,
        field: "auth.credential",
        message: `auth.credential names ${BILLING_CREDENTIAL}, and the organization has no credential by that name, so every call would fail.`,
        fix: `Add ${BILLING_CREDENTIAL} in Oxagen, or set auth.credential to a credential the organization has.`,
      },
    ]);
  });
});

// ── The saved draft ──────────────────────────────────────────────────────────

describe("list_studio_findings on a saved draft", () => {
  it("reports the definition budget the draft's server.toml sets", async () => {
    const serverToml = fixture("servers/billing/server.toml").replace(
      "definition_budget = 8000",
      "definition_budget = 1",
    );
    expect(serverToml).toContain("definition_budget = 1\n");
    const r = rig(draft({ server: "billing", serverToml, revision: 3 }), {
      refs: { main: billingMain() },
      credentials: [BILLING_CREDENTIAL],
    });
    const out = await r.run({ server: "billing" });

    expect(out.basis).toBe("draft");
    expect(out.revision).toBe(3);
    expect(out.tokens.budget).toBe(1);
    expect(found(out.findings)).toStrictEqual([["over_definition_budget", "warning", null, "exposure.mode"]]);
    expect(out.findings[0]?.message).toMatch(
      /^The 2 imported tools cost about [\d,]+ tokens on every request, over the definition_budget of 1\.$/,
    );
    expect(out.findings[0]?.fix).toContain('exposure.mode = "search"');
  });

  it("reports an unclassified import as an error where Review refuses", async () => {
    const r = rig(
      draft({
        server: "billing",
        serverToml: fixture("servers/billing/server.toml"),
        source: billingSource(),
        ops: [
          { kind: "import", tool: "list_charges" },
          { kind: "import", tool: "get_charge" },
          { kind: "classify", tool: "list_charges", ...READ_TENANT },
        ],
      }),
      { credentials: [BILLING_CREDENTIAL] },
    );
    const out = await r.run({ server: "billing" });

    expect(r.imports).toHaveBeenCalledTimes(1);
    expect(out.basis).toBe("draft");
    expect(out.tokens.definitions).toBeGreaterThan(0);
    const unclassified = out.findings.filter((finding) => finding.rule === "missing_classification");
    expect(unclassified).toStrictEqual([
      {
        rule: "missing_classification",
        level: "error",
        tool: "get_charge",
        field: null,
        message:
          "get_charge has no risk, side effect, or egress yet. Oxagen decides each call from them, so Review refuses the draft until the tool is classified.",
        fix: "Classify get_charge: set its risk, side effect, and egress.",
      },
    ]);
    // Errors come first.
    expect(out.findings[0]?.level).toBe("error");
    const levels = out.findings.map((finding) => finding.level);
    expect(levels).toStrictEqual([...levels].sort((a, b) => ORDER[a] - ORDER[b]));
  });
});

// ── Refusals ─────────────────────────────────────────────────────────────────

describe("list_studio_findings refuses", () => {
  it("a server with no draft and no folder on the production branch", async () => {
    const r = rig(null, { refs: { main: {} } });
    const err = await refusal(r.run({ server: "billing" }));
    expect(err.code).toBe("not_found");
    expect(err.reason).toBe("folder_not_found");
    expect(err.message).toBe(
      "billing has no draft, and acme/steering has no tools/servers/billing/server.toml on main. Set up the server's connection in Studio first.",
    );
  });

  it("a repository without its production branch", async () => {
    const r = rig(null, { refs: {} });
    const err = await refusal(r.run({ server: "billing" }));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("production_branch_missing");
    expect(r.host.readFile).not.toHaveBeenCalled();
  });

  it("a draft with no server.toml when production has none either", async () => {
    const r = rig(draft({ server: "billing" }), { refs: { main: {} } });
    const err = await refusal(r.run({ server: "billing" }));
    expect(err.code).toBe("conflict");
    expect(err.reason).toBe("server_toml_missing");
  });

  it("a person without the role, before it reads anything", async () => {
    const r = rig(null, {
      refs: { main: billingMain() },
      authorize: async () => {
        throw new HandlerError({ code: "forbidden", reason: "role_required", message: "No." });
      },
    });
    const err = await refusal(r.run({ server: "billing" }));
    expect(err.code).toBe("forbidden");
    expect(r.store.get).not.toHaveBeenCalled();
    expect(r.host.resolveRepository).not.toHaveBeenCalled();
  });
});

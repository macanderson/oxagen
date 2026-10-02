// The Markdown import's two calls through the real kernel seam. The viewer
// resolution and the kernel's invoke() are the only fakes, so each case shows
// what the dialog gets back and whether the capability ran: ok, invalid
// (refused before the kernel), denied and conflict with the handler's reason,
// and exhausted for an organization with no credit left for the parse's
// model calls (INV-19). The match across parse calls runs on the server with
// no capability, so it resolves the viewer and never reaches invoke().
import { beforeEach, describe, expect, it, vi } from "vitest";
import { importRecord, parseOutput } from "./import.builders";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { commitMarkdownImport, matchMarkdownImport, parseMarkdownImport } =
  await import("./actions");

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

/** The CapabilityContext every call reaches the kernel with. */
const TENANT = {
  orgId: ctx.orgId,
  workspaceId: ctx.workspaceId,
  surface: "app",
};

const DOCUMENT = {
  filename: "CLAUDE.md",
  content: "# Rules\n\nNever push to main. Open a pull request.",
  target: "records" as const,
};

/** A billing gate's refusal, by the code the kernel seam keys on. */
class Coded extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockResolvedValue(ctx);
});

describe("parseMarkdownImport", () => {
  it("splits the files for the workspace viewer and returns the grid", async () => {
    const output = parseOutput();
    invoke.mockResolvedValue(output);
    expect(
      await parseMarkdownImport("acme", "core-platform", [DOCUMENT]),
    ).toEqual({ ok: true, value: output });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).toHaveBeenCalledWith(
      "parse_markdown_import",
      { documents: [DOCUMENT] },
      expect.objectContaining(TENANT),
    );
  });

  it("refuses more than 25 files before the kernel runs (negative)", async () => {
    const result = await parseMarkdownImport(
      "acme",
      "core-platform",
      Array.from({ length: 26 }, () => DOCUMENT),
    );
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("names the file the contract refuses, by its place in the call (negative)", async () => {
    const result = await parseMarkdownImport("acme", "core-platform", [
      DOCUMENT,
      { ...DOCUMENT, filename: "empty.md", content: "" },
    ]);
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "documents.1.content",
    });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers denied with the handler's reason for a role that cannot import", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({ code: "forbidden", reason: "org_role_required" }),
    );
    expect(
      await parseMarkdownImport("acme", "core-platform", [DOCUMENT]),
    ).toEqual({ ok: false, reason: "denied", code: "org_role_required" });
  });

  it("answers exhausted when the organization has no credit for the model calls", async () => {
    invoke.mockRejectedValue(new Coded("insufficient_credits"));
    expect(
      await parseMarkdownImport("acme", "core-platform", [DOCUMENT]),
    ).toEqual({ ok: false, reason: "exhausted", code: "insufficient_credits" });
  });
});

describe("commitMarkdownImport", () => {
  const rows = { records: [importRecord()], policies: [] };

  it("opens the steering PR and returns where it lives", async () => {
    invoke.mockResolvedValue({
      pullRequest: {
        number: 41,
        url: "https://github.com/acme/oxagen-core-platform/pull/41",
        branch: "steering/import-2026-10-01",
        headSha: "4f9c2e1",
      },
      paths: ["steering/constraints/acme.claude.no-push-to-main.md"],
      records: 1,
      policies: 0,
      skipped: 0,
    });
    expect(await commitMarkdownImport("acme", "core-platform", rows)).toEqual({
      ok: true,
      value: {
        number: 41,
        url: "https://github.com/acme/oxagen-core-platform/pull/41",
        branch: "steering/import-2026-10-01",
        records: 1,
        policies: 0,
        skipped: 0,
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      "commit_markdown_import",
      expect.objectContaining({ records: rows.records }),
      expect.objectContaining(TENANT),
    );
  });

  it("refuses a row whose force its kind forbids before the kernel runs (negative)", async () => {
    const result = await commitMarkdownImport("acme", "core-platform", {
      records: [
        importRecord({
          kind: "fact",
          force: "must",
          effect: null,
        }),
      ],
      policies: [],
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("answers conflict with the handler's reason for a conflict nobody chose for", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "conflict_unresolved",
      }),
    );
    expect(await commitMarkdownImport("acme", "core-platform", rows)).toEqual({
      ok: false,
      reason: "conflict",
      code: "conflict_unresolved",
    });
  });
});

describe("matchMarkdownImport", () => {
  const row = (lineage: string) => ({
    lineage,
    kind: "code-rule",
    effect: null,
    statement: "Use pnpm for every script in the repository.",
    duplicate: null,
    conflict: null,
  });

  it("marks a duplicate split across two parse calls for the workspace viewer", async () => {
    expect(
      await matchMarkdownImport("acme", "core-platform", [
        row("acme.api.use-pnpm"),
        row("acme.web.use-pnpm"),
      ]),
    ).toEqual({
      ok: true,
      value: [
        { duplicate: null, conflict: null },
        {
          duplicate: {
            lineage: "acme.api.use-pnpm",
            path: null,
            published: false,
          },
          conflict: null,
        },
      ],
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("refuses a row of the wrong shape and names it (negative)", async () => {
    const result = await matchMarkdownImport("acme", "core-platform", [
      row("acme.api.use-pnpm"),
      row(""),
    ]);
    expect(result).toMatchObject({
      ok: false,
      reason: "invalid",
      field: "1.lineage",
    });
  });
});

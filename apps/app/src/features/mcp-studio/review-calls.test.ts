// The Changes tab's Review calls (#4678, item 6): the seams bound to lane
// M11's capabilities through Studio's server actions. The actions are the
// only fakes. Each case shows what the tab reads back: the draft or steering
// PR on success, a conflict only for a stale revision, and every other
// refusal as one code the tab can name.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftOp } from "./draft";
import { newServerCalls, reviewCalls } from "./review-calls";
import { savedDraft, STUDIO_AT, studioReview } from "./studio.builders";

const actions = vi.hoisted(() => ({
  saveStudioDraftAction: vi.fn(),
  saveNewStudioServerAction: vi.fn(),
  getStudioDraftAction: vi.fn(),
  openStudioReviewAction: vi.fn(),
}));
vi.mock("./actions", () => actions);

const IMPORT_VOID: DraftOp = { kind: "import", tool: "void_invoice" };

/** A saved test whose raw answer is `bytes` characters long. */
function heavyTest(bytes: number): DraftOp {
  return {
    kind: "test",
    tool: "list_invoices",
    environment: "default",
    args: "{}",
    request: "{}",
    raw: "x".repeat(bytes),
    shaped: "{}",
  };
}

const calls = () => reviewCalls(STUDIO_AT);

beforeEach(() => {
  actions.saveStudioDraftAction.mockReset();
  actions.saveNewStudioServerAction.mockReset();
  actions.getStudioDraftAction.mockReset();
  actions.openStudioReviewAction.mockReset();
});

describe("reviewCalls save", () => {
  it("sends the edits to the workspace the URL names and answers the stored draft", async () => {
    const draft = savedDraft({ ops: [IMPORT_VOID], revision: 3 });
    actions.saveStudioDraftAction.mockResolvedValue({ ok: true, value: draft });
    expect(
      await calls().save({
        server: "billing",
        serverId: "mcs_01k5s1",
        ops: [IMPORT_VOID],
        revision: 2,
      }),
    ).toEqual({ ok: true, draft });
    expect(actions.saveStudioDraftAction).toHaveBeenCalledTimes(1);
    expect(actions.saveStudioDraftAction.mock.calls[0]).toStrictEqual([
      STUDIO_AT.org,
      STUDIO_AT.ws,
      {
        server: "billing",
        serverId: "mcs_01k5s1",
        ops: [IMPORT_VOID],
        revision: 2,
      },
    ]);
  });

  it("leaves the server id out when the server has none", async () => {
    actions.saveStudioDraftAction.mockResolvedValue({
      ok: true,
      value: savedDraft({ server: "scratch", serverId: null }),
    });
    await calls().save({ server: "scratch", ops: [IMPORT_VOID], revision: 0 });
    expect(actions.saveStudioDraftAction.mock.calls[0]?.[2]).toStrictEqual({
      server: "scratch",
      ops: [IMPORT_VOID],
      revision: 0,
    });
  });

  it("refuses a draft too large for one request before it is sent", async () => {
    // Four tests of 256 KiB each pass the 960 KiB a save may send.
    const ops = Array.from({ length: 4 }, () => heavyTest(256 * 1024));
    expect(
      await calls().save({ server: "billing", ops, revision: 2 }),
    ).toEqual({ ok: false, reason: "failed", code: "too_large" });
    expect(actions.saveStudioDraftAction).not.toHaveBeenCalled();
  });

  it("sends a draft under the limit", async () => {
    actions.saveStudioDraftAction.mockResolvedValue({
      ok: true,
      value: savedDraft(),
    });
    // Three tests of 256 KiB each come to about 768 KiB.
    const ops = Array.from({ length: 3 }, () => heavyTest(256 * 1024));
    expect((await calls().save({ server: "billing", ops, revision: 2 })).ok).toBe(
      true,
    );
    expect(actions.saveStudioDraftAction).toHaveBeenCalledTimes(1);
  });

  it("reads a stale revision as a conflict", async () => {
    actions.saveStudioDraftAction.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "draft_revision_stale",
    });
    expect(
      await calls().save({ server: "billing", ops: [IMPORT_VOID], revision: 2 }),
    ).toEqual({ ok: false, reason: "conflict", code: "draft_revision_stale" });
  });

  it("reads any other conflict as a failure with the handler's reason", async () => {
    actions.saveStudioDraftAction.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "test_holds_credential",
    });
    expect(
      await calls().save({ server: "billing", ops: [IMPORT_VOID], revision: 2 }),
    ).toEqual({ ok: false, reason: "failed", code: "test_holds_credential" });
  });

  it.each([
    [{ ok: false, reason: "denied", code: "org_role_required" }, "denied"],
    [
      { ok: false, reason: "invalid", code: "invalid_input", field: "ops" },
      "invalid",
    ],
    [
      { ok: false, reason: "unavailable", code: "kernel_failure" },
      "unavailable",
    ],
    [
      { ok: false, reason: "pending_approval", accessRequestId: "acr_1" },
      "pending_approval",
    ],
    [{ ok: false, reason: "exhausted", code: "gau_exhausted" }, "exhausted"],
  ])("reads a %o refusal by its kind", async (refusal, code) => {
    actions.saveStudioDraftAction.mockResolvedValue(refusal);
    expect(
      await calls().save({ server: "billing", ops: [IMPORT_VOID], revision: 2 }),
    ).toEqual({ ok: false, reason: "failed", code });
  });
});

describe("reviewCalls get", () => {
  it("answers the stored draft, or null when none is stored", async () => {
    const draft = savedDraft({ revision: 4 });
    actions.getStudioDraftAction
      .mockResolvedValueOnce({ ok: true, value: { draft } })
      .mockResolvedValueOnce({ ok: true, value: { draft: null } });
    expect(await calls().get({ server: "billing" })).toEqual({
      ok: true,
      draft,
    });
    expect(await calls().get({ server: "billing" })).toEqual({
      ok: true,
      draft: null,
    });
    expect(actions.getStudioDraftAction).toHaveBeenCalledWith(
      STUDIO_AT.org,
      STUDIO_AT.ws,
      "billing",
    );
  });

  it("reads a missing server as a failure with the handler's reason", async () => {
    actions.getStudioDraftAction.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "server_not_found",
    });
    expect(await calls().get({ server: "billing" })).toEqual({
      ok: false,
      reason: "failed",
      code: "server_not_found",
    });
  });

  it("never reads a refused get as a conflict, so a reload cannot loop", async () => {
    actions.getStudioDraftAction.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "draft_revision_stale",
    });
    expect(await calls().get({ server: "billing" })).toEqual({
      ok: false,
      reason: "failed",
      code: "draft_revision_stale",
    });
  });
});

describe("reviewCalls open", () => {
  it("opens the steering PR from the saved revision", async () => {
    const review = studioReview();
    actions.openStudioReviewAction.mockResolvedValue({
      ok: true,
      value: review,
    });
    expect(await calls().open({ server: "billing", revision: 3 })).toEqual({
      ok: true,
      review,
    });
    expect(actions.openStudioReviewAction).toHaveBeenCalledWith(
      STUDIO_AT.org,
      STUDIO_AT.ws,
      { server: "billing", revision: 3 },
    );
  });

  it("reads a stale revision as a conflict", async () => {
    actions.openStudioReviewAction.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "draft_revision_stale",
    });
    expect(await calls().open({ server: "billing", revision: 3 })).toEqual({
      ok: false,
      reason: "conflict",
      code: "draft_revision_stale",
    });
  });

  it("reads an unclassified import as a failure with the handler's reason", async () => {
    actions.openStudioReviewAction.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "tools_unclassified",
    });
    expect(await calls().open({ server: "billing", revision: 3 })).toEqual({
      ok: false,
      reason: "failed",
      code: "tools_unclassified",
    });
  });
});

/** A new OpenAPI server as Add server's From a definition saves it. */
const LEDGER = {
  server: "ledger",
  serverToml: 'schema = "mcp-server/v1"\nname = "ledger"\n',
  source: {
    type: "openapi" as const,
    files: [{ path: "openapi.yaml", text: "openapi: 3.1.0\n" }],
    entry: "openapi.yaml",
  },
};

describe("newServerCalls create", () => {
  const create = () => newServerCalls(STUDIO_AT).create;

  it("saves the first draft at revision 0 and answers where Review opens", async () => {
    actions.saveNewStudioServerAction.mockResolvedValue({
      ok: true,
      value: savedDraft({ server: "ledger", serverId: null, revision: 1 }),
    });
    expect(await create()(LEDGER, null)).toEqual({
      ok: true,
      serverId: null,
      revision: 1,
    });
    expect(actions.saveNewStudioServerAction.mock.calls[0]).toStrictEqual([
      STUDIO_AT.org,
      STUDIO_AT.ws,
      { ...LEDGER, revision: 0 },
    ]);
  });

  it("saves a retry at the saved revision and server id, never at 0", async () => {
    actions.saveNewStudioServerAction.mockResolvedValue({
      ok: true,
      value: savedDraft({ server: "ledger", serverId: "mcs_01k5s9", revision: 3 }),
    });
    expect(
      await create()(LEDGER, { serverId: "mcs_01k5s9", revision: 2 }),
    ).toEqual({ ok: true, serverId: "mcs_01k5s9", revision: 3 });
    expect(actions.saveNewStudioServerAction.mock.calls[0]?.[2]).toStrictEqual({
      ...LEDGER,
      serverId: "mcs_01k5s9",
      revision: 2,
    });
  });

  it("reads a stale first save as a draft that already exists", async () => {
    actions.saveNewStudioServerAction.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "draft_revision_stale",
    });
    expect(await create()(LEDGER, null)).toEqual({
      ok: false,
      reason: "exists",
    });
  });

  it("reads a stale retry as a draft someone else saved since", async () => {
    actions.saveNewStudioServerAction.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "draft_revision_stale",
    });
    expect(await create()(LEDGER, { serverId: null, revision: 1 })).toEqual({
      ok: false,
      reason: "moved",
    });
  });

  it("reads any other refusal as a failure with its code", async () => {
    actions.saveNewStudioServerAction.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    expect(await create()(LEDGER, null)).toEqual({
      ok: false,
      reason: "failed",
      code: "denied",
    });
  });

  it("refuses a definition too large for one request before it is sent", async () => {
    const big = {
      ...LEDGER,
      source: {
        ...LEDGER.source,
        files: [{ path: "openapi.yaml", text: "x".repeat(1024 * 1024) }],
      },
    };
    expect(await create()(big, null)).toEqual({
      ok: false,
      reason: "failed",
      code: "too_large",
    });
    expect(actions.saveNewStudioServerAction).not.toHaveBeenCalled();
  });
});

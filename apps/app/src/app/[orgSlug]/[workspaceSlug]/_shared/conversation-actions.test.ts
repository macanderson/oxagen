/**
 * conversation-actions.test.ts — unit tests for conversation server actions.
 *
 * Mocking strategy mirrors fill-action.test.ts:
 *   - getSessionOrRedirect, resolveOrg, resolveWorkspace, assertOrgMember → vi.mock
 *   - invoke from @oxagen/oxagen → vi.mock
 *   - revalidatePath from next/cache → vi.mock
 *   - @oxagen/handlers/register → side-effect import stub
 *
 * Coverage:
 *   1. archiveConversationsAction — empty conversationIds → safeParse fails → {ok:false}, invoke NOT called
 *   2. deleteConversationsAction — valid ids → invoke called with conversationDelete.name (config-derived)
 *   3. purgeArchivedConversationsAction → invoke called with {} + revalidatePath for /ask AND /chat
 *   4. resolveOrg throws notFound → action returns {ok:false}
 *   5. invoke throws → {ok:false} with message
 *   6. renameConversationAction — empty title → safeParse fails → {ok:false}
 *   7. listConversationsAction — valid filter → invoke called, results mapped
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — declared before any imports of the module under test.
// ---------------------------------------------------------------------------

vi.mock("@/lib/session", () => ({
  getSessionOrRedirect: vi.fn(),
}));

vi.mock("@/lib/resolve-org", () => ({
  resolveOrg: vi.fn(),
  getOrgRole: vi.fn().mockResolvedValue("owner"),
  resolveWorkspace: vi.fn(),
  assertOrgMember: vi.fn(),
}));

vi.mock("@oxagen/oxagen", () => ({
  invoke: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

// Side-effect import — just needs to not throw.
vi.mock("@oxagen/handlers/register", () => ({}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  archiveConversationsAction,
  deleteConversationsAction,
  purgeArchivedConversationsAction,
  renameConversationAction,
  listConversationsAction,
  type ConversationActionCtx,
} from "./conversation-actions";

import { getSessionOrRedirect } from "@/lib/session";
import {
  resolveOrg,
  resolveWorkspace,
  assertOrgMember,
} from "@/lib/resolve-org";
import { invoke } from "@oxagen/oxagen";
import { revalidatePath } from "next/cache";

// Import contracts to derive names (config-derived, never hardcoded strings).
import { conversationArchive } from "@oxagen/oxagen/contracts/conversation.archive";
import { conversationDelete } from "@oxagen/oxagen/contracts/conversation.delete";
import { conversationPurge } from "@oxagen/oxagen/contracts/conversation.purge";
import { conversationRename } from "@oxagen/oxagen/contracts/conversation.rename";
import { conversationList } from "@oxagen/oxagen/contracts/conversation.list";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ctx: ConversationActionCtx = { orgSlug: "acme", workspaceSlug: "prod" };
const mockSession = { user: { id: "user-1" } };
const mockOrg = { id: "org-1", publicId: "pub-1", name: "Acme", slug: "acme" };
const mockWs = {
  id: "ws-1",
  publicId: "pub-ws-1",
  orgId: "org-1",
  name: "Prod",
  slug: "prod",
};

function setupHappyPath() {
  vi.mocked(getSessionOrRedirect).mockResolvedValue(mockSession as never);
  vi.mocked(resolveOrg).mockResolvedValue(mockOrg as never);
  vi.mocked(resolveWorkspace).mockResolvedValue(mockWs as never);
  vi.mocked(assertOrgMember).mockResolvedValue(undefined);
}

// ---------------------------------------------------------------------------
// beforeEach
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  setupHappyPath();
});

// ---------------------------------------------------------------------------
// 1. archiveConversationsAction — empty conversationIds → safeParse fails
// ---------------------------------------------------------------------------

describe("archiveConversationsAction", () => {
  it("empty conversationIds → safeParse fails → {ok:false} WITHOUT calling invoke", async () => {
    const result = await archiveConversationsAction(ctx, [], true);
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("valid ids → invoke called with conversationArchive.name (config-derived)", async () => {
    vi.mocked(invoke).mockResolvedValue({ updated: 2 });
    const result = await archiveConversationsAction(
      ctx,
      ["id-1", "id-2"],
      true,
    );
    expect(invoke).toHaveBeenCalledOnce();
    const [capabilityName] = vi.mocked(invoke).mock.calls[0]!;
    // Config-derived: use the imported contract name, not a hardcoded string.
    expect(capabilityName).toBe(conversationArchive.name);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(2);
  });

  it("archived=false (restore) → still calls invoke with archived=false in payload", async () => {
    vi.mocked(invoke).mockResolvedValue({ updated: 1 });
    await archiveConversationsAction(ctx, ["id-1"], false);
    expect(invoke).toHaveBeenCalledOnce();
    const [, input] = vi.mocked(invoke).mock.calls[0]!;
    expect((input as { archived: boolean }).archived).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. deleteConversationsAction — valid ids → invoke called with contract name
// ---------------------------------------------------------------------------

describe("deleteConversationsAction", () => {
  it("valid ids → invoke called with conversationDelete.name (config-derived)", async () => {
    vi.mocked(invoke).mockResolvedValue({ deleted: 3 });
    const result = await deleteConversationsAction(ctx, [
      "id-1",
      "id-2",
      "id-3",
    ]);
    expect(invoke).toHaveBeenCalledOnce();
    const [capabilityName] = vi.mocked(invoke).mock.calls[0]!;
    expect(capabilityName).toBe(conversationDelete.name);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(3);
  });

  it("empty ids → safeParse fails → {ok:false}, invoke NOT called", async () => {
    const result = await deleteConversationsAction(ctx, []);
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 3. purgeArchivedConversationsAction — invoke({}) + revalidatePath for /ask AND /chat
// ---------------------------------------------------------------------------

describe("purgeArchivedConversationsAction", () => {
  it("calls invoke with conversationPurge.name and empty input", async () => {
    vi.mocked(invoke).mockResolvedValue({ deleted: 5 });
    await purgeArchivedConversationsAction(ctx);
    expect(invoke).toHaveBeenCalledOnce();
    const [capabilityName, input] = vi.mocked(invoke).mock.calls[0]!;
    expect(capabilityName).toBe(conversationPurge.name);
    expect(input).toEqual({});
  });

  it("revalidatePath called for the /sessions surface", async () => {
    vi.mocked(invoke).mockResolvedValue({ deleted: 0 });
    await purgeArchivedConversationsAction(ctx);
    const paths = vi.mocked(revalidatePath).mock.calls.map(([p]) => p);
    expect(paths).toContain("/acme/prod/sessions");
  });

  it("returns {ok:true, count} on success", async () => {
    vi.mocked(invoke).mockResolvedValue({ deleted: 7 });
    const result = await purgeArchivedConversationsAction(ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.count).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// 4. resolveOrg throws notFound → action returns {ok:false}
// ---------------------------------------------------------------------------

describe("resolveOrg throws → {ok:false}", () => {
  it("archiveConversationsAction returns {ok:false} when resolveOrg throws", async () => {
    vi.mocked(resolveOrg).mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    const result = await archiveConversationsAction(ctx, ["id-1"], true);
    expect(result.ok).toBe(false);
  });

  it("deleteConversationsAction returns {ok:false} when resolveOrg throws", async () => {
    vi.mocked(resolveOrg).mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    const result = await deleteConversationsAction(ctx, ["id-1"]);
    expect(result.ok).toBe(false);
  });

  it("purgeArchivedConversationsAction returns {ok:false} when resolveOrg throws", async () => {
    vi.mocked(resolveOrg).mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    const result = await purgeArchivedConversationsAction(ctx);
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. invoke throws → {ok:false} with message
// ---------------------------------------------------------------------------

describe("invoke throws → {ok:false}", () => {
  it("archiveConversationsAction returns {ok:false, error} when invoke throws", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("handler panic"));
    const result = await archiveConversationsAction(ctx, ["id-1"], true);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("handler panic");
  });

  it("deleteConversationsAction returns {ok:false, error} when invoke throws", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("delete failed"));
    const result = await deleteConversationsAction(ctx, ["id-1"]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("delete failed");
  });

  it("purgeArchivedConversationsAction returns {ok:false} when invoke throws", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("purge explosion"));
    const result = await purgeArchivedConversationsAction(ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("purge explosion");
  });
});

// ---------------------------------------------------------------------------
// 6. renameConversationAction — empty title → safeParse fails → {ok:false}
// ---------------------------------------------------------------------------

describe("renameConversationAction", () => {
  it("empty title → safeParse fails → {ok:false}, invoke NOT called", async () => {
    const result = await renameConversationAction(ctx, "convo-1", "");
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("valid title → invoke called with conversationRename.name", async () => {
    vi.mocked(invoke).mockResolvedValue({ renamed: 1 });
    const result = await renameConversationAction(ctx, "convo-1", "New Title");
    expect(invoke).toHaveBeenCalledOnce();
    const [capabilityName] = vi.mocked(invoke).mock.calls[0]!;
    expect(capabilityName).toBe(conversationRename.name);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 7. listConversationsAction — valid filter → invoke called, results mapped
// ---------------------------------------------------------------------------

describe("listConversationsAction", () => {
  it("valid filter → invoke called with conversationList.name", async () => {
    vi.mocked(invoke).mockResolvedValue({
      conversations: [],
      nextCursor: null,
    });
    const result = await listConversationsAction(ctx, { filter: "active" });
    expect(invoke).toHaveBeenCalledOnce();
    const [capabilityName] = vi.mocked(invoke).mock.calls[0]!;
    expect(capabilityName).toBe(conversationList.name);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conversations).toEqual([]);
      expect(result.nextCursor).toBeNull();
    }
  });

  it("invoke throws → {ok:false}", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("DB offline"));
    const result = await listConversationsAction(ctx, { filter: "archived" });
    expect(result.ok).toBe(false);
  });
});

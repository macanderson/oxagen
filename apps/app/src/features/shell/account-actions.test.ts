// The profile action through the real viewer and kernel seams: the session,
// the pre-scope lookups and the kernel's invoke() are the only fakes, so each
// case shows what the person gets back and whether update_profile ran.
//
// The case that earns this file is the last one: the action passes no user id,
// because the capability takes none. A profile write that accepted a target id
// would let a form field name someone else's row.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, getSession, orgRole, redirect, captureError } = vi.hoisted(
  () => ({
    invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
    getSession: vi.fn(),
    orgRole: vi.fn<() => Promise<string | null>>(),
    redirect: vi.fn((url: string) => {
      throw new Error(`NEXT_REDIRECT ${url}`);
    }),
    captureError: vi.fn(),
  }),
);
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("next/navigation", () => ({
  redirect,
  permanentRedirect: redirect,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: () => Promise.resolve(),
}));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers()),
}));
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({
  systemLookups: {
    orgBySlug: (slug: string) =>
      Promise.resolve(
        slug === "acme"
          ? { id: ORG_ID, publicId: "org_01", slug: "acme", name: "Acme" }
          : null,
      ),
    orgBySlugHistory: () => Promise.resolve(null),
    orgRole,
    mfaPolicy: () => Promise.resolve(null),
    ssoPolicy: () => Promise.resolve(null),
    twoFactorEnabled: () => Promise.resolve(false),
  },
}));

const ORG_ID = "7a000000-0000-4000-8000-0000000000a1";

const {
  updateProfile,
  readPreferences,
  savePreferences,
  requestExport,
  readExportStatus,
} = await import("./account-actions");

const EXPORT_ID = "7a000000-0000-4000-8000-0000000000e1";

beforeEach(() => {
  invoke.mockReset();
  redirect.mockClear();
  captureError.mockClear();
  orgRole.mockResolvedValue("member");
  getSession.mockResolvedValue({
    user: { id: "u-marcus", email: "marcus.bell@acme.example" },
  });
});

describe("updateProfile", () => {
  it("sends a signed-out visitor to log in, writing nothing (negative)", async () => {
    getSession.mockResolvedValue(null);
    await expect(
      updateProfile("acme", { displayName: "Marcus B", avatarUrl: "" }),
    ).rejects.toThrow("NEXT_REDIRECT /login");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("writes the display name and answers with what the handler stored", async () => {
    invoke.mockResolvedValue({
      displayName: "Marcus B",
      avatarUrl: null,
    });
    const result = await updateProfile("acme", {
      displayName: "Marcus B",
      avatarUrl: "",
    });
    expect(result).toEqual({
      ok: true,
      value: { displayName: "Marcus B", avatarUrl: null },
    });
  });

  it("sends a blank avatar as null, so clearing it clears the column", async () => {
    invoke.mockResolvedValue({
      displayName: "Marcus B",
      avatarUrl: null,
    });
    await updateProfile("acme", { displayName: "Marcus B", avatarUrl: "" });
    expect(invoke).toHaveBeenCalledWith(
      "update_profile",
      { displayName: "Marcus B", avatarUrl: null },
      expect.anything(),
    );
  });

  it("passes an avatar URL through untouched", async () => {
    invoke.mockResolvedValue({
      displayName: "Marcus B",
      avatarUrl: "https://cdn.example/a.png",
    });
    await updateProfile("acme", {
      displayName: "Marcus B",
      avatarUrl: "https://cdn.example/a.png",
    });
    expect(invoke).toHaveBeenCalledWith(
      "update_profile",
      { displayName: "Marcus B", avatarUrl: "https://cdn.example/a.png" },
      expect.anything(),
    );
  });

  it("never sends a user id: the capability acts on the authenticated principal", async () => {
    invoke.mockResolvedValue({
      displayName: "Marcus B",
      avatarUrl: null,
    });
    await updateProfile("acme", { displayName: "Marcus B", avatarUrl: "" });
    const input = invoke.mock.calls[0]?.[1];
    expect(Object.keys(input ?? {}).sort()).toEqual([
      "avatarUrl",
      "displayName",
    ]);
  });
});

describe("updateProfile, avatar alone", () => {
  // display_name is nullable and the avatar editor has no name field, so the
  // write has to be a partial one: a key left out is left alone.
  it("omits the display name entirely rather than sending an empty one", async () => {
    invoke.mockResolvedValue({ displayName: null, avatarUrl: "avatar:v1:{}" });
    await updateProfile("acme", { avatarUrl: "avatar:v1:{}" });
    expect(invoke).toHaveBeenCalledWith(
      "update_profile",
      { avatarUrl: "avatar:v1:{}" },
      expect.anything(),
    );
  });

  it("answers with a null display name for a person who has none", async () => {
    invoke.mockResolvedValue({ displayName: null, avatarUrl: "avatar:v1:{}" });
    const result = await updateProfile("acme", { avatarUrl: "avatar:v1:{}" });
    expect(result).toEqual({
      ok: true,
      value: { displayName: null, avatarUrl: "avatar:v1:{}" },
    });
  });

  it("omits the avatar entirely when the caller sends only a name", async () => {
    invoke.mockResolvedValue({ displayName: "Marcus B", avatarUrl: null });
    await updateProfile("acme", { displayName: "Marcus B" });
    expect(invoke).toHaveBeenCalledWith(
      "update_profile",
      { displayName: "Marcus B" },
      expect.anything(),
    );
  });

  // An empty string is still the way to clear the column; only an absent key
  // means "leave it alone".
  it("still clears the avatar when an empty string is sent", async () => {
    invoke.mockResolvedValue({ displayName: "Marcus B", avatarUrl: null });
    await updateProfile("acme", { displayName: "Marcus B", avatarUrl: "" });
    expect(invoke).toHaveBeenCalledWith(
      "update_profile",
      { displayName: "Marcus B", avatarUrl: null },
      expect.anything(),
    );
  });
});

describe("readExportStatus", () => {
  it("sends a signed-out visitor to log in, reading nothing (negative)", async () => {
    getSession.mockResolvedValue(null);
    await expect(readExportStatus("acme", EXPORT_ID)).rejects.toThrow(
      "NEXT_REDIRECT /login",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("asks by export id alone and hands back the key once it is ready", async () => {
    invoke.mockResolvedValue({
      exportId: EXPORT_ID,
      status: "ready",
      ready: true,
      storageKey: "privacy-exports/org/exp.zip",
      completedAt: "2026-09-18T22:00:00.000Z",
    });
    const result = await readExportStatus("acme", EXPORT_ID);
    expect(invoke).toHaveBeenCalledWith(
      "get_export_status",
      { exportId: EXPORT_ID },
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        exportId: EXPORT_ID,
        status: "ready",
        ready: true,
        storageKey: "privacy-exports/org/exp.zip",
      },
    });
  });

  // The contract takes no user id and neither does this action: the handler
  // matches on the principal, so one person cannot ask after another's bundle.
  it("never sends a user id", async () => {
    invoke.mockResolvedValue({
      exportId: EXPORT_ID,
      status: "queued",
      ready: false,
      storageKey: null,
      completedAt: null,
    });
    await readExportStatus("acme", EXPORT_ID);
    const input = invoke.mock.calls[0]?.[1];
    expect(Object.keys(input ?? {})).toEqual(["exportId"]);
  });
});

describe("readPreferences", () => {
  it("sends a signed-out visitor to log in, reading nothing (negative)", async () => {
    getSession.mockResolvedValue(null);
    await expect(readPreferences("acme")).rejects.toThrow(
      "NEXT_REDIRECT /login",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reads get_user_preferences and answers with the three fields the tab sets", async () => {
    invoke.mockResolvedValue({
      fontSize: "medium",
      density: "comfortable",
      enterToSubmit: true,
      pendingPromptBehavior: "queue",
      defaultTextTier: null,
      defaultTextModel: null,
      timezone: "America/Los_Angeles",
      language: "en",
      theme: "dark",
    });
    const result = await readPreferences("acme");
    expect(invoke).toHaveBeenCalledWith(
      "get_user_preferences",
      {},
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      value: { locale: "en", timezone: "America/Los_Angeles", theme: "dark" },
    });
  });
});

describe("savePreferences", () => {
  it("writes set_preferences as a partial of the three fields, nothing else", async () => {
    invoke.mockResolvedValue({
      locale: "en",
      theme: "dark",
      timezone: "UTC",
      fontSize: "medium",
      density: "comfortable",
      enterToSubmit: true,
      pendingPromptBehavior: "queue",
      defaultTextTier: null,
      defaultTextModel: null,
    });
    const result = await savePreferences("acme", {
      locale: "en",
      timezone: "UTC",
      theme: "dark",
    });
    expect(invoke).toHaveBeenCalledWith(
      "set_preferences",
      { locale: "en", timezone: "UTC", theme: "dark" },
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      value: { locale: "en", timezone: "UTC", theme: "dark" },
    });
  });

  it("refuses a time zone the contract does not recognise before the kernel runs (negative)", async () => {
    const result = await savePreferences("acme", {
      locale: "en",
      timezone: "not a zone!",
      theme: "dark",
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("requestExport", () => {
  it("queues the person's own export with no organization id", async () => {
    invoke.mockResolvedValue({
      exportId: "7a000000-0000-4000-8000-0000000000e1",
      status: "queued",
    });
    const result = await requestExport("acme", "user");
    expect(invoke).toHaveBeenCalledWith(
      "export_data",
      { scope: "user" },
      expect.anything(),
    );
    expect(result).toEqual({
      ok: true,
      value: {
        exportId: "7a000000-0000-4000-8000-0000000000e1",
        status: "queued",
      },
    });
  });

  it("names the viewer's organization, never one from the form, for an org export", async () => {
    invoke.mockResolvedValue({
      exportId: "7a000000-0000-4000-8000-0000000000e2",
      status: "queued",
    });
    await requestExport("acme", "org");
    expect(invoke).toHaveBeenCalledWith(
      "export_data",
      { scope: "org", orgId: ORG_ID },
      expect.anything(),
    );
  });
});

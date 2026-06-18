import { describe, expect, it, beforeEach, vi } from "vitest";

// ── DB + notification mocks ───────────────────────────────────────────────────
// markCredentialNeedsReauth talks to Postgres (via withSystemDb) and the
// notifications package. We mock both so the unit test pins behavior without a
// live DB or mail transport. Mutable fixtures let each test stage the listing
// row and observe the captured update / notify calls.

interface ListingRow {
  orgId: string;
  name: string;
  title: string | null;
}

const fixtures: {
  listing: ListingRow | null;
  updates: Array<Record<string, unknown>>;
  notifies: Array<Record<string, unknown>>;
  notifyRejects: boolean;
} = { listing: null, updates: [], notifies: [], notifyRejects: false };

vi.mock("@oxagen/database", () => {
  const tx = {
    update: () => ({
      set: (vals: Record<string, unknown>) => ({
        where: async () => {
          fixtures.updates.push(vals);
          return undefined;
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => (fixtures.listing ? [fixtures.listing] : []),
        }),
      }),
    }),
  };
  return {
    withSystemDb: async (cb: (t: typeof tx) => Promise<unknown>) => cb(tx),
    schema: {
      mcpCredentials: { workspaceId: "workspaceId", orgListingId: "orgListingId" },
      pluginInstalledPlugins: { id: "id", orgId: "orgId", name: "name", title: "title" },
    },
  };
});

vi.mock("@oxagen/notifications", () => ({
  reauthEmailTemplate: (input: { serverName: string; reauthUrl: string; orgName: string }) => ({
    subject: `Reconnect ${input.serverName}`,
    text: `Reconnect ${input.serverName}: ${input.reauthUrl}`,
    html: `<a href="${input.reauthUrl}">Reconnect ${input.serverName}</a>`,
  }),
  notifyOrgManagers: async (input: Record<string, unknown>) => {
    fixtures.notifies.push(input);
    if (fixtures.notifyRejects) throw new Error("mail transport down");
  },
}));

beforeEach(() => {
  fixtures.listing = null;
  fixtures.updates = [];
  fixtures.notifies = [];
  fixtures.notifyRejects = false;
  vi.resetModules();
});

describe("markCredentialNeedsReauth", () => {
  it("flips the credential row to needs_reauth", async () => {
    fixtures.listing = { orgId: "org-1", name: "github", title: "GitHub" };
    const { markCredentialNeedsReauth } = await import("./mark-reauth");
    await markCredentialNeedsReauth("ws-1", "ol-1");

    expect(fixtures.updates).toHaveLength(1);
    expect(fixtures.updates[0]).toMatchObject({ status: "needs_reauth" });
    expect(fixtures.updates[0]?.["updatedAt"]).toBeInstanceOf(Date);
  });

  it("notifies org managers with a deep-link carrying the orgListingId", async () => {
    fixtures.listing = { orgId: "org-1", name: "github", title: "GitHub" };
    const { markCredentialNeedsReauth } = await import("./mark-reauth");
    await markCredentialNeedsReauth("ws-1", "ol-1");

    expect(fixtures.notifies).toHaveLength(1);
    const sent = fixtures.notifies[0]!;
    expect(sent["orgId"]).toBe("org-1");
    expect(sent["workspaceId"]).toBe("ws-1");
    expect(sent["kind"]).toBe("security");
    expect(sent["deepLink"]).toContain("/reauth/ol-1");
    // serverName prefers the human title over the slug.
    expect(sent["title"]).toBe("Reconnect GitHub");
  });

  it("falls back to the listing name when title is null", async () => {
    fixtures.listing = { orgId: "org-1", name: "slack", title: null };
    const { markCredentialNeedsReauth } = await import("./mark-reauth");
    await markCredentialNeedsReauth("ws-1", "ol-2");

    expect(fixtures.notifies[0]?.["title"]).toBe("Reconnect slack");
  });

  it("still flips status but skips notification when the listing was deleted", async () => {
    fixtures.listing = null; // listing row not found
    const { markCredentialNeedsReauth } = await import("./mark-reauth");
    await markCredentialNeedsReauth("ws-1", "ol-gone");

    expect(fixtures.updates).toHaveLength(1); // flip is authoritative
    expect(fixtures.notifies).toHaveLength(0); // best-effort notify skipped
  });

  it("does not propagate notification failure (best-effort)", async () => {
    fixtures.listing = { orgId: "org-1", name: "github", title: "GitHub" };
    fixtures.notifyRejects = true;
    const { markCredentialNeedsReauth } = await import("./mark-reauth");

    // The credential flip is authoritative; a notify failure must not surface.
    await expect(markCredentialNeedsReauth("ws-1", "ol-1")).resolves.toBeUndefined();
    expect(fixtures.updates).toHaveLength(1);
  });
});

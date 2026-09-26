// The shell port: two kernel reads for the layout's organization context,
// mapped into the shell's view model, with either read's refusal passed
// through and an unmappable record reported once.
import { assistantEngineGet } from "@oxagen/oxagen/contracts/assistant.engine.get";
import { notificationsList } from "@oxagen/oxagen/contracts/notification.list";
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { shellNavCountsGet } from "@oxagen/oxagen/contracts/shell.nav_counts.get";
import { userPreferencesRead } from "@oxagen/oxagen/contracts/user.preferences.read";
import { workspaceList } from "@oxagen/oxagen/contracts/workspace.list";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { kernelRead, captureError, endRequest } = vi.hoisted(() => ({
  kernelRead: vi.fn(),
  captureError: vi.fn(),
  endRequest: new Set<() => void>(),
}));
// Cache primitive argument tuples for one simulated server render.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
    const values = new Map<string, { value: R }>();
    endRequest.add(() => {
      values.clear();
    });
    return (...args: A): R => {
      const key = JSON.stringify(args);
      const existing = values.get(key);
      if (existing) return existing.value;
      const value = fn(...args);
      values.set(key, { value });
      return value;
    };
  },
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx, WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { readError, readOk } = await import("@/data/read");
const { shell } = await import("./shell");

const ctx = unsafeMint(OrgCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
});

const organization = {
  id: "7a000000-0000-4000-8000-0000000000a1",
  publicId: "org_acme",
  slug: "acme",
  namespace: "acme",
  name: "Acme Robotics",
};

function scripted(orgs: unknown, workspaces: unknown) {
  kernelRead.mockImplementation((_ctx: unknown, call: { contract: unknown }) =>
    Promise.resolve(call.contract === orgList ? orgs : workspaces),
  );
}

const orgsRead = readOk({
  organizations: [{ ...organization, role: "member", avatarUrl: null }],
});
const workspacesRead = readOk({
  organization,
  workspaces: [
    {
      id: "7b000000-0000-4000-8000-000000000001",
      publicId: "ws_core",
      slug: "core",
      namespace: "core",
      name: "Core platform",
      role: "member",
    },
  ],
});

beforeEach(() => {
  for (const reset of endRequest) reset();
  kernelRead.mockReset();
  captureError.mockReset();
});

describe("shell.context", () => {
  it("reads list_orgs and the context organization's list_workspaces through the kernel seam", async () => {
    scripted(orgsRead, workspacesRead);
    expect(await shell.context(ctx)).toEqual(
      readOk({
        orgs: [{ slug: "acme", name: "Acme Robotics", avatarUrl: null }],
        workspaces: [{ slug: "core", name: "Core platform", avatarUrl: null }],
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: orgList,
      input: {},
      page: "shell",
    });
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: workspaceList,
      input: { orgSlug: "acme" },
      page: "shell",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("passes a refused organizations read through (negative)", async () => {
    const denied = { ok: false, reason: "denied", permission: "org.read" };
    scripted(denied, workspacesRead);
    expect(await shell.context(ctx)).toEqual(denied);
  });

  it("passes a failed workspaces read through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    scripted(orgsRead, down);
    expect(await shell.context(ctx)).toEqual(down);
  });

  it("answers record_unmappable and reports once for a record the view model refuses (negative)", async () => {
    scripted(
      readOk({
        organizations: [
          { ...organization, slug: "", role: "member", avatarUrl: null },
        ],
      }),
      workspacesRead,
    );
    expect(await shell.context(ctx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });
});

const preferencesRead = (timezone: string, enterToSubmit = false) =>
  readOk({
    fontSize: "medium",
    density: "comfortable",
    enterToSubmit,
    pendingPromptBehavior: "queue",
    defaultTextTier: null,
    defaultTextModel: null,
    timezone,
    language: "en",
    theme: "system",
  });

describe("shell.preferences", () => {
  it("reads get_user_preferences through the kernel seam and answers the stored zone", async () => {
    kernelRead.mockResolvedValue(preferencesRead("Europe/London"));
    expect(await shell.preferences(ctx)).toEqual(
      readOk({ timeZone: "Europe/London", enterToSubmit: false }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: userPreferencesRead,
      input: {},
      page: "shell",
    });
    expect(captureError).not.toHaveBeenCalled();
  });

  it("answers enter_to_submit as stored, for the assistant composer", async () => {
    kernelRead.mockResolvedValue(preferencesRead("Europe/London", true));
    expect(await shell.preferences(ctx)).toEqual(
      readOk({ timeZone: "Europe/London", enterToSubmit: true }),
    );
  });

  it("passes a failed read through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await shell.preferences(ctx)).toEqual(down);
  });

  // The column is free text. A zone Intl cannot format in would throw inside
  // every date on the page, so it is reported once and read as the default.
  it("reads a zone this runtime cannot format in as Pacific, and reports it once (negative)", async () => {
    kernelRead.mockResolvedValue(preferencesRead("Mars/Olympus_Mons"));
    expect(await shell.preferences(ctx)).toEqual(
      readOk({ timeZone: "America/Los_Angeles", enterToSubmit: false }),
    );
    expect(captureError).toHaveBeenCalledOnce();
    expect(captureError).toHaveBeenCalledWith(
      expect.objectContaining({
        context: "shell.preferences time_zone_unsupported",
      }),
    );
  });
  it("reports once when the shell and viewer clock read in the same render", async () => {
    kernelRead.mockResolvedValue(preferencesRead("Mars/Olympus_Mons"));
    const results = await Promise.all([
      shell.preferences(ctx),
      shell.preferences(ctx),
    ]);
    expect(results).toEqual([
      readOk({ timeZone: "America/Los_Angeles", enterToSubmit: false }),
      readOk({ timeZone: "America/Los_Angeles", enterToSubmit: false }),
    ]);
    expect(kernelRead).toHaveBeenCalledTimes(2);
    expect(captureError).toHaveBeenCalledOnce();
    for (const reset of endRequest) reset();
    await shell.preferences(ctx);
    expect(captureError).toHaveBeenCalledTimes(2);
  });

  it("does not suppress another viewer's unsupported zone in the same render", async () => {
    kernelRead.mockResolvedValue(preferencesRead("Mars/Olympus_Mons"));
    const other = unsafeMint(OrgCtx, {
      orgId: ctx.orgId,
      orgSlug: ctx.orgSlug,
      orgName: ctx.orgName,
      orgRole: ctx.orgRole,
      userId: "7c9e6679-7425-40de-944b-e07fc1f90ae8",
    });
    await shell.preferences(ctx);
    await shell.preferences(other);
    expect(captureError).toHaveBeenCalledTimes(2);
  });
});

const wsCtx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core",
  wsName: "Core platform",
  wsRole: "member",
});

describe("shell.counts", () => {
  it("reads get_nav_counts under the shell's page key and keeps a null count null", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        approvals: 3,
        interjections: null,
        proposals: null,
        incidents: null,
      }),
    );
    expect(await shell.counts(wsCtx)).toEqual(
      readOk({
        approvals: 3,
        interjections: null,
        proposals: null,
        incidents: null,
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(wsCtx, {
      contract: shellNavCountsGet,
      input: {},
      page: "shell",
    });
  });

  it("passes a refusal through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await shell.counts(wsCtx)).toEqual(down);
  });
});

describe("shell.notifications", () => {
  const row = {
    id: "8d000000-0000-4000-8000-000000000001",
    publicId: "ntf_01K5",
    kind: "approval" as const,
    event: "approval.requested" as const,
    title: "Approval waiting",
    body: "release-manager wants to cut the 4.11.0 release.",
    deepLink: null,
    unread: true,
    archived: false,
    createdAt: "2026-09-23T09:14:00.000Z",
  };

  it("maps the feed to the public id, drops archived rows and keeps the whole feed's unread count", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        notifications: [row, { ...row, publicId: "ntf_02K5", archived: true }],
        unreadCount: 7,
      }),
    );
    expect(await shell.notifications(wsCtx)).toEqual(
      readOk({
        items: [
          {
            id: "ntf_01K5",
            title: "Approval waiting",
            body: "release-manager wants to cut the 4.11.0 release.",
            event: "approval.requested",
            kind: "approval",
            unread: true,
            createdAt: "2026-09-23T09:14:00.000Z",
          },
        ],
        unread: 7,
      }),
    );
    expect(kernelRead).toHaveBeenCalledWith(wsCtx, {
      contract: notificationsList,
      input: { unreadOnly: false, limit: 50 },
      page: "shell",
    });
  });

  it("answers record_unmappable and reports once for a row the view refuses (negative)", async () => {
    kernelRead.mockResolvedValue(
      readOk({
        notifications: [{ ...row, publicId: "not a public id" }],
        unreadCount: 1,
      }),
    );
    expect(await shell.notifications(wsCtx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });

  it("passes a refusal through (negative)", async () => {
    const denied = {
      ok: false as const,
      reason: "denied" as const,
      permission: "workspace.read",
    };
    kernelRead.mockResolvedValue(denied);
    expect(await shell.notifications(wsCtx)).toEqual(denied);
  });
});

describe("shell.assistantEngine", () => {
  const probe = {
    state: "unreachable",
    endpoint: "engine.oxagen.internal:8080",
    attempts: 3,
    error: "ECONNREFUSED",
    checkedAt: "2026-09-25T09:14:00.000Z",
    incident: null,
  };

  it("reads get_assistant_engine and answers the state and code, never the host it probed", async () => {
    kernelRead.mockResolvedValue(readOk(probe));
    const read = await shell.assistantEngine(wsCtx);
    expect(read).toEqual(
      readOk({ state: "unreachable", error: "ECONNREFUSED" }),
    );
    expect(JSON.stringify(read)).not.toContain("engine.oxagen.internal");
    expect(kernelRead).toHaveBeenCalledWith(wsCtx, {
      contract: assistantEngineGet,
      input: {},
      page: "shell",
    });
  });

  it("keeps a ready engine's null code null", async () => {
    kernelRead.mockResolvedValue(
      readOk({ ...probe, state: "ready", attempts: 1, error: null }),
    );
    expect(await shell.assistantEngine(wsCtx)).toEqual(
      readOk({ state: "ready", error: null }),
    );
  });

  it("answers record_unmappable and reports once for a state the view does not know (negative)", async () => {
    kernelRead.mockResolvedValue(readOk({ ...probe, state: "sleeping" }));
    expect(await shell.assistantEngine(wsCtx)).toEqual(
      readError("record_unmappable", 502),
    );
    expect(captureError).toHaveBeenCalledOnce();
  });

  it("passes a refusal through (negative)", async () => {
    const down = readError("control_plane_unavailable", 503);
    kernelRead.mockResolvedValue(down);
    expect(await shell.assistantEngine(wsCtx)).toEqual(down);
  });
});

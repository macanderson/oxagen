// The shell port: two kernel reads for the layout's organization context,
// mapped into the shell's view model, with either read's refusal passed
// through and an unmappable record reported once.
import { orgList } from "@oxagen/oxagen/contracts/org.list";
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
    const values = new Map<string, R>();
    endRequest.add(() => values.clear());
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!values.has(key)) values.set(key, fn(...args));
      return values.get(key) as R;
    };
  },
}));
vi.mock("@/server/kernel", () => ({ kernelRead }));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { OrgCtx } = await import("@/server/viewer");
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
        orgs: [{ slug: "acme", name: "Acme Robotics" }],
        workspaces: [{ slug: "core", name: "Core platform" }],
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

const preferencesRead = (timezone: string) =>
  readOk({
    fontSize: "medium",
    density: "comfortable",
    enterToSubmit: false,
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
      readOk({ timeZone: "Europe/London" }),
    );
    expect(kernelRead).toHaveBeenCalledWith(ctx, {
      contract: userPreferencesRead,
      input: {},
      page: "shell",
    });
    expect(captureError).not.toHaveBeenCalled();
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
      readOk({ timeZone: "America/Los_Angeles" }),
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
      readOk({ timeZone: "America/Los_Angeles" }),
      readOk({ timeZone: "America/Los_Angeles" }),
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
      ...ctx,
      userId: "7c9e6679-7425-40de-944b-e07fc1f90ae8",
    });
    await shell.preferences(ctx);
    await shell.preferences(other);
    expect(captureError).toHaveBeenCalledTimes(2);
  });
});

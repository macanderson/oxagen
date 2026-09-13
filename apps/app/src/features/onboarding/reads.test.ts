import { beforeEach, describe, expect, it, vi } from "vitest";

const cookieJar = new Map<string, string>();
const findOrg = vi.fn();
const findMembership = vi.fn();
const findWorkspace = vi.fn();

vi.mock("next/headers", () => ({
  cookies: () =>
    Promise.resolve({
      get: (name: string) =>
        cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined,
    }),
}));
vi.mock("@oxagen/database", () => ({
  withSystemDb: (fn: (tx: unknown) => unknown) =>
    fn({
      query: {
        organizations: { findFirst: findOrg },
        orgUsers: { findFirst: findMembership },
        workspaces: { findFirst: findWorkspace },
      },
    }),
}));

const reads = await import("./reads");
const user = { id: "user-1", email: "priya@acme.example", name: "Priya Raman" };

function fixtureMode() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MC_DATA", "fixture");
}
function liveMode() {
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("MC_DATA", "live");
}

beforeEach(() => {
  cookieJar.clear();
  findOrg.mockReset();
  findMembership.mockReset();
  findWorkspace.mockReset();
});

describe("fixturePageState", () => {
  it("reads the mc_state switch in fixture mode", async () => {
    fixtureMode();
    cookieJar.set("mc_state", "denied");
    await expect(reads.fixturePageState()).resolves.toBe("denied");
    cookieJar.set("mc_state", "surprise");
    await expect(reads.fixturePageState()).resolves.toBe("loaded");
  });

  it("ignores the switch outside fixture mode", async () => {
    liveMode();
    cookieJar.set("mc_state", "error");
    await expect(reads.fixturePageState()).resolves.toBe("loaded");
  });
});

describe("loadFlowScope", () => {
  it("serves the fixture org and workspace, and nothing else, in fixture mode", async () => {
    fixtureMode();
    const hit = await reads.loadFlowScope(user, "acme", "core-platform");
    expect(hit.ok && hit.value.org.namespace).toBe("acme");
    expect(await reads.loadFlowScope(user, "globex", "core-platform")).toEqual({
      ok: false,
      reason: "error",
      code: "workspace_not_found",
      status: 404,
    });
  });

  it("resolves a workspace of an org the user is a member of", async () => {
    liveMode();
    findOrg.mockResolvedValue({
      id: "org-1",
      slug: "acme",
      name: "Acme Robotics",
      namespace: "acme",
    });
    findMembership.mockResolvedValue({ orgId: "org-1" });
    findWorkspace.mockResolvedValue({
      slug: "core-platform",
      name: "Core platform",
      namespace: "core",
    });
    const read = await reads.loadFlowScope(user, "acme", "core-platform");
    expect(read).toEqual({
      ok: true,
      value: {
        org: { slug: "acme", name: "Acme Robotics", namespace: "acme" },
        ws: { slug: "core-platform", name: "Core platform", namespace: "core" },
        operator: { name: "Priya Raman", email: "priya@acme.example" },
      },
    });
  });

  it("reads a non-member's request as not found, without looking up the workspace", async () => {
    liveMode();
    findOrg.mockResolvedValue({
      id: "org-1",
      slug: "acme",
      name: "Acme Robotics",
      namespace: "acme",
    });
    findMembership.mockResolvedValue(undefined);
    const read = await reads.loadFlowScope(user, "acme", "core-platform");
    expect(read.ok).toBe(false);
    expect(findWorkspace).not.toHaveBeenCalled();
  });
});

describe("unbacked reads", () => {
  it("return NotBacked G15 outside fixture mode, never fixture data", () => {
    liveMode();
    const scope = {
      org: { slug: "a", name: "A", namespace: "a1" },
      ws: { slug: "w", name: "W", namespace: "w1" },
      operator: { name: "P", email: "p@a.co" },
    };
    const expected = {
      ok: false,
      reason: "not_backed",
      milestone: "M1",
      gap: "G15",
    };
    expect(reads.loadInstallerOffer()).toEqual(expected);
    expect(reads.loadFirstFrameScript(scope, "a1.w1.x", "claude-code")).toEqual(
      expected,
    );
    expect(reads.loadDetectedRepository()).toEqual(expected);
  });

  it("serve the scripted first frame in fixture mode", () => {
    fixtureMode();
    const read = reads.loadFirstFrameScript(
      {
        org: { slug: "acme", name: "Acme", namespace: "acme" },
        ws: { slug: "core-platform", name: "core", namespace: "core" },
        operator: { name: "Marcus Bell", email: "m@a.co" },
      },
      "acme.core.perf-watch",
      "claude-code",
    );
    expect(read.ok && read.value.log.at(-1)?.firstFrame).toBe(true);
    expect(read.ok && read.value.frames[1]?.body).toContain(
      "acme.core.perf-watch",
    );
  });
});

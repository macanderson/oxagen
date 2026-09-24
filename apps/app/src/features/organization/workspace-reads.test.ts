// The Workspaces tab's reads inside a workspace, through the real kernel seam
// (INV-19): the viewer resolution and the kernel's invoke() are the only
// fakes. Each read resolves the workspace viewer first, so membership is
// checked where every page checks it, and each answer is parsed with the
// contract's own output schema before the tab sees it.
import { beforeEach, describe, expect, it, vi } from "vitest";

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
const { readRepositoryChoices, readWorkspaceFacts } = await import(
  "./workspace-reads"
);

function wsCtx(slug: string) {
  return unsafeMint(WsCtx, {
    userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
    orgId: "7a000000-0000-4000-8000-0000000000a1",
    orgSlug: "acme",
    orgName: "Acme Robotics",
    orgRole: "owner",
    workspaceId: "7a000000-0000-4000-8000-0000000000c3",
    wsSlug: slug,
    wsName: slug,
    wsRole: "member",
  });
}

/** One `list_repositories` row, as the contract's output schema takes it. */
function binding(
  role: "main" | "linked",
  fullName: string,
  defaultRef: string,
) {
  const [owner = "acme", name = "repo"] = fullName.split("/");
  return {
    bindingId: "rpb_0a1b2c",
    role,
    owner,
    name,
    fullName,
    defaultRef,
    htmlUrl: `https://github.com/${fullName}`,
    boundAt: "2026-09-01T00:00:00.000Z",
    connectionLive: true,
    events: "installed" as const,
  };
}

/** `list_agents`' answer: one row of the page and the totals over the workspace. */
function agents(identities: number) {
  return {
    items: [],
    nextCursor: null,
    totals: {
      identities,
      enrolled: 0,
      holdingMandate: null,
      tamperIncidents: 0,
      tamper: { recorded: 0, open: 0, newest: null },
    },
  };
}

/** One `list_installation_repositories` row. */
function reachable(fullName: string, defaultBranch: string) {
  const [owner = "acme", name = "repo"] = fullName.split("/");
  return {
    id: "123",
    owner,
    name,
    fullName,
    defaultBranch,
    private: true,
    htmlUrl: `https://github.com/${fullName}`,
  };
}

const refusal = (code: "not_found" | "forbidden", reason: string) =>
  new kernel.HandlerError({ code, reason });

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset();
  requireViewer.mockImplementation((_org: string, ws: string) =>
    Promise.resolve(wsCtx(ws)),
  );
});

describe("readWorkspaceFacts", () => {
  it("reads the repositories and the agent count inside the workspace, after resolving its viewer", async () => {
    invoke.mockImplementation((name) =>
      Promise.resolve(
        name === "list_repositories"
          ? {
              repositories: [
                binding("main", "acme/platform", "main"),
                binding("linked", "acme/billing", "main"),
              ],
            }
          : agents(64),
      ),
    );
    expect(await readWorkspaceFacts("acme", "core-platform")).toEqual({
      ok: true,
      value: {
        repositories: [
          { role: "main", fullName: "acme/platform", defaultRef: "main" },
          { role: "linked", fullName: "acme/billing", defaultRef: "main" },
        ],
        agents: 64,
      },
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke.mock.calls.map((call) => call[0]).sort()).toEqual([
      "list_agents",
      "list_repositories",
    ]);
    // One agent row is enough: the count is the totals block.
    expect(
      invoke.mock.calls.find((call) => call[0] === "list_agents")?.[1],
    ).toEqual({ limit: 1 });
  });

  it("refuses the whole when either read refuses, rather than a row half fact and half gap (negative)", async () => {
    invoke.mockImplementation((name) =>
      name === "list_agents"
        ? Promise.reject(refusal("forbidden", "org_role_required"))
        : Promise.resolve({ repositories: [] }),
    );
    const read = await readWorkspaceFacts("acme", "core-platform");
    expect(read.ok).toBe(false);
  });
});

describe("readRepositoryChoices", () => {
  it("merges what each workspace's installation reaches, once per repository, by name", async () => {
    let call = 0;
    invoke.mockImplementation(() => {
      call += 1;
      // Both installations reach acme/warehouse; it is offered once.
      return Promise.resolve({
        repositories:
          call === 1
            ? [
                reachable("acme/warehouse", "release"),
                reachable("acme/data-platform", "main"),
              ]
            : [reachable("acme/warehouse", "release")],
        truncated: false,
      });
    });
    expect(
      await readRepositoryChoices("acme", ["core-platform", "growth"]),
    ).toEqual({
      ok: true,
      value: [
        { fullName: "acme/data-platform", defaultBranch: "main" },
        { fullName: "acme/warehouse", defaultBranch: "release" },
      ],
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(requireViewer).toHaveBeenCalledWith("acme", "growth");
  });

  it("keeps what one installation reached when another refuses", async () => {
    let call = 0;
    invoke.mockImplementation(() => {
      call += 1;
      return call === 1
        ? Promise.reject(refusal("not_found", "installation_unreachable"))
        : Promise.resolve({
            repositories: [reachable("acme/warehouse", "main")],
            truncated: false,
          });
    });
    const read = await readRepositoryChoices("acme", ["a", "b"]);
    expect(read).toEqual({
      ok: true,
      value: [{ fullName: "acme/warehouse", defaultBranch: "main" }],
    });
  });

  it("answers the refusal when no installation can be read, so the dialog falls back to typing (negative)", async () => {
    invoke.mockRejectedValue(refusal("not_found", "installation_unreachable"));
    const read = await readRepositoryChoices("acme", ["core-platform"]);
    expect(read.ok).toBe(false);
  });
});

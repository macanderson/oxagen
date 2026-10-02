// health.locate.test.ts: which connection the health and repair runs read a
// steering repo through. A workspace that chose its own GitHub organization or
// GitLab group is read through that one, and every other scope through the
// organization's stored connection.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const rows: unknown[][] = [];
  const tx = () => {
    const builder: Record<string, unknown> = {};
    for (const method of ["select", "from", "where", "limit"])
      builder[method] = () => builder;
    builder["then"] = (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => Promise.resolve(rows.shift() ?? []).then(onFulfilled, onRejected);
    return builder;
  };
  return { rows, tx };
});

vi.mock("@oxagen/database", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/database")>()),
  withSystemDb: async (fn: (tx: unknown) => unknown) => fn(mocks.tx()),
}));
vi.mock("@oxagen/notifications", () => ({
  notifyOrgManagers: vi.fn(),
  notifyOrgSlack: vi.fn(),
}));
vi.mock("../logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { loadHealthTarget } from "./health.hosts";
import type { SteeringConnection } from "../steering_repo.provision";

const ORG_GITHUB: SteeringConnection = {
  provider: "github",
  installation_id: 77,
  account_login: "acme",
  account_type: "Organization",
};
const OWN_GITLAB: SteeringConnection = {
  provider: "gitlab",
  group_id: 42,
  group_path: "acme-labs",
};

function readyState(provider: "github" | "gitlab", own: SteeringConnection | null) {
  return {
    status: "ready",
    step: "bind_repository",
    provider,
    repository: {
      id: 9,
      owner: provider === "gitlab" ? "acme-labs" : "acme",
      name: "acme-steering",
      full_name: `${provider === "gitlab" ? "acme-labs" : "acme"}/acme-steering`,
      initial_branch: "main",
    },
    connection: own,
  };
}

beforeEach(() => {
  mocks.rows.length = 0;
});

describe("loadHealthTarget", () => {
  it("reads a workspace's repo through the connection the workspace chose", async () => {
    mocks.rows.push(
      [{ slug: "acme", settings: { steering_connection: ORG_GITHUB } }],
      [{ slug: "support", settings: { steering_repo: readyState("gitlab", OWN_GITLAB) } }],
    );
    const located = await loadHealthTarget({ orgId: "org_1", workspaceId: "ws_1" });
    expect(located).toMatchObject({
      target: {
        provider: "gitlab",
        repository: { id: 9, full_name: "acme-labs/acme-steering" },
        deepLink: "/acme/support/repositories",
      },
      connection: OWN_GITLAB,
      owner: "acme-labs",
      name: "acme-steering",
    });
  });

  it("reads a workspace's repo through the organization's connection when it chose none", async () => {
    mocks.rows.push(
      [{ slug: "acme", settings: { steering_connection: ORG_GITHUB } }],
      [{ slug: "support", settings: { steering_repo: readyState("github", null) } }],
    );
    const located = await loadHealthTarget({ orgId: "org_1", workspaceId: "ws_1" });
    expect(located?.connection).toEqual(ORG_GITHUB);
  });

  it("names no connection when the one it finds is on another host than the repo (negative)", async () => {
    mocks.rows.push(
      [{ slug: "acme", settings: { steering_connection: ORG_GITHUB } }],
      [{ slug: "support", settings: { steering_repo: readyState("gitlab", null) } }],
    );
    const located = await loadHealthTarget({ orgId: "org_1", workspaceId: "ws_1" });
    expect(located?.connection).toBeNull();
  });
});

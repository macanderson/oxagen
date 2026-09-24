// `list_repositories` (Mission Control spec §10.1): every head in the
// workspace, main first, with the connection behind each judged live or
// retired by the same predicate `get_main_repository` uses.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCTX } from "./test-utils/fixtures";

const mocks = vi.hoisted(() => ({
  withTenantDb: vi.fn(),
}));

vi.mock("@oxagen/database", async (importOriginal) => {
  const real = await importOriginal<typeof import("@oxagen/database")>();
  const __dbMock = { ...real, withTenantDb: mocks.withTenantDb };
  return { ...__dbMock, withOrgDb: __dbMock.withTenantDb };
});

import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { eventDelivery, repositoryListHandler } from "./repository.list";

const BOUND_AT = new Date("2026-09-15T12:06:00.000Z");
const LINKED_AT = new Date("2026-09-17T09:00:00.000Z");

function row(overrides: Record<string, unknown>) {
  return {
    bindingId: "rpb_0123abcd",
    role: "linked",
    provider: "github",
    deliveryConfig: { installationId: "555" } as unknown,
    owner: "acme",
    name: "docs",
    fullName: "acme/docs",
    defaultRef: "main",
    boundAt: LINKED_AT,
    connectionStatus: "connected" as string | null,
    connectionDeletedAt: null as Date | null,
    installationRowId: "ghi_1" as string | null,
    installationSuspendedAt: null as Date | null,
    installationDeletedAt: null as Date | null,
    ...overrides,
  };
}

const MAIN = row({
  bindingId: "rpb_ffffaaaa",
  role: "main",
  name: "widgets",
  fullName: "acme/widgets",
  defaultRef: "trunk",
  boundAt: BOUND_AT,
});

/** The one read: select → from → innerJoin → leftJoin → leftJoin → where, awaited. */
function wire(rows: unknown[]): void {
  mocks.withTenantDb.mockImplementationOnce(
    async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        select: () => ({
          from: () => ({
            innerJoin: () => ({
              leftJoin: () => ({
                leftJoin: () => ({ where: async () => rows }),
              }),
            }),
          }),
        }),
      }),
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("list_repositories", () => {
  it("answers an empty list for a workspace with no heads", async () => {
    wire([]);
    await expect(repositoryListHandler({}, makeCTX())).resolves.toEqual({
      repositories: [],
    });
  });

  it("sorts the main repository first, then the linked ones by full name, whatever order the rows arrive in", async () => {
    wire([
      row({ bindingId: "rpb_0000000b", fullName: "acme/zeta", name: "zeta" }),
      MAIN,
      row({ bindingId: "rpb_0000000a", fullName: "acme/alpha", name: "alpha" }),
    ]);
    const out = await repositoryListHandler({}, makeCTX());
    expect(out.repositories.map((r) => [r.role, r.fullName])).toEqual([
      ["main", "acme/widgets"],
      ["linked", "acme/alpha"],
      ["linked", "acme/zeta"],
    ]);
    expect(out.repositories[0]).toEqual({
      bindingId: "rpb_ffffaaaa",
      role: "main",
      provider: "github",
      owner: "acme",
      name: "widgets",
      fullName: "acme/widgets",
      defaultRef: "trunk",
      htmlUrl: "https://github.com/acme/widgets",
      boundAt: BOUND_AT.toISOString(),
      connectionLive: true,
      events: "installed",
    });
    expect(repositoryList.output.safeParse(out).success).toBe(true);
  });

  it("lists a GitLab project with its host, a gitlab.com link, and webhook delivery (#3762)", async () => {
    const gitlab = (webhookId: number | null) =>
      row({
        bindingId: "rpb_00000abc",
        role: "main",
        provider: "gitlab",
        owner: "acme/platform",
        name: "rules",
        fullName: "acme/platform/rules",
        installationRowId: null,
        deliveryConfig: {
          projectId: "4242",
          projectPath: "acme/platform/rules",
          webhookId,
        },
      });
    wire([gitlab(901)]);
    const [listed] = (await repositoryListHandler({}, makeCTX())).repositories;
    expect(listed).toMatchObject({
      provider: "gitlab",
      htmlUrl: "https://gitlab.com/acme/platform/rules",
      events: "installed",
    });
    wire([gitlab(null)]);
    const [unhooked] = (await repositoryListHandler({}, makeCTX()))
      .repositories;
    expect(unhooked!.events).toBe("unknown");
  });

  it("reports connectionLive false for a head whose connection is retired, without dropping the repository", async () => {
    wire([
      MAIN,
      // `delete_connection` leaves the row at 'deleting' with deleted_at null
      // until the purge; that is already retired.
      row({ bindingId: "rpb_00000001", connectionStatus: "deleting" }),
      // The purge has been through: the left join found no connection at all.
      row({
        bindingId: "rpb_00000002",
        fullName: "acme/purged",
        name: "purged",
        connectionStatus: null,
        connectionDeletedAt: null,
      }),
      row({
        bindingId: "rpb_00000003",
        fullName: "acme/soft",
        name: "soft",
        connectionStatus: "connected",
        connectionDeletedAt: new Date("2026-09-16T00:00:00.000Z"),
      }),
    ]);
    const out = await repositoryListHandler({}, makeCTX());
    expect(
      out.repositories.map((r) => [r.bindingId, r.connectionLive]),
    ).toEqual([
      ["rpb_ffffaaaa", true],
      ["rpb_00000001", false],
      ["rpb_00000002", false],
      ["rpb_00000003", false],
    ]);
  });

  it("says whether GitHub can deliver each repository's events, from the connection and the installation registry", async () => {
    wire([
      MAIN,
      row({ bindingId: "rpb_00000001", connectionStatus: "paused" }),
      row({
        bindingId: "rpb_00000002",
        fullName: "acme/b",
        installationSuspendedAt: new Date("2026-09-16T00:00:00.000Z"),
      }),
      row({
        bindingId: "rpb_00000003",
        fullName: "acme/c",
        installationDeletedAt: new Date("2026-09-16T00:00:00.000Z"),
      }),
      row({
        bindingId: "rpb_00000004",
        fullName: "acme/d",
        installationRowId: null,
      }),
      row({
        bindingId: "rpb_00000005",
        fullName: "acme/e",
        connectionStatus: "deleting",
      }),
    ]);
    const out = await repositoryListHandler({}, makeCTX());
    expect(
      Object.fromEntries(out.repositories.map((r) => [r.bindingId, r.events])),
    ).toEqual({
      rpb_ffffaaaa: "installed",
      rpb_00000001: "paused",
      rpb_00000002: "suspended",
      rpb_00000003: "uninstalled",
      rpb_00000004: "unknown",
      rpb_00000005: "retired",
    });
    expect(repositoryList.output.safeParse(out).success).toBe(true);
  });
});

describe("eventDelivery", () => {
  const live = {
    connectionLive: true,
    connectionStatus: "connected",
    installationRowId: "ghi_1",
    installationSuspendedAt: null,
    installationDeletedAt: null,
  };

  it("puts a retired connection ahead of anything the installation says", () => {
    expect(
      eventDelivery({
        ...live,
        connectionLive: false,
        installationDeletedAt: new Date(),
      }),
    ).toBe("retired");
  });

  it("puts an uninstalled App ahead of a suspended one", () => {
    expect(
      eventDelivery({
        ...live,
        installationSuspendedAt: new Date(),
        installationDeletedAt: new Date(),
      }),
    ).toBe("uninstalled");
  });
});

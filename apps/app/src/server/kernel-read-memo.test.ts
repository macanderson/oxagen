// The kernel seam's per-request read table (ARCHITECTURE.md §3.2, §3.9).
//
// A read is pure for the length of one render, so a page that reads the same
// record twice pays for it once. The Billing page is the case that forced it:
// the plan card and the usage credit balance are two mappings of one
// `get_subscription` record, whose handler aggregates token usage over
// ClickHouse on every invocation, and INV-06 requires each port method under
// src/data/live to make its own `kernelRead` call — so the adapter cannot
// dedup, and the seam is the layer that can.
//
// In production the table's lifetime is a request, which React `cache` gives.
// A node test has no request, and there React hands back a fresh table on
// every call — the property kernel.test.ts asserts. This file stands one
// request up by mocking `cache` to hold its factory's value, so the sharing,
// and the key that decides what shares, are covered rather than assumed.
import { orgList } from "@oxagen/oxagen/contracts/org.list";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readOk } from "@/data/read";

const { invoke, captureError, endRequest, forgetOnRequestEnd } = vi.hoisted(
  () => {
    const resets: (() => void)[] = [];
    return {
      invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
      captureError: vi.fn(),
      /** Every table `cache` has handed out, so a test can end the request. */
      forgetOnRequestEnd: (reset: () => void) => resets.push(reset),
      endRequest: () => {
        for (const reset of resets) reset();
      },
    };
  },
);

vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

// One request: `cache(factory)` answers with the same value every call, which
// is what React does for the length of a request.
vi.mock("react", async (importOriginal) => {
  const real = await importOriginal<typeof import("react")>();
  return {
    ...real,
    cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
      // One box per cached function, so the value keeps the factory's type and
      // the mock needs no assertion; emptying the box ends the request.
      let box: { readonly value: R } | null = null;
      forgetOnRequestEnd(() => {
        box = null;
      });
      return (...args: A): R => {
        box ??= { value: fn(...args) };
        return box.value;
      };
    },
  };
});

const { kernelRead } = await import("./kernel");
const { OrgCtx, PretenantCtx, WsCtx } = await import("./viewer");
const { unsafeMint } = await import("./viewer.testing");

const ORG_ID = "7a000000-0000-4000-8000-0000000000a1";
const OTHER_ORG_ID = "7a000000-0000-4000-8000-0000000000a2";
const WS_ID = "7b000000-0000-4000-8000-0000000000b1";
const USER_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

const orgFields = {
  userId: USER_ID,
  orgId: ORG_ID,
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "member",
} as const;
const orgCtx = unsafeMint(OrgCtx, orgFields);
const otherOrgCtx = unsafeMint(OrgCtx, { ...orgFields, orgId: OTHER_ORG_ID });
const wsCtx = unsafeMint(WsCtx, {
  ...orgFields,
  workspaceId: WS_ID,
  wsSlug: "core",
  wsName: "Core",
  wsRole: "member",
});
const pretenantCtx = unsafeMint(PretenantCtx, { userId: USER_ID });

const members = {
  scope: "org",
  members: [
    {
      id: "usr_marcusbell",
      name: null,
      email: "marcus.bell@acme.example",
      avatarUrl: null,
      role: "member",
      joinedAt: "2026-09-01T00:00:00.000Z",
    },
  ],
  invitations: [],
} as const;
const membersCall = {
  contract: listMembers,
  input: { scope: "org" },
  page: "organization",
} as const;

beforeEach(() => {
  invoke.mockReset();
  captureError.mockReset();
  endRequest();
});

describe("the per-request read table", () => {
  it("serves a repeated read once", async () => {
    invoke.mockResolvedValue(members);
    const first = await kernelRead(orgCtx, membersCall);
    const second = await kernelRead(orgCtx, membersCall);
    expect(first).toEqual(readOk(members));
    expect(second).toEqual(first);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  // The Billing page's shape: two port methods, one record, one invoke.
  it("shares one record between two reads made concurrently", async () => {
    invoke.mockResolvedValue(members);
    const [a, b] = await Promise.all([
      kernelRead(orgCtx, membersCall),
      kernelRead(orgCtx, membersCall),
    ]);
    expect(a).toEqual(readOk(members));
    expect(b).toEqual(a);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("shares a refusal the same way, and never rejects", async () => {
    // classifyKernelFailure keys on the `code` property alone (§3.2).
    invoke.mockRejectedValue({ code: "authz_denied", message: "denied" });
    const first = await kernelRead(orgCtx, membersCall);
    const second = await kernelRead(orgCtx, membersCall);
    expect(first.ok).toBe(false);
    expect(second).toEqual(first);
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("reads again once the request is over", async () => {
    invoke.mockResolvedValue(members);
    await kernelRead(orgCtx, membersCall);
    endRequest();
    await kernelRead(orgCtx, membersCall);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keys on the input, so a different input reads again (negative)", async () => {
    invoke.mockResolvedValue(members);
    await kernelRead(orgCtx, membersCall);
    await kernelRead(orgCtx, { ...membersCall, input: { scope: "workspace" } });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keys on the viewer, so another organization reads again (negative)", async () => {
    invoke.mockResolvedValue(members);
    await kernelRead(orgCtx, membersCall);
    await kernelRead(otherOrgCtx, membersCall);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keys on the workspace, so the same org in a workspace reads again (negative)", async () => {
    invoke.mockResolvedValue(members);
    await kernelRead(orgCtx, membersCall);
    await kernelRead(wsCtx, membersCall);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("keys on the contract, so another read is not served the first's record (negative)", async () => {
    invoke.mockResolvedValue(members);
    await kernelRead(orgCtx, membersCall);
    invoke.mockResolvedValue({ organizations: [] });
    const orgs = await kernelRead(pretenantCtx, {
      contract: orgList,
      input: {},
      page: "shell",
    });
    expect(orgs).toEqual(readOk({ organizations: [] }));
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

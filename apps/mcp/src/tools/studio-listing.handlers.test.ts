// studio-listing.handlers.test.ts: the MCP tools for a Studio draft's tool
// listing on a machine (ADR-233, #4756): start_studio_listing and
// get_studio_listing.
//
// The kernel `invoke` and the context seam `buildContext` are doubles. Each
// case checks that invoke received the contract name, the args, and
// { surface: "mcp" }, and that the output passed the contract's output schema
// on the way back.

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  buildContext: vi.fn(),
  headers: vi.fn(),
}));

vi.mock("@oxagen/oxagen/kernel", () => ({ invoke: mocks.invoke }));
vi.mock("../context", () => ({ buildContext: mocks.buildContext }));
vi.mock("xmcp/headers", () => ({ headers: mocks.headers }));

import getStudioListing, { metadata as getStudioListingMeta } from "./tool.studio.listing.get";
import startStudioListing, {
  metadata as startStudioListingMeta,
  schema as startStudioListingSchema,
} from "./tool.studio.listing.start";

const fakeCtx = {
  orgId: "org_test",
  workspaceId: "ws_test",
  userId: null,
  apiKeyId: "key_test",
  requestId: "req_test",
  surface: "mcp" as const,
  messageId: null,
  clientIp: null,
};

const DIGEST = `sha256:${"c3".repeat(32)}`;

/** A listing waiting for a machine, as get_studio_listing returns it. */
const WAITING = {
  server: "notes",
  status: "waiting_for_machine" as const,
  machineGroups: ["dev-laptops"],
  pin: { name: "notes-mcp", version: "0.9.2", digest: DIGEST, registryType: null },
  draftRevision: 3,
  requestedAt: "2026-09-30T10:00:00.000Z",
  requestedBy: "user_1",
  claimedAt: null,
  finishedAt: null,
  machine: null,
  toolCount: null,
  error: null,
  tools: null,
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.buildContext.mockResolvedValue(fakeCtx);
  mocks.headers.mockReturnValue({ authorization: "Bearer test_key" });
});

describe("the two listing tools carry their contract's name and hints", () => {
  it.each([
    [startStudioListingMeta, "start_studio_listing", false, false, false],
    [getStudioListingMeta, "get_studio_listing", true, false, true],
  ])("%s", (meta, name, readOnly, destructive, idempotent) => {
    expect(meta.name).toBe(name);
    expect(meta.annotations?.readOnlyHint).toBe(readOnly);
    expect(meta.annotations?.destructiveHint).toBe(destructive);
    expect(meta.annotations?.idempotentHint).toBe(idempotent);
  });

  it("takes the server, the draft revision, and a local command's pin", () => {
    expect(Object.keys(startStudioListingSchema)).toEqual(["server", "revision", "pin"]);
  });
});

describe("start_studio_listing", () => {
  it("invokes with the contract name and forwards the waiting listing", async () => {
    mocks.invoke.mockResolvedValue({ listing: WAITING });
    const args = { server: "notes", revision: 3, pin: { version: "0.9.2", digest: DIGEST } };
    const result = await startStudioListing(args);
    expect(mocks.invoke).toHaveBeenCalledWith("start_studio_listing", args, fakeCtx, { surface: "mcp" });
    expect(result).toEqual({ listing: WAITING });
  });

  it("refuses a missing listing, which start never returns", async () => {
    mocks.invoke.mockResolvedValue({ listing: null });
    // A registry package sends no pin. The tool's argument type still names the key.
    await expect(startStudioListing({ server: "notes", revision: 3, pin: undefined })).rejects.toThrow();
  });
});

describe("get_studio_listing", () => {
  it("invokes with the contract name and forwards the listing", async () => {
    mocks.invoke.mockResolvedValue({ listing: WAITING });
    await expect(getStudioListing({ server: "notes" })).resolves.toEqual({ listing: WAITING });
    expect(mocks.invoke).toHaveBeenCalledWith("get_studio_listing", { server: "notes" }, fakeCtx, { surface: "mcp" });
  });

  it("passes a draft with no listing through as null", async () => {
    mocks.invoke.mockResolvedValue({ listing: null });
    await expect(getStudioListing({ server: "notes" })).resolves.toEqual({ listing: null });
  });

  it("refuses an output outside the contract", async () => {
    mocks.invoke.mockResolvedValue({ listing: { ...WAITING, status: "queued" } });
    await expect(getStudioListing({ server: "notes" })).rejects.toThrow();
  });
});

// listing.test.ts: start_studio_listing and get_studio_listing (ADR-233,
// #4756), over fake stores and a fake registry.
import { readFileSync } from "node:fs";
import type { McpLockSource } from "@oxagen/mcp-studio";
import { toolStudioListingGet } from "@oxagen/oxagen/contracts/tool.studio.listing.get";
import { describe, expect, it, vi } from "vitest";
import type { StoredStudioDraft, StudioDraftStore } from "../import/store";
import { makeCTX } from "../../test-utils/fixtures";
import { createGetStudioListingHandler } from "./listing.get";
import { createStartStudioListingHandler, type StartStudioListingDeps } from "./listing.start";
import type { MachineOwnerReader } from "../local-calls/machines";
import type { ListingStore, StoredListing } from "./store";

const USER = "0192d4a8-7c1e-7a00-8000-0000000005e1";
const NOW = new Date("2026-09-30T10:00:00.000Z");
const DIGEST = `sha256:${"c3".repeat(32)}`;

const LOCAL_TOML = [
  "#:schema https://oxagen.sh/schemas/mcp-server/v1.json",
  'schema = "mcp-server/v1"',
  'name = "notes"',
  'label = "Notes"',
  'description = "Notes kept on each machine."',
  "",
  "[source]",
  'type = "local"',
  'command = "/usr/local/bin/notes-mcp"',
  'machines = ["dev-laptops"]',
  "",
  "[exposure]",
  'mode = "direct"',
  "",
  "[sync]",
  'schedule = "manual"',
  "",
].join("\n");

const PACKAGE_TOML = readFileSync(
  new URL("../../../../mcp-studio/fixtures/servers/files/server.toml", import.meta.url),
  "utf8",
);

function draft(over: Partial<StoredStudioDraft> = {}): StoredStudioDraft {
  return {
    server: "notes",
    serverId: null,
    ops: [],
    serverToml: LOCAL_TOML,
    source: null,
    revision: 3,
    pr: null,
    updatedAt: NOW,
    ...over,
  };
}

function stored(lockSource: McpLockSource, over: Partial<StoredListing> = {}): StoredListing {
  return {
    server: "notes",
    status: "waiting_for_machine",
    machineGroups: ["dev-laptops"],
    lockSource,
    draftRevision: 3,
    requestedBy: USER,
    requestedAt: NOW,
    claimedAt: null,
    finishedAt: null,
    machine: null,
    toolCount: null,
    error: null,
    ...over,
  };
}

function harness(found: StoredStudioDraft | null, ownsMachine = true) {
  const drafts: StudioDraftStore = { get: vi.fn(() => Promise.resolve(found)), save: vi.fn(), recordPr: vi.fn() };
  const listings = {
    request: vi.fn<ListingStore["request"]>((_scope, input) =>
      Promise.resolve(stored(input.lockSource, { server: input.server, machineGroups: [...input.groups] })),
    ),
    get: vi.fn<ListingStore["get"]>(() => Promise.resolve(null)),
  };
  const entry = vi.fn();
  const digest = vi.fn(() => Promise.resolve(DIGEST));
  const owners: MachineOwnerReader = {
    ownerOf: vi.fn(() => Promise.resolve(ownsMachine ? USER : null)),
    ownsMachineIn: vi.fn(() => Promise.resolve(ownsMachine)),
  };
  const deps: StartStudioListingDeps = {
    drafts,
    listings,
    authorize: vi.fn(() => Promise.resolve(USER)),
    catalog: () => ({ entry }),
    digests: () => ({ digest }),
    owners,
    now: () => NOW,
  };
  return { deps, drafts, listings, entry, digest, owners };
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (error === undefined) throw new Error("expected a refusal");
  return error as { code: string; reason: string; message: string };
}

describe("start_studio_listing", () => {
  it("pins a local command on the draft revision it was asked on, and records who asked", async () => {
    const h = harness(draft());
    const out = await createStartStudioListingHandler(h.deps)(
      { server: "notes", revision: 3, pin: { version: "0.9.2", digest: DIGEST } },
      makeCTX(),
    );

    expect(h.listings.request).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: expect.any(String), workspaceId: expect.any(String) }),
      {
        server: "notes",
        draftRevision: 3,
        groups: ["dev-laptops"],
        lockSource: {
          type: "local",
          command: "/usr/local/bin/notes-mcp",
          package: { name: "notes-mcp", version: "0.9.2", digest: DIGEST },
        },
        requestedBy: USER,
      },
      NOW,
    );
    expect(out.listing).toMatchObject({
      server: "notes",
      status: "waiting_for_machine",
      machineGroups: ["dev-laptops"],
      pin: { name: "notes-mcp", version: "0.9.2", digest: DIGEST, registryType: null },
      draftRevision: 3,
      requestedBy: USER,
    });
    expect(h.entry).not.toHaveBeenCalled();
  });

  it("refuses a draft saved since the person read it, before any registry read (negative)", async () => {
    const h = harness(draft({ serverToml: PACKAGE_TOML, revision: 5 }));
    const error = await refusal(createStartStudioListingHandler(h.deps)({ server: "notes", revision: 3 }, makeCTX()));
    expect(error).toMatchObject({ code: "conflict", reason: "draft_revision_stale" });
    expect(h.entry).not.toHaveBeenCalled();
    expect(h.listings.request).not.toHaveBeenCalled();
  });

  it("refuses a server with no draft (negative)", async () => {
    const h = harness(null);
    const error = await refusal(createStartStudioListingHandler(h.deps)({ server: "notes", revision: 1 }, makeCTX()));
    expect(error).toMatchObject({ code: "not_found", reason: "draft_not_found" });
  });

  it("refuses a person with no enrolled machine in the server's groups, before any registry read (negative)", async () => {
    const h = harness(draft({ serverToml: PACKAGE_TOML }), false);
    const error = await refusal(
      createStartStudioListingHandler(h.deps)({ server: "notes", revision: 3 }, makeCTX()),
    );

    // A listing starts a program before any review, so it runs only on a
    // machine the person who asked enrolled (ADR-233).
    expect(error).toMatchObject({ code: "conflict", reason: "machine_not_yours" });
    expect(h.owners.ownsMachineIn).toHaveBeenCalledWith(
      expect.objectContaining({ orgId: expect.any(String) }),
      USER,
      ["dev-laptops"],
    );
    expect(h.entry).not.toHaveBeenCalled();
    expect(h.listings.request).not.toHaveBeenCalled();
  });

  it("refuses a local command sent with no pin, and records nothing (negative)", async () => {
    const h = harness(draft());
    const error = await refusal(createStartStudioListingHandler(h.deps)({ server: "notes", revision: 3 }, makeCTX()));
    expect(error).toMatchObject({ reason: "pin_required" });
    expect(h.listings.request).not.toHaveBeenCalled();
  });

  it("refuses before anything runs when the caller lacks the role (negative)", async () => {
    const h = harness(draft());
    h.deps.authorize = vi.fn(() => Promise.reject(Object.assign(new Error("org_role_required"), { code: "forbidden" })));
    const error = await refusal(
      createStartStudioListingHandler(h.deps)(
        { server: "notes", revision: 3, pin: { version: "0.9.2", digest: DIGEST } },
        makeCTX(),
      ),
    );
    expect(error).toMatchObject({ code: "forbidden" });
    expect(h.drafts.get).not.toHaveBeenCalled();
    expect(h.listings.request).not.toHaveBeenCalled();
  });
});

const LOCAL_LOCK: McpLockSource = {
  type: "local",
  command: "/usr/local/bin/notes-mcp",
  package: { name: "notes-mcp", version: "0.9.2", digest: DIGEST },
};

/** The draft a succeeded listing leaves: its tools as the MCP source, one revision on. */
const LISTED = draft({
  revision: 4,
  source: {
    type: "mcp",
    lockSource: LOCAL_LOCK,
    tools: [
      {
        name: "list_notes",
        description: "Lists the notes on this machine.",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
      { name: "delete_note", inputSchema: { type: "object" }, annotations: { destructiveHint: true } },
      { name: "sync_notes", inputSchema: { type: "object" } },
    ],
  },
});

function getHarness(found: StoredStudioDraft | null) {
  const listings = {
    request: vi.fn(),
    get: vi.fn<ListingStore["get"]>(() => Promise.resolve(null)),
  };
  const drafts: StudioDraftStore = { get: vi.fn(() => Promise.resolve(found)), save: vi.fn(), recordPr: vi.fn() };
  const handler = createGetStudioListingHandler({
    listings,
    drafts,
    authorize: vi.fn(() => Promise.resolve(USER)),
  });
  return { listings, drafts, handler };
}

const SUCCEEDED: Partial<StoredListing> = {
  status: "succeeded",
  claimedAt: new Date("2026-09-30T10:00:05.000Z"),
  finishedAt: new Date("2026-09-30T10:00:09.000Z"),
  machine: "tch_laptop01",
  toolCount: 3,
};

describe("get_studio_listing", () => {
  it("answers null for a draft with no listing, and the listing's view when there is one", async () => {
    const { listings, drafts, handler } = getHarness(null);
    expect(await handler({ server: "notes" }, makeCTX())).toEqual({ listing: null });
    expect(drafts.get).not.toHaveBeenCalled();

    listings.get.mockResolvedValueOnce(
      stored(
        {
          type: "local",
          command: "/usr/local/bin/notes-mcp",
          package: { name: "notes-mcp", version: "0.9.2", digest: DIGEST },
        },
        {
          status: "succeeded",
          claimedAt: new Date("2026-09-30T10:00:05.000Z"),
          finishedAt: new Date("2026-09-30T10:00:09.000Z"),
          machine: "tch_laptop01",
          toolCount: 4,
        },
      ),
    );
    const out = await handler({ server: "notes" }, makeCTX());
    expect(() => toolStudioListingGet.output.parse(out)).not.toThrow();
    expect(out.listing).toMatchObject({
      status: "succeeded",
      machine: "tch_laptop01",
      toolCount: 4,
      claimedAt: "2026-09-30T10:00:05.000Z",
      finishedAt: "2026-09-30T10:00:09.000Z",
      // The draft the harness holds has no MCP source, so there is nothing to classify.
      tools: null,
    });
  });

  it("carries the tools a succeeded listing wrote, each with the classification Studio suggests", async () => {
    const { listings, handler } = getHarness(LISTED);
    listings.get.mockResolvedValueOnce(stored(LOCAL_LOCK, SUCCEEDED));

    const out = await handler({ server: "notes" }, makeCTX());
    expect(() => toolStudioListingGet.output.parse(out)).not.toThrow();
    // A local server's egress is local. The hints set the side effect and
    // the risk, and a tool with no hints takes the fail-safe row.
    expect(out.listing?.tools).toStrictEqual([
      {
        name: "list_notes",
        description: "Lists the notes on this machine.",
        suggested: { risk: "low", sideEffect: "read", egress: "local", impacts: [] },
      },
      {
        name: "delete_note",
        description: null,
        suggested: { risk: "high", sideEffect: "irreversible", egress: "local", impacts: ["destroys_data"] },
      },
      {
        name: "sync_notes",
        description: null,
        suggested: { risk: "high", sideEffect: "write", egress: "local", impacts: [] },
      },
    ]);
  });

  it("reads no draft while the listing waits or runs, and shows no tools for it (negative)", async () => {
    const { listings, drafts, handler } = getHarness(LISTED);
    listings.get.mockResolvedValueOnce(stored(LOCAL_LOCK, { status: "running", claimedAt: NOW }));

    const out = await handler({ server: "notes" }, makeCTX());
    expect(out.listing).toMatchObject({ status: "running", tools: null });
    expect(drafts.get).not.toHaveBeenCalled();
  });

  it("shows no tools once the draft is not the one the listing wrote (negative)", async () => {
    // The draft is still at the revision the listing was asked on, so the
    // listing's write never landed there.
    const unwritten = getHarness({ ...LISTED, revision: 3 });
    unwritten.listings.get.mockResolvedValueOnce(stored(LOCAL_LOCK, SUCCEEDED));
    expect((await unwritten.handler({ server: "notes" }, makeCTX())).listing?.tools).toBeNull();

    // A tools/list answer that names one tool twice does not import.
    const unreadable = getHarness(
      draft({
        revision: 4,
        source: {
          type: "mcp",
          lockSource: LOCAL_LOCK,
          tools: [
            { name: "list_notes", inputSchema: { type: "object" } },
            { name: "list_notes", inputSchema: { type: "object" } },
          ],
        },
      }),
    );
    unreadable.listings.get.mockResolvedValueOnce(stored(LOCAL_LOCK, SUCCEEDED));
    expect((await unreadable.handler({ server: "notes" }, makeCTX())).listing?.tools).toBeNull();
  });
});

// claim.test.ts: a polling machine's process lists the tools of the Studio
// drafts that wait for it (ADR-233, #4756), with a fake claim store, a fake
// draft store, and a fake reporter.
import { readFileSync } from "node:fs";
import type { McpLockSource } from "@oxagen/mcp-studio";
import { describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn() }));
vi.mock("../../logger", () => ({
  logger: { warn: logs.warn, info: logs.info, error: vi.fn(), debug: vi.fn() },
}));

import type { LocalToolsReporter } from "../discovery/seams";
import type { StoredStudioDraft, StudioDraftStore } from "../import/store";
import type { LocalGatewayBroker } from "../local-calls/broker";
import type { MachineGroupReader, MachineOwnerReader } from "../local-calls/machines";
import { claimDraftListings, LISTINGS_PER_POLL } from "./claim";
import type { ClaimedListing, CompletionResult, ListingClaimStore } from "./store";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const MACHINE = "tch_laptop01";
const NOW = new Date("2026-09-30T10:00:00.000Z");
const DIGEST = `sha256:${"c3".repeat(32)}`;

const SERVER_TOML = readFileSync(
  new URL("../../../../mcp-studio/fixtures/servers/files/server.toml", import.meta.url),
  "utf8",
);

const LOCK: McpLockSource = {
  type: "registry",
  registry: "https://registry.modelcontextprotocol.io",
  server: "io.github.modelcontextprotocol/server-filesystem",
  version: "2026.8.1",
  package: {
    name: "@modelcontextprotocol/server-filesystem",
    version: "2026.8.1",
    digest: DIGEST,
    registry_type: "npm",
  },
  command: "npx",
  args: ["--yes", "@modelcontextprotocol/server-filesystem@2026.8.1", "${WORK_DIR}"],
};

const TOOLS = [
  { name: "read_file", description: "Read one file.", inputSchema: { type: "object" as const } },
  { name: "write_file", description: "Write one file.", inputSchema: { type: "object" as const } },
];

const broker = { connected: () => true } as unknown as LocalGatewayBroker;

function reader(groups: readonly string[]): MachineGroupReader {
  return {
    groupsOf: vi.fn(() => Promise.resolve(groups)),
    isSuspended: vi.fn(() => Promise.resolve(false)),
  };
}

/** The person who enrolled the machine, and who asked for the listings here. */
const OWNER = "0192d4a8-7c1e-7a00-8000-0000000005e1";

function owns(owner: string | null = OWNER): MachineOwnerReader {
  return {
    ownerOf: vi.fn(() => Promise.resolve(owner)),
    ownsMachineIn: vi.fn(() => Promise.resolve(owner !== null)),
  };
}

function claim(server = "files", draftRevision = 3): ClaimedListing {
  return {
    id: `0192d4a8-7c1e-7a00-8000-${server.padStart(12, "0")}`,
    server,
    draftRevision,
    lockSource: LOCK,
    requestedBy: "0192d4a8-7c1e-7a00-8000-0000000005e1",
    claimedAt: NOW,
  };
}

/** A claim store that hands out `open` in order, then nothing. */
function claimStore(open: ClaimedListing[], result: CompletionResult = { status: "succeeded", draftRevision: 4 }) {
  const queue = [...open];
  return {
    claimOpen: vi.fn<ListingClaimStore["claimOpen"]>(() => Promise.resolve(queue.shift() ?? null)),
    complete: vi.fn<ListingClaimStore["complete"]>(() => Promise.resolve(result)),
    fail: vi.fn<ListingClaimStore["fail"]>(() => Promise.resolve()),
  };
}

function draftStore(draft: Partial<StoredStudioDraft> | null): StudioDraftStore {
  return {
    get: vi.fn(() =>
      Promise.resolve(
        draft === null
          ? null
          : {
              server: "files",
              serverId: null,
              ops: [],
              serverToml: SERVER_TOML,
              source: null,
              revision: 3,
              pr: null,
              updatedAt: NOW,
              ...draft,
            },
      ),
    ),
    save: vi.fn(),
    recordPr: vi.fn(),
  };
}

function reporter(answer: () => Promise<Awaited<ReturnType<LocalToolsReporter["report"]>>>) {
  return { report: vi.fn<LocalToolsReporter["report"]>(answer) };
}

const listed = () => Promise.resolve({ machine: MACHINE, server_version: "2026.8.1", tools: TOOLS });

describe("claimDraftListings", () => {
  it("claims nothing for a machine no person enrolled (negative)", async () => {
    const claims = claimStore([claim()]);
    const out = await claimDraftListings(
      { scope: SCOPE, machine: MACHINE },
      { broker, owners: owns(null), reader: reader(["dev-laptops"]), claims, drafts: draftStore({}), now: () => NOW },
    );
    expect(out).toEqual([]);
    expect(claims.claimOpen).not.toHaveBeenCalled();
  });

  it("lists the claimed draft's tools on the machine and writes them into the draft", async () => {
    const claims = claimStore([claim()]);
    const report = reporter(listed);
    const groups = reader(["dev-laptops"]);

    const out = await claimDraftListings(
      { scope: SCOPE, machine: MACHINE },
      { broker, owners: owns(), reader: groups, claims, drafts: draftStore({}), reporter: report, now: () => NOW },
    );

    expect(out).toEqual([{ server: "files", status: "succeeded", toolCount: 2, error: null }]);
    // The machine claims only the listings of the person who enrolled it.
    expect(claims.claimOpen).toHaveBeenCalledWith(SCOPE, ["dev-laptops"], OWNER, NOW);
    // The machine starts the server from the draft's server.toml at the pin.
    expect(report.report).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: SCOPE,
        server: "files",
        source: expect.objectContaining({ type: "registry", machines: ["dev-laptops"] }),
        lockSource: LOCK,
      }),
    );
    // The draft's source is the MCP source Review imports: the tools and the
    // pin, with the version the server reported.
    expect(claims.complete).toHaveBeenCalledWith(
      SCOPE,
      claim(),
      {
        source: { type: "mcp", lockSource: { ...LOCK, server_version: "2026.8.1" }, tools: TOOLS },
        machine: MACHINE,
        toolCount: 2,
      },
      NOW,
    );
    expect(claims.fail).not.toHaveBeenCalled();
  });

  it("claims nothing for a machine in no group", async () => {
    const claims = claimStore([claim()]);
    const out = await claimDraftListings(
      { scope: SCOPE, machine: MACHINE },
      { broker, owners: owns(), reader: reader([]), claims, drafts: draftStore({}), reporter: reporter(listed) },
    );
    expect(out).toEqual([]);
    expect(claims.claimOpen).not.toHaveBeenCalled();
  });

  it("runs at most the limit in one poll", async () => {
    const claims = claimStore(Array.from({ length: LISTINGS_PER_POLL + 2 }, () => claim()));
    const out = await claimDraftListings(
      { scope: SCOPE, machine: MACHINE },
      { broker, owners: owns(), reader: reader(["dev-laptops"]), claims, drafts: draftStore({}), reporter: reporter(listed) },
    );
    expect(out).toHaveLength(LISTINGS_PER_POLL);
    expect(claims.claimOpen).toHaveBeenCalledTimes(LISTINGS_PER_POLL);
  });

  it("fails a listing whose draft was saved after it was asked, and asks no machine (negative)", async () => {
    const claims = claimStore([claim()]);
    const report = reporter(listed);
    const out = await claimDraftListings(
      { scope: SCOPE, machine: MACHINE },
      { broker, owners: owns(), reader: reader(["dev-laptops"]), claims, drafts: draftStore({ revision: 4 }), reporter: report, now: () => NOW },
    );
    expect(out[0]).toMatchObject({ status: "failed" });
    expect(report.report).not.toHaveBeenCalled();
    expect(claims.complete).not.toHaveBeenCalled();
    expect(claims.fail).toHaveBeenCalledWith(
      SCOPE,
      claim(),
      "The draft for files was saved after its tools were asked for, so nothing was listed. List its tools again.",
      NOW,
    );
  });

  it("fails a listing whose draft is gone (negative)", async () => {
    const claims = claimStore([claim()]);
    const out = await claimDraftListings(
      { scope: SCOPE, machine: MACHINE },
      { broker, owners: owns(), reader: reader(["dev-laptops"]), claims, drafts: draftStore(null), reporter: reporter(listed) },
    );
    expect(out[0]).toMatchObject({ status: "failed", error: "The draft for files is gone, so nothing was listed." });
  });

  it("records the machine's refusal and goes on to the next listing (negative)", async () => {
    const claims = claimStore([claim("files"), claim("notes")]);
    const report = reporter(() => Promise.reject(new Error("the executable's SHA-256 does not match the pin")));
    report.report.mockImplementationOnce(() => Promise.reject(new Error("the executable's SHA-256 does not match the pin")));
    report.report.mockImplementationOnce(listed);
    const out = await claimDraftListings(
      { scope: SCOPE, machine: MACHINE },
      {
        broker,
        owners: owns(),
        reader: reader(["dev-laptops"]),
        claims,
        drafts: { ...draftStore({}), get: vi.fn((_scope, server: string) => draftStore({ server }).get(_scope, server)) },
        reporter: report,
        now: () => NOW,
      },
    );
    expect(out.map((o) => [o.server, o.status])).toEqual([
      ["files", "failed"],
      ["notes", "succeeded"],
    ]);
    expect(claims.fail).toHaveBeenCalledWith(SCOPE, claim("files"), "the executable's SHA-256 does not match the pin", NOW);
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ server: "files", machine: MACHINE }),
      "Studio listing on a machine failed; the row records why",
    );
  });

  it("reports a listing the draft outran between the answer and the write (negative)", async () => {
    const claims = claimStore([claim()], { status: "draft_changed" });
    const out = await claimDraftListings(
      { scope: SCOPE, machine: MACHINE },
      { broker, owners: owns(), reader: reader(["dev-laptops"]), claims, drafts: draftStore({}), reporter: reporter(listed) },
    );
    expect(out[0]).toMatchObject({ status: "failed" });
    expect(out[0]?.error).toMatch(/was saved after its tools were asked for, so the listing wrote nothing/);
  });

  it("drops an answer whose claim another request replaced (negative)", async () => {
    const claims = claimStore([claim()], { status: "claim_lost" });
    const out = await claimDraftListings(
      { scope: SCOPE, machine: MACHINE },
      { broker, owners: owns(), reader: reader(["dev-laptops"]), claims, drafts: draftStore({}), reporter: reporter(listed) },
    );
    expect(out[0]?.error).toMatch(/^Another request replaced the listing for files/);
    expect(claims.fail).not.toHaveBeenCalled();
  });
});

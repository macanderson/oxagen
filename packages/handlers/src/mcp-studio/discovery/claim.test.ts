// claim.test.ts: a polling machine's process claims and runs the discoveries
// that wait for it (#4772), with a fake claim store and a fake run.
import { describe, expect, it, vi } from "vitest";

const logs = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("../../logger", () => ({
  logger: { warn: logs.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { LocalGatewayBroker } from "../local-calls/broker";
import type { MachineGroupReader } from "../local-calls/machines";
import {
  CLAIMS_PER_POLL,
  claimMachineDiscoveries,
  rediscoverOnMachine,
} from "./claim";
import type { DiscoveryRunData } from "./entry";
import type { DiscoverySeams } from "./seams";
import type { ClaimedDiscovery, DiscoveryClaimStore } from "./store";
import type { RunDiscoveryDeps } from "./sync";
import type { DiscoveryResult, DiscoveryScope } from "./types";

const SCOPE: DiscoveryScope = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};
const MACHINE = "tch_laptop01";
const NOW = new Date("2026-09-30T09:00:00.000Z");

const broker = { connected: () => true } as unknown as LocalGatewayBroker;

function reader(groups: readonly string[]): MachineGroupReader {
  return { groupsOf: vi.fn(() => Promise.resolve(groups)) };
}

/** A claim store that hands out `waiting` in order, then nothing. */
function claimStore(waiting: ClaimedDiscovery[]) {
  const queue = [...waiting];
  const claimWaiting = vi.fn<DiscoveryClaimStore["claimWaiting"]>(() =>
    Promise.resolve(queue.shift() ?? null),
  );
  return { claimWaiting };
}

const seams = () =>
  Promise.resolve({ opener: { open: vi.fn() } } as unknown as DiscoverySeams);

function result(server: string): DiscoveryResult {
  return {
    server,
    status: "succeeded",
    outcome: "unchanged",
    toolCount: 2,
    withheld: [],
    pr: null,
    error: null,
  };
}

function runner() {
  return vi.fn((data: DiscoveryRunData, _deps: RunDiscoveryDeps) =>
    Promise.resolve(result(data.server)),
  );
}

describe("claimMachineDiscoveries", () => {
  it("claims each discovery waiting for the machine's groups and runs it through the broker", async () => {
    const claims = claimStore([
      { server: "files", trigger: "list_changed", requestedBy: null },
      { server: "notes", trigger: "manual", requestedBy: "0192d4a8-7c1e-7a00-8000-0000000005e1" },
    ]);
    const run = runner();
    const groups = reader(["dev-laptops"]);

    const out = await claimMachineDiscoveries(
      { scope: SCOPE, machine: MACHINE },
      { broker, reader: groups, claims, run, seams, now: () => NOW },
    );

    expect(out.map((r) => r.server)).toEqual(["files", "notes"]);
    expect(claims.claimWaiting).toHaveBeenCalledWith(SCOPE, ["dev-laptops"], NOW);
    expect(run.mock.calls.map(([data]) => data)).toEqual([
      {
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        server: "files",
        trigger: "list_changed",
        requestedBy: undefined,
      },
      {
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        server: "notes",
        trigger: "manual",
        requestedBy: "0192d4a8-7c1e-7a00-8000-0000000005e1",
      },
    ]);
    // Every run gets the process's seams with a reporter for this broker.
    const used = run.mock.calls[0]?.[1].seams;
    expect(used?.opener).toBeDefined();
    expect(typeof used?.local.report).toBe("function");
  });

  it("claims nothing for a machine in no group", async () => {
    const claims = claimStore([
      { server: "files", trigger: "list_changed", requestedBy: null },
    ]);
    const run = runner();
    const out = await claimMachineDiscoveries(
      { scope: SCOPE, machine: MACHINE },
      { broker, reader: reader([]), claims, run, seams },
    );
    expect(out).toEqual([]);
    expect(claims.claimWaiting).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  it("runs at most the limit in one poll", async () => {
    const waiting = Array.from({ length: CLAIMS_PER_POLL + 2 }, (_, i) => ({
      server: `srv-${i}`,
      trigger: "schedule" as const,
      requestedBy: null,
    }));
    const claims = claimStore(waiting);
    const run = runner();
    const out = await claimMachineDiscoveries(
      { scope: SCOPE, machine: MACHINE },
      { broker, reader: reader(["dev-laptops"]), claims, run, seams },
    );
    expect(out).toHaveLength(CLAIMS_PER_POLL);
    expect(claims.claimWaiting).toHaveBeenCalledTimes(CLAIMS_PER_POLL);
  });

  it("logs a run that throws and goes on to the next", async () => {
    const claims = claimStore([
      { server: "files", trigger: "list_changed", requestedBy: null },
      { server: "notes", trigger: "list_changed", requestedBy: null },
    ]);
    const run = vi.fn((data: DiscoveryRunData) =>
      data.server === "files"
        ? Promise.reject(new Error("MCP discovery of files failed: the machine refused"))
        : Promise.resolve(result(data.server)),
    );
    const out = await claimMachineDiscoveries(
      { scope: SCOPE, machine: MACHINE },
      { broker, reader: reader(["dev-laptops"]), claims, run, seams },
    );
    expect(out.map((r) => r.server)).toEqual(["notes"]);
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        server: "files",
        machine: MACHINE,
        error: "MCP discovery of files failed: the machine refused",
      }),
      "MCP discovery on a machine failed; the row records why",
    );
  });
});

describe("rediscoverOnMachine", () => {
  it("runs the server's discovery for list_changed through the machine that reported it", async () => {
    const run = runner();
    const out = await rediscoverOnMachine(
      { scope: SCOPE, machine: MACHINE, server: "files" },
      { broker, reader: reader(["dev-laptops"]), run, seams },
    );
    expect(out?.server).toBe("files");
    expect(run).toHaveBeenCalledWith(
      {
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        server: "files",
        trigger: "list_changed",
      },
      expect.objectContaining({ seams: expect.anything() }),
    );
    expect(typeof run.mock.calls[0]?.[1].seams?.local.report).toBe("function");
  });

  it("answers null and logs when the run throws", async () => {
    const run = vi.fn(() => Promise.reject(new Error("steering repo unreachable")));
    const out = await rediscoverOnMachine(
      { scope: SCOPE, machine: MACHINE, server: "files" },
      { broker, reader: reader(["dev-laptops"]), run, seams },
    );
    expect(out).toBeNull();
    expect(logs.warn).toHaveBeenCalledWith(
      expect.objectContaining({ server: "files", error: "steering repo unreachable" }),
      "MCP discovery after a tools change failed; the row records why",
    );
  });
});

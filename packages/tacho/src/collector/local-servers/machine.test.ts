/**
 * The machine's local-server loop (#4773): which host files let it pull,
 * where it pulls from, and when the daemon's sync starts and stops it.
 */
import { describe, expect, it, vi } from "vitest";
import type { CloudFetch, CloudResponse } from "./cloud-link";
import type { LocalServers, LocalServersOptions } from "./local-servers";
import {
  createMachineLink,
  createMachineLoop,
  machineOrigin,
  machineParked,
  type MachineHost,
} from "./machine";

function machineHost(overrides: Partial<MachineHost> = {}): MachineHost {
  return {
    host_enrollment_id: "hen_laptop",
    gateway_api_key: "oxk_gateway_secret",
    bundle_public_key_pem: "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n",
    api_url: "https://api.example.test",
    endpoints: {
      ingest: "https://api.example.test/v1/tacho/events",
      bundle: "https://api.example.test/v1/tacho/bundle",
      commands: "https://api.example.test/v1/tacho/commands",
    },
    host_status: "active",
    revoked_at: null,
    ...overrides,
  };
}

function noContent(): CloudResponse {
  return { ok: true, status: 204, text: () => Promise.resolve("") };
}

/** A fake loop that counts its starts and stops. */
function fakeLoops(): {
  built: LocalServersOptions[];
  loops: { started: number; stopped: number }[];
  create: (options: LocalServersOptions) => LocalServers;
} {
  const built: LocalServersOptions[] = [];
  const loops: { started: number; stopped: number }[] = [];
  return {
    built,
    loops,
    create(options) {
      built.push(options);
      const loop = { started: 0, stopped: 0 };
      loops.push(loop);
      return {
        handle: () => Promise.reject(new Error("not used")),
        start: () => {
          loop.started += 1;
        },
        stop: () => {
          loop.stopped += 1;
          return Promise.resolve();
        },
      };
    },
  };
}

describe("machineParked", () => {
  it("lets an active host with a gateway key pull", () => {
    expect(machineParked(machineHost())).toBeUndefined();
    expect(machineParked(machineHost({ host_status: "paused" }))).toBeUndefined();
  });

  it("parks a revoked, suspended or keyless host", () => {
    expect(machineParked(machineHost({ revoked_at: "2026-09-29T00:00:00.000Z" }))).toBe("the enrollment is revoked");
    expect(machineParked(machineHost({ host_status: "revoked" }))).toBe("the enrollment is revoked");
    expect(machineParked(machineHost({ host_status: "suspended" }))).toBe("the host is suspended");
    expect(machineParked(machineHost({ gateway_api_key: undefined }))).toMatch(/no gateway key/);
  });
});

describe("the machine's link", () => {
  it("pulls from the MCP origin with the gateway key and names the machine", async () => {
    const fetch = vi.fn<CloudFetch>(() => Promise.resolve(noContent()));
    const link = createMachineLink(machineHost(), fetch, {});
    await expect(link.next()).resolves.toBeUndefined();
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://mcp.example.test/v1/local-servers/next");
    expect(init.headers["Authorization"]).toBe("Bearer oxk_gateway_secret");
    expect(init.headers["X-Tacho-Host"]).toBe("hen_laptop");
  });

  it("follows the MCP endpoint the host file or the environment pins", () => {
    const pinned = machineHost({ endpoints: { ...machineHost().endpoints, mcp: "https://gw.example.test:8443/mcp" } });
    expect(machineOrigin(pinned, {})).toBe("https://gw.example.test:8443");
    expect(machineOrigin(pinned, { TACHO_MCP_ENDPOINT: "http://127.0.0.1:3002/mcp" })).toBe("http://127.0.0.1:3002");
  });

  it("refuses a host with no gateway key rather than use the host key", () => {
    const fetch = vi.fn<CloudFetch>();
    expect(() => createMachineLink(machineHost({ gateway_api_key: undefined }), fetch, {})).toThrow(/no gateway key/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("createMachineLoop", () => {
  function loop(host: { current: MachineHost }) {
    const fakes = fakeLoops();
    const logs: string[] = [];
    const machine = createMachineLoop({
      host: () => host.current,
      fetch: vi.fn<CloudFetch>(),
      log: (line) => logs.push(line),
      env: {},
      platform: "linux",
      create: fakes.create,
    });
    return { machine, logs, ...fakes };
  }

  it("starts once for an active host and keeps running across syncs", () => {
    const host = { current: machineHost() };
    const { machine, built, loops, logs } = loop(host);
    machine.sync();
    machine.sync();
    expect(loops).toEqual([{ started: 1, stopped: 0 }]);
    expect(built[0]!.machine).toBe("hen_laptop");
    expect(built[0]!.publicKeyPem).toBe(host.current.bundle_public_key_pem);
    expect(logs).toEqual(["local servers: pulling calls from https://mcp.example.test"]);
    expect(logs.join("\n")).not.toContain("oxk_gateway_secret");
  });

  it("stops on a suspension and starts again when it lifts", () => {
    const host = { current: machineHost() };
    const { machine, loops, logs } = loop(host);
    machine.sync();
    host.current = machineHost({ host_status: "suspended" });
    machine.sync();
    machine.sync();
    expect(loops).toEqual([{ started: 1, stopped: 1 }]);
    host.current = machineHost();
    machine.sync();
    expect(loops).toEqual([
      { started: 1, stopped: 1 },
      { started: 1, stopped: 0 },
    ]);
    expect(logs.filter((line) => line.includes("suspended"))).toEqual([
      "local servers: stopped pulling calls, because the host is suspended",
      "local servers: not pulling calls, because the host is suspended",
    ]);
  });

  it("stops for good when the enrollment is revoked", () => {
    const host = { current: machineHost() };
    const { machine, loops } = loop(host);
    machine.sync();
    host.current = machineHost({ revoked_at: "2026-09-29T00:00:00.000Z" });
    machine.sync();
    expect(loops).toEqual([{ started: 1, stopped: 1 }]);
  });

  it("never starts for a host with no gateway key", () => {
    const { machine, loops, logs } = loop({ current: machineHost({ gateway_api_key: undefined }) });
    machine.sync();
    machine.sync();
    expect(loops).toEqual([]);
    expect(logs).toHaveLength(1);
  });

  it("restarts when the gateway key changes", () => {
    const host = { current: machineHost() };
    const { machine, loops } = loop(host);
    machine.sync();
    host.current = machineHost({ gateway_api_key: "oxk_gateway_next" });
    machine.sync();
    expect(loops).toEqual([
      { started: 1, stopped: 1 },
      { started: 1, stopped: 0 },
    ]);
  });

  it("waits for the running loop on stop", async () => {
    const host = { current: machineHost() };
    let finish: () => void = () => {};
    const machine = createMachineLoop({
      host: () => host.current,
      fetch: vi.fn<CloudFetch>(),
      log: () => {},
      env: {},
      platform: "linux",
      create: () => ({
        handle: () => Promise.reject(new Error("not used")),
        start: () => {},
        stop: () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      }),
    });
    machine.sync();
    let stopped = false;
    const stopping = machine.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(stopped).toBe(true);
  });
});

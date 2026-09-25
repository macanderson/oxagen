import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";
import {
  isStripeTunnelPid,
  stopStripeTunnel,
  tunnelAlreadyRunning,
} from "./stripe-tunnel";

const TUNNEL_CMD = "stripe listen --forward-to localhost:4000/webhooks/stripe";

describe("isStripeTunnelPid", () => {
  it("accepts a stripe listen command line, with or without a path", () => {
    expect(isStripeTunnelPid(4242, () => TUNNEL_CMD)).toBe(true);
    expect(
      isStripeTunnelPid(4242, () => `/opt/homebrew/bin/${TUNNEL_CMD}`),
    ).toBe(true);
  });

  it("rejects a gone pid, another program, and another stripe command", () => {
    expect(isStripeTunnelPid(4242, () => null)).toBe(false);
    expect(isStripeTunnelPid(4242, () => "/usr/bin/postgres -D /data")).toBe(
      false,
    );
    expect(isStripeTunnelPid(4242, () => "stripe logs tail")).toBe(false);
    expect(isStripeTunnelPid(4242, () => "vim stripe-listen.md")).toBe(false);
  });

  it("rejects a pid that is not a positive integer without reading it", () => {
    const readCmd = vi.fn(() => TUNNEL_CMD);
    expect(isStripeTunnelPid(0, readCmd)).toBe(false);
    expect(isStripeTunnelPid(Number.NaN, readCmd)).toBe(false);
    expect(readCmd).not.toHaveBeenCalled();
  });
});

describe("stripe tunnel pidfile", () => {
  let dir: string;
  let pidFile: string;
  let kill: MockInstance<typeof process.kill>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stripe-tunnel-"));
    pidFile = join(dir, ".stripe-listen.pid");
    writeFileSync(pidFile, "4242");
    kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stops the process group when the pid is still stripe listen", async () => {
    await stopStripeTunnel(pidFile, () => TUNNEL_CMD);
    expect(kill).toHaveBeenCalledWith(-4242, "SIGTERM");
    expect(existsSync(pidFile)).toBe(false);
  });

  it("signals nothing when the pid now belongs to another process", async () => {
    await stopStripeTunnel(pidFile, () => "/usr/bin/postgres -D /data");
    expect(kill).not.toHaveBeenCalled();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("reuses a running tunnel and discards a pidfile naming another process", () => {
    expect(tunnelAlreadyRunning(pidFile, () => TUNNEL_CMD)).toBe(true);
    expect(existsSync(pidFile)).toBe(true);

    expect(tunnelAlreadyRunning(pidFile, () => "node server.js")).toBe(false);
    expect(existsSync(pidFile)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import net from "node:net";
import {
  APP_PORTS,
  classifyStack,
  isPortInUse,
  inspectAppPorts,
  type AppPort,
} from "./lib/preflight-ports";

describe("classifyStack", () => {
  it("returns 'clean' when no app ports are bound", () => {
    expect(classifyStack([])).toEqual({ status: "clean" });
  });

  it("returns 'running' when every app port is bound", () => {
    const bound = [...APP_PORTS];
    const result = classifyStack(bound);
    expect(result.status).toBe("running");
    if (result.status === "running")
      expect(result.bound).toHaveLength(APP_PORTS.length);
  });

  it("returns 'partial' when only some app ports are bound, listing the free ones", () => {
    const bound = [APP_PORTS[0]] as AppPort[]; // only :3000
    const result = classifyStack(bound);
    expect(result.status).toBe("partial");
    if (result.status === "partial") {
      expect(result.bound).toEqual(bound);
      expect(result.free.map((p) => p.port)).toEqual([3300, 4000, 4100]);
    }
  });

  it("treats the app ports as 3000/3300/4000/4100 only (datastores excluded)", () => {
    expect(APP_PORTS.map((p) => p.port)).toEqual([3000, 3300, 4000, 4100]);
  });
});

describe("isPortInUse", () => {
  it("reports true for a port with an active listener and false once closed", async () => {
    const server = net.createServer();
    const port: number = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    expect(await isPortInUse(port)).toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));

    expect(await isPortInUse(port)).toBe(false);
  });
});

describe("inspectAppPorts", () => {
  it("classifies a custom port set as 'running' when a real listener occupies it", async () => {
    const server = net.createServer();
    const port: number = await new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        resolve(typeof addr === "object" && addr ? addr.port : 0);
      });
    });

    const result = await inspectAppPorts([{ port, name: "test" }]);
    expect(result.status).toBe("running");

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

/**
 * `oxagen tacho` delegates to @oxagen/tacho/cli with the platform CLI's
 * credentials. Mocks: the config store and the tacho CLI module; no
 * filesystem or network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureWriter } from "../../lib/capture-writer.js";

const store: { token?: string; org?: string; ws?: string } = {};
vi.mock("../../lib/config.js", () => ({
  getToken: () => store.token,
  getOrgId: () => store.org,
  getWorkspaceId: () => store.ws,
  getApiUrl: () => "https://api.test",
}));

const calls: Array<{ name: string; args: unknown[] }> = [];
const outcomes = {
  enroll: { ok: true, warnings: [] as string[] },
  verify: { ok: true, detail: "chained" },
  status: { enrolled: true },
  unenroll: { ok: true },
  exportCommand: true,
};
vi.mock("@oxagen/tacho/cli", () => ({
  defaultCliDeps: (overrides: Record<string, unknown>) => ({
    fake: true,
    ...overrides,
  }),
  enroll: async (...args: unknown[]) => {
    calls.push({ name: "enroll", args });
    return outcomes.enroll;
  },
  verify: async (...args: unknown[]) => {
    calls.push({ name: "verify", args });
    return outcomes.verify;
  },
  status: async (...args: unknown[]) => {
    calls.push({ name: "status", args });
    return outcomes.status;
  },
  unenroll: async (...args: unknown[]) => {
    calls.push({ name: "unenroll", args });
    return outcomes.unenroll;
  },
  exportCommand: async (...args: unknown[]) => {
    calls.push({ name: "exportCommand", args });
    return outcomes.exportCommand;
  },
}));

import {
  handleTachoEnroll,
  handleTachoExport,
  handleTachoStatus,
  handleTachoUnenroll,
  handleTachoVerify,
  tachoCredentials,
} from "../tacho.js";

describe("oxagen tacho", () => {
  beforeEach(() => {
    calls.length = 0;
    store.token = "session-token";
    store.org = "acme";
    store.ws = "core";
    outcomes.enroll = { ok: true, warnings: [] };
    outcomes.verify = { ok: true, detail: "chained" };
    outcomes.status = { enrolled: true };
  });

  it("lends the logged-in credentials and lets flags override them", () => {
    expect(tachoCredentials()).toEqual({
      token: "session-token",
      org: "acme",
      workspace: "core",
      apiUrl: "https://api.test",
    });
    expect(tachoCredentials({ token: "t2", org: "other" })).toMatchObject({
      token: "t2",
      org: "other",
      workspace: "core",
    });
    store.token = undefined;
    expect(tachoCredentials()).toEqual({
      org: "acme",
      workspace: "core",
      apiUrl: "https://api.test",
    });
  });

  it("enroll passes credentials and options through, then verifies on request", async () => {
    const { writer, output } = captureWriter();
    expect(
      await handleTachoEnroll(
        { service: false, force: true, verify: true },
        writer,
      ),
    ).toBe(true);
    expect(calls.map((c) => c.name)).toEqual(["enroll", "verify"]);
    expect(calls[0]?.args[0]).toEqual({
      token: "session-token",
      org: "acme",
      workspace: "core",
      apiUrl: "https://api.test",
      service: false,
      force: true,
    });
    expect((calls[0]?.args[1] as { fake: boolean }).fake).toBe(true);
    expect(output()).toContain("Verified: chained");
    outcomes.enroll = { ok: false, warnings: [] };
    expect(await handleTachoEnroll({}, writer)).toBe(false);
    outcomes.enroll = { ok: true, warnings: [] };
    outcomes.verify = { ok: false, detail: "no session" };
    expect(await handleTachoEnroll({ verify: true }, writer)).toBe(false);
    expect(output()).toContain("Verify failed: no session");
  });

  it("status, unenroll, export, and verify report their outcome as the exit status", async () => {
    const { writer, output } = captureWriter();
    expect(await handleTachoStatus({ json: true }, writer)).toBe(true);
    expect(calls[0]?.args[0]).toEqual({ json: true });
    outcomes.status = { enrolled: false };
    expect(await handleTachoStatus({}, writer)).toBe(false);
    expect(
      await handleTachoUnenroll(
        { purge: true, reason: "laptop retired" },
        writer,
      ),
    ).toBe(true);
    expect(calls.at(-1)?.args[0]).toMatchObject({
      token: "session-token",
      org: "acme",
      workspace: "core",
      purge: true,
      reason: "laptop retired",
    });
    expect(await handleTachoExport({ list: true }, writer)).toBe(true);
    expect(calls.at(-1)?.args[0]).toEqual({ list: true });
    expect(await handleTachoVerify(writer)).toBe(true);
    expect(output()).toContain("OK: chained");
    outcomes.verify = { ok: false, detail: "daemon down" };
    expect(await handleTachoVerify(writer)).toBe(false);
    expect(output()).toContain("FAILED: daemon down");
  });
});

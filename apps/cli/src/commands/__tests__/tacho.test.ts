/**
 * `oxagen tacho` delegates to @oxagen/tacho/cli with the platform CLI's
 * credentials. Mocks: the config store and the tacho CLI module; no
 * filesystem or network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureWriter } from "../../lib/capture-writer.js";

const store: { token?: string; org?: string; ws?: string } = {};
const configWrites: Array<Record<string, unknown>> = [];
vi.mock("../../lib/config.js", () => ({
  getToken: () => store.token,
  getOrgId: () => store.org,
  getWorkspaceId: () => store.ws,
  getApiUrl: () => "https://api.test",
  writeConfig: (patch: Record<string, unknown>) => {
    configWrites.push(patch);
  },
}));

const calls: Array<{ name: string; args: unknown[] }> = [];
const outcomes = {
  enroll: { ok: true, warnings: [] as string[] },
  verify: { ok: true, detail: "chained" },
  status: { enrolled: true },
  unenroll: { ok: true },
  reassign: {
    ok: true,
    warnings: [] as string[],
    to: undefined as { org: string; workspace: string } | undefined,
  },
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
  reassign: async (...args: unknown[]) => {
    calls.push({ name: "reassign", args });
    return outcomes.reassign;
  },
  exportCommand: async (...args: unknown[]) => {
    calls.push({ name: "exportCommand", args });
    return outcomes.exportCommand;
  },
  // The real parser: a comma list of known harness names.
  parseHarnesses: (value?: string) =>
    value === undefined ? ["claude-code"] : value.split(","),
}));

import {
  handleTachoEnroll,
  handleTachoExport,
  handleTachoReassign,
  handleTachoStatus,
  handleTachoUnenroll,
  handleTachoVerify,
  tachoCredentials,
} from "../tacho.js";

describe("oxagen tacho", () => {
  beforeEach(() => {
    calls.length = 0;
    configWrites.length = 0;
    store.token = "session-token";
    store.org = "acme";
    store.ws = "core";
    outcomes.enroll = { ok: true, warnings: [] };
    outcomes.verify = { ok: true, detail: "chained" };
    outcomes.status = { enrolled: true };
    outcomes.reassign = { ok: true, warnings: [], to: undefined };
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
    // --harness reaches enroll as a parsed list; absent, it is not passed.
    await handleTachoEnroll({ harness: "claude-code,codex" }, writer);
    expect(calls.at(-1)?.args[0]).toMatchObject({
      harnesses: ["claude-code", "codex"],
    });
    expect(calls[0]?.args[0]).not.toHaveProperty("harnesses");
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
    expect(
      await handleTachoReassign(
        { workspace: "edge", harness: "codex", reason: "moved" },
        writer,
      ),
    ).toBe(true);
    expect(calls.at(-1)?.args[0]).toEqual({
      token: "session-token",
      workspace: "edge",
      harnesses: ["codex"],
      reason: "moved",
    });
    outcomes.reassign = { ok: false, warnings: [], to: undefined };
    expect(await handleTachoReassign({ workspace: "edge" }, writer)).toBe(
      false,
    );
    // Without --default the CLI's own config is never touched.
    expect(configWrites).toEqual([]);
    expect(await handleTachoExport({ list: true }, writer)).toBe(true);
    expect(calls.at(-1)?.args[0]).toEqual({ list: true });
    expect(await handleTachoVerify(writer)).toBe(true);
    expect(output()).toContain("OK: chained");
    outcomes.verify = { ok: false, detail: "daemon down" };
    expect(await handleTachoVerify(writer)).toBe(false);
    expect(output()).toContain("FAILED: daemon down");
  });

  it("reassign --default writes the host's new pair into config.json, and only after success", async () => {
    const { writer, output } = captureWriter();
    outcomes.reassign = {
      ok: true,
      warnings: [],
      to: { org: "other", workspace: "edge" },
    };
    expect(
      await handleTachoReassign(
        { org: "other", workspace: "edge", default: true },
        writer,
      ),
    ).toBe(true);
    // The flag never reaches @oxagen/tacho: config.json is the CLI's file.
    expect(calls.at(-1)?.args[0]).not.toHaveProperty("default");
    expect(configWrites).toEqual([{ orgSlug: "other", workspaceSlug: "edge" }]);
    expect(output()).toContain("CLI default is now other/edge");

    // The org the host keeps when --org is omitted is what gets written, so
    // the default can never point at an org the host does not report to.
    configWrites.length = 0;
    outcomes.reassign = {
      ok: true,
      warnings: [],
      to: { org: "acme", workspace: "edge" },
    };
    await handleTachoReassign({ workspace: "edge", default: true }, writer);
    expect(configWrites).toEqual([{ orgSlug: "acme", workspaceSlug: "edge" }]);

    // A failed reassign leaves the default where it was.
    configWrites.length = 0;
    outcomes.reassign = { ok: false, warnings: [], to: undefined };
    expect(
      await handleTachoReassign({ workspace: "edge", default: true }, writer),
    ).toBe(false);
    expect(configWrites).toEqual([]);
  });
});

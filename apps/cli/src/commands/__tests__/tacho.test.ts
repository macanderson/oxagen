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
// The real parser: what the operator sees on a typo is its message, so the
// mock must not paper over it. It is pulled in `vi.hoisted`, which runs while
// the file is evaluated, rather than inside the factory below. A factory is
// evaluated on the first import of the mocked id, and that first import
// happens inside the first test — so an `await vi.importActual` there spends
// the module graph's transform cost (~1.2s on an idle machine) out of that
// test's 5s budget. Under the nightly's parallel run over every package it
// spends more than the whole budget: the first test times out, and the
// half-applied mock then hands the second test the real `status`, which
// throws on the fake deps. That is nightly #35579035588 and #35442768833.
const { parseHarnesses: actualParseHarnesses } = await vi.hoisted(async () => {
  const actual =
    await vi.importActual<typeof import("@oxagen/tacho/cli")>(
      "@oxagen/tacho/cli",
    );
  return { parseHarnesses: actual.parseHarnesses };
});
vi.mock("@oxagen/tacho/cli", () => ({
  parseHarnesses: actualParseHarnesses,
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
      service: false,
      force: true,
    });
    // No apiUrl: an explicit one outranks the enrolled host's own API in
    // `enroll`, so `oxagen tacho enroll --harness codex` on a live host posted
    // the new enrollment to the CLI's default deployment while the revoke
    // went to the host's. tacho resolves the same config when there is no host.
    expect(calls[0]?.args[0]).not.toHaveProperty("apiUrl");
    expect((calls[0]?.args[1] as { fake: boolean }).fake).toBe(true);
    expect(output()).toContain("Verified: chained");
    // --harness reaches enroll as a parsed list; absent, it is not passed.
    await handleTachoEnroll({ harness: "claude-code,codex" }, writer);
    expect(calls.at(-1)?.args[0]).toMatchObject({
      harnesses: ["claude-code", "codex"],
    });
    expect(calls[0]?.args[0]).not.toHaveProperty("harnesses");
    // The real parser trims and dedupes, and an unknown name is one clear
    // line (the bin's fatal handler prints err.message verbatim) with no
    // enroll call behind it.
    await handleTachoEnroll({ harness: " codex, codex " }, writer);
    expect(calls.at(-1)?.args[0]).toMatchObject({ harnesses: ["codex"] });
    await handleTachoEnroll({ harness: "claude-code,cursor" }, writer);
    expect(calls.at(-1)?.args[0]).toMatchObject({
      harnesses: ["claude-code", "cursor"],
    });
    const before = calls.length;
    await expect(
      handleTachoEnroll({ harness: "vscode" }, writer),
    ).rejects.toThrow(
      'unknown harness "vscode"; expected one of claude-code, codex, cursor, stella',
    );
    expect(calls.length).toBe(before);
    await expect(
      handleTachoReassign({ harness: "claude_code" }, writer),
    ).rejects.toThrow(/unknown harness "claude_code"/);
    expect(calls.length).toBe(before);
    // The managed-settings flags and an explicit port travel too.
    await handleTachoEnroll(
      { managed: true, printManaged: true, port: 47010 },
      writer,
    );
    expect(calls.at(-1)?.args[0]).toMatchObject({
      managed: true,
      printManaged: true,
      port: 47010,
    });
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
    // Only the token is lent to unenroll: the revoke goes to the org and
    // workspace in host.json, never to the CLI's default pair, which may
    // name another org and would 403 the revoke.
    expect(calls.at(-1)?.args[0]).toEqual({
      token: "session-token",
      purge: true,
      reason: "laptop retired",
    });
    store.token = undefined;
    expect(await handleTachoUnenroll({}, writer)).toBe(true);
    expect(calls.at(-1)?.args[0]).toEqual({});
    store.token = "session-token";
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
    // Moving org too: the flag names the target, and a session without a
    // token sends none rather than an undefined field.
    store.token = undefined;
    await handleTachoReassign({ org: "beta", workspace: "edge" }, writer);
    expect(calls.at(-1)?.args[0]).toEqual({ org: "beta", workspace: "edge" });
    store.token = "session-token";
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

    // The pair written is the one the host reports (from host.json, via
    // result.to), not the flags or the CLI's saved default: here config.json
    // says acme, no --org is passed, and the host was enrolled in beta, so
    // beta/edge is what lands. A write built from the flags or getOrgId()
    // would put acme there — an org the host does not report to.
    configWrites.length = 0;
    outcomes.reassign = {
      ok: true,
      warnings: [],
      to: { org: "beta", workspace: "edge" },
    };
    await handleTachoReassign({ workspace: "edge", default: true }, writer);
    expect(configWrites).toEqual([{ orgSlug: "beta", workspaceSlug: "edge" }]);
    expect(JSON.stringify(configWrites)).not.toContain("acme");
    expect(output()).toContain("CLI default is now beta/edge");

    // A failed reassign leaves the default where it was.
    configWrites.length = 0;
    outcomes.reassign = { ok: false, warnings: [], to: undefined };
    expect(
      await handleTachoReassign({ workspace: "edge", default: true }, writer),
    ).toBe(false);
    expect(configWrites).toEqual([]);
  });
});

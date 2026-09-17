/**
 * `oxagen agent enroll --token` hands the one-time token to @oxagen/tacho/cli's
 * `enroll` with no session, org or workspace: the token is the credential and
 * the control plane names the tenant. Mocks: the config store and the tacho
 * CLI module; no filesystem or network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/config.js", () => ({
  getApiUrl: () => "https://api.test",
}));

const calls: Array<{ name: string; args: unknown[] }> = [];
const outcomes = { enroll: { ok: true, warnings: [] as string[] } };
vi.mock("@oxagen/tacho/cli", () => ({
  defaultCliDeps: (overrides: Record<string, unknown>) => ({
    fake: true,
    ...overrides,
  }),
  enroll: async (...args: unknown[]) => {
    calls.push({ name: "enroll", args });
    return outcomes.enroll;
  },
  parseHarnesses: (value?: string) =>
    value === undefined ? ["claude-code"] : value.split(","),
}));

import { handleAgentEnroll } from "../agent-enroll.js";

describe("oxagen agent enroll", () => {
  beforeEach(() => {
    calls.length = 0;
    outcomes.enroll = { ok: true, warnings: [] };
  });

  it("passes the token and the API URL, and no session credentials", async () => {
    const { writer } = captureWriter();
    const ok = await handleAgentEnroll(
      { token: "oxe_1time_0123456789abcdefghjkmnpqrs", harness: "codex" },
      writer,
    );
    expect(ok).toBe(true);
    expect(calls).toHaveLength(1);
    const [options] = calls[0]!.args as [Record<string, unknown>];
    expect(options).toEqual({
      enrollmentToken: "oxe_1time_0123456789abcdefghjkmnpqrs",
      apiUrl: "https://api.test",
      harnesses: ["codex"],
    });
    expect(options).not.toHaveProperty("token");
    expect(options).not.toHaveProperty("org");
  });

  it("reports the routine's refusal as a failed command", async () => {
    outcomes.enroll = { ok: false, warnings: [] };
    expect(
      await handleAgentEnroll(
        { token: "oxe_1time_0123456789abcdefghjkmnpqrs" },
        captureWriter().writer,
      ),
    ).toBe(false);
  });
});

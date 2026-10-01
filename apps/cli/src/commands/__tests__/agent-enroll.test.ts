/**
 * `oxagen agent enroll --token` hands the one-time token to @oxagen/recorder/cli's
 * `enroll` with no session, org or workspace: the token is the credential and
 * the control plane names the tenant. Mocks: the config store and the
 * recorder's CLI module; no filesystem or network.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { captureWriter } from "../../lib/capture-writer.js";

vi.mock("../../lib/config.js", () => ({
  getApiUrl: () => "https://api.test",
}));

const calls: Array<{ name: string; args: unknown[] }> = [];
const outcomes = { enroll: { ok: true, warnings: [] as string[] } };
const OXAGEN_RUNTIME = { hookCommand: "/opt/oxagen/oxagen hook" };
vi.mock("@oxagen/recorder/cli", () => ({
  defaultCliDeps: (overrides: Record<string, unknown>) => ({
    fake: true,
    ...overrides,
  }),
  oxagenRuntimeCommands: () => OXAGEN_RUNTIME,
  moveOffTachoNames: async (...args: unknown[]) => {
    calls.push({ name: "move", args });
    return [];
  },
  enroll: async (...args: unknown[]) => {
    calls.push({ name: "enroll", args });
    return outcomes.enroll;
  },
  parseHarnesses: (value?: string) =>
    value === undefined ? ["claude-code"] : value.split(","),
  parseCredentialMode: (value: string) => value,
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
    // The enroll, then the move of any agent still on the tacho names.
    expect(calls.map((call) => call.name)).toEqual(["enroll", "move"]);
    const [options, deps] = calls[0]!.args as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    // What the enroll writes into the machine names this executable.
    expect(deps["runtime"]).toBe(OXAGEN_RUNTIME);
    expect(options).toEqual({
      enrollmentToken: "oxe_1time_0123456789abcdefghjkmnpqrs",
      apiUrl: "https://api.test",
      harnesses: ["codex"],
    });
    expect(options).not.toHaveProperty("token");
    expect(options).not.toHaveProperty("org");
  });

  it("passes an explicit API URL, credential mode, and validity", async () => {
    const { writer } = captureWriter();
    await handleAgentEnroll(
      {
        token: "oxe_1time_0123456789abcdefghjkmnpqrs",
        apiUrl: "https://api.example",
        credentials: "passthrough",
        validityDays: 30,
      },
      writer,
    );
    expect(calls[0]?.args[0]).toEqual({
      enrollmentToken: "oxe_1time_0123456789abcdefghjkmnpqrs",
      apiUrl: "https://api.example",
      credentials: "passthrough",
      validityDays: 30,
    });
  });

  it("reports the routine's refusal as a failed command, and moves nothing", async () => {
    outcomes.enroll = { ok: false, warnings: [] };
    expect(
      await handleAgentEnroll(
        { token: "oxe_1time_0123456789abcdefghjkmnpqrs" },
        captureWriter().writer,
      ),
    ).toBe(false);
    expect(calls.map((call) => call.name)).toEqual(["enroll"]);
  });
});

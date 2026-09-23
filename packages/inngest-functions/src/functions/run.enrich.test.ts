import { beforeEach, describe, expect, it, vi } from "vitest";
import { digestBytes } from "@oxagen/tacho";
import { tachoFrame } from "@oxagen/run-ledger";
const state = vi.hoisted(() => ({
  enabled: true,
  digest: null as string | null,
  writes: [] as Record<string, unknown>[],
  call: vi.fn(),
  bodies: new Map<string, Uint8Array>(),
  handlers: new Map<string, (ctx: unknown) => Promise<unknown>>(),
}));
vi.mock("../create-function", () => ({
  createFunction: (
    _opts: unknown,
    trigger: { event?: string },
    handler: (ctx: unknown) => Promise<unknown>,
  ) => {
    state.handlers.set(trigger.event ?? "sweep", handler);
    return [handler];
  },
}));
vi.mock("@oxagen/database", async (original) => {
  const actual = await original<typeof import("@oxagen/database")>();
  return {
    ...actual,
    withTenantDb: async (fn: (tx: unknown) => unknown) =>
      fn({
        select: () => ({
          from: (table: unknown) => ({
            where: () => ({
              limit: async () =>
                table === actual.schema.workspaces
                  ? [{ settings: { runEnrichmentEnabled: state.enabled } }]
                  : [
                      {
                        digest: state.digest,
                        name: state.digest ? "Prior account" : null,
                      },
                    ],
            }),
          }),
        }),
        update: () => ({
          set: (value: Record<string, unknown>) => ({
            where: async () => {
              state.writes.push(value);
              if (typeof value.summaryInputDigest === "string")
                state.digest = value.summaryInputDigest;
            },
          }),
        }),
      }),
  };
});
vi.mock("@oxagen/tenancy", () => ({
  runInTenantScope: (_scope: unknown, fn: () => unknown) => fn(),
}));
vi.mock("../lib/run-enrichment", async (original) => ({
  ...(await original<typeof import("../lib/run-enrichment")>()),
  runNarrativeTurn: state.call,
}));
vi.mock("@oxagen/agent", () => ({ runGovernedTurn: vi.fn() }));
vi.mock("@oxagen/run-ledger/evidence-store", () => ({
  evidenceStore: () => ({
    put: async ({ bytes, digest }: { bytes: Uint8Array; digest: string }) => {
      state.bodies.set(digest, bytes);
      return { ref: digest };
    },
    getBody: async (_scope: unknown, ref: string) => ({
      bytes:
        state.bodies.get(ref) ??
        new TextEncoder().encode(
          "Please repair authentication. Fixed the redirect.",
        ),
    }),
  }),
}));
vi.mock("../lib/run-record", () => ({
  resolveRunRecord: async () => ({ source: "tacho", sessionUuid: "session" }),
  readRunFrames: async () => [
    tachoFrame({
      seq: 1,
      ts: "2026-09-22 00:00:00.000",
      kind: "user_prompt",
      hash: `sha256:${"a".repeat(64)}`,
      contentDigest: digestBytes(
        new TextEncoder().encode(
          "Please repair authentication. Fixed the redirect.",
        ),
      ),
      bytesRef: "body",
      redactions: "",
      toolName: "",
      toolStatus: "",
      toolUseId: "",
      model: "",
      provider: "",
      policyDecision: "",
      costUsdMicros: null,
      turnSeq: 1,
    }),
  ],
}));
await import("./run.enrich");
const data = {
  orgId: "00000000-0000-4000-8000-000000000001",
  workspaceId: "00000000-0000-4000-8000-000000000002",
  runPublicId: "tse_12345678",
};
const run = () =>
  state.handlers.get("run/enrich")!({
    event: { data },
    events: [{ data }],
    step: { run: (_name: string, fn: () => unknown) => fn() },
  });
beforeEach(() => {
  state.enabled = true;
  state.digest = null;
  state.writes = [];
  state.call.mockReset();
  state.call.mockResolvedValue({
    text: JSON.stringify({
      name: "Repair authentication",
      summary: "Fixed the authentication redirect.",
    }),
    model: "fast-test",
  });
});
describe("automatic run enrichment", () => {
  it("writes a generated account, then avoids charging for the identical input", async () => {
    expect(await run()).toMatchObject({ status: "generated" });
    expect(state.writes.at(-1)).toMatchObject({
      name: "Repair authentication · tse_12345678",
      summaryModel: "fast-test",
    });
    expect(await run()).toMatchObject({ status: "unchanged" });
    expect(state.call).toHaveBeenCalledTimes(1);
  });
  it("does not call Stella or erase evidence when the workspace switches it off", async () => {
    state.enabled = false;
    expect(await run()).toEqual({ status: "disabled" });
    expect(state.call).not.toHaveBeenCalled();
    expect(state.writes).toHaveLength(1);
    expect(Object.keys(state.writes[0]!)).toEqual(["summaryObservedAt"]);
  });
  it("does not persist an invented account when Stella or credit admission fails", async () => {
    state.call.mockRejectedValue(new Error("credit gate refused"));
    await expect(run()).rejects.toThrow("credit gate refused");
    expect(state.writes).toHaveLength(0);
  });
});

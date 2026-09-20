import { describe, expect, expectTypeOf, it, vi } from "vitest";
import type { DataSource } from "@/data/ports";
import { readError, readOk } from "@/data/read";
import { mandateSource } from "@/features/mandate/mandate.builders";
import { refusingSource, type SourceOverrides } from "./refusing-source";

vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const ctx = unsafeMint(WsCtx, {
  userId: "usr_fixture",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core",
  wsName: "Core",
  wsRole: "owner",
});

describe("refusingSource", () => {
  it("rejects every unused method with the fixture's feature name", async () => {
    const source = refusingSource("Coverage probe");
    for (const port of Object.values(source)) {
      for (const read of Object.values<(...args: never[]) => Promise<unknown>>(
        port,
      )) {
        // Refusing methods read no arguments; this call checks every default.
        await expect(read()).rejects.toThrow("not a Coverage probe read");
      }
    }
  });

  it("preserves an override and refuses its siblings and other groups", async () => {
    const result = readOk({ orgs: [], workspaces: [] });
    const list = vi
      .fn<DataSource["shell"]["context"]>()
      .mockResolvedValue(result);
    const source = refusingSource("Organization", { shell: { context: list } });
    await expect(source.shell.context(ctx)).resolves.toBe(result);
    expect(list).toHaveBeenCalledWith(ctx);
    await expect(source.shell.preferences(ctx)).rejects.toThrow("Organization");
    await expect(source.org.roles(ctx)).rejects.toThrow("Organization");
  });

  it("does not let an undefined override remove a refusal", async () => {
    const source = refusingSource("Missing", { shell: { context: undefined } });
    await expect(source.shell.context(ctx)).rejects.toThrow("Missing");
  });

  it("keeps separately built sources isolated", async () => {
    const first = refusingSource("First", {
      shell: { context: async () => readError("expected", 503) },
    });
    const second = refusingSource("Second");
    expect(first.shell).not.toBe(second.shell);
    await expect(first.shell.context(ctx)).resolves.toEqual(
      readError("expected", 503),
    );
    await expect(second.shell.context(ctx)).rejects.toThrow("Second");
  });

  it("keeps a feature builder's answer and call recording while rejecting other reads", async () => {
    const result = readError("mandate_unavailable", 503);
    const { source, calls } = mandateSource(result);
    await expect(source.mandates.get(ctx, "mnd_fixture")).resolves.toBe(result);
    expect(calls).toEqual([[ctx, "mnd_fixture"]]);
    await expect(source.mandates.list(ctx, { agentId: null })).rejects.toThrow(
      "Mandate",
    );
    await expect(source.org.roles(ctx)).rejects.toThrow("Mandate");
  });

  it("keeps existing fixture overrides valid when a method and a port are added", () => {
    type Expanded = Omit<DataSource, "shell"> & {
      shell: DataSource["shell"] & { added: DataSource["shell"]["context"] };
      addedGroup: { added: DataSource["shell"]["context"] };
    };
    const overrides = {
      shell: { context: async () => readError("expected", 503) },
    } satisfies SourceOverrides;
    expectTypeOf(overrides).toMatchTypeOf<SourceOverrides<Expanded>>();
    const expanded: SourceOverrides<Expanded> = overrides;
    expect(expanded).toBe(overrides);
  });
});

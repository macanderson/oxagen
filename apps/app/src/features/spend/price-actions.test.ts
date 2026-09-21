// The two price-book writes through the real kernel seam (INV-19): the viewer
// and the kernel's invoke() are the only fakes, so each case shows what the
// person gets back and whether the capability ran. A figure the form refuses
// never reaches the kernel; a role the handler refuses comes back as denied.
import { costPriceEntryRemove } from "@oxagen/oxagen/contracts/cost.price_entry.remove";
import { costPriceEntrySet } from "@oxagen/oxagen/contracts/cost.price_entry.set";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, requireViewer } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  requireViewer: vi.fn(),
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
vi.mock("@/server/viewer", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/viewer")>()),
  requireViewer,
}));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { removePriceEntryAction, setPriceEntryAction } = await import(
  "./actions"
);

const at = { org: "acme", ws: "core-platform" };
const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "billing",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const form = {
  provider: "anthropic",
  model: "claude-sonnet-5",
  region: "",
  modelAliases: "",
  effectiveFrom: "",
  tokenClass: "output",
  usdPerMillion: "2.40",
};

const entry = {
  id: "9f1b7a2c-0000-4000-8000-000000000001",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  provider: "anthropic",
  model: "claude-sonnet-5",
  modelAliases: [],
  region: null,
  tokenClass: "output",
  unit: "token",
  currency: "USD",
  microsPerMillion: "2400000",
  effectiveFrom: "2026-09-17T00:00:00.000Z",
  effectiveTo: null,
  source: "negotiated",
};

const forbidden = () =>
  new kernel.HandlerError({
    code: "forbidden",
    reason: "org_role_required",
    message: "Requires one of the org roles Owner, Admin, Billing",
  });

beforeEach(() => {
  invoke.mockReset();
  requireViewer.mockReset().mockResolvedValue(ctx);
});

describe("setPriceEntryAction", () => {
  it("resolves the viewer for the page's workspace and refuses a rate that is not an amount, writing nothing (negative)", async () => {
    expect(
      await setPriceEntryAction(at, { ...form, usdPerMillion: "2,40" }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "rateInvalid",
      field: "usdPerMillion",
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([
    ["a rate carrying a seventh decimal place", { usdPerMillion: "2.4000001" }],
    ["no model", { model: "  " }],
    ["no vendor", { provider: "" }],
    ["a class the book does not price", { tokenClass: "thinking" }],
    ["a date that is not a UTC day", { effectiveFrom: "17/09/2026" }],
  ])("refuses %s, writing nothing (negative)", async (_case, over) => {
    const result = await setPriceEntryAction(at, { ...form, ...over });
    expect(result.ok).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal as denied (negative)", async () => {
    invoke.mockRejectedValue(forbidden());
    expect(await setPriceEntryAction(at, form)).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });

  it("states the rate in USD per million through set_price_entry, region-agnostic and starting now", async () => {
    invoke.mockResolvedValue({ entry, closed: null });
    expect(await setPriceEntryAction(at, form)).toEqual({
      ok: true,
      value: null,
    });
    expect(invoke).toHaveBeenCalledWith(
      costPriceEntrySet.name,
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        tokenClass: "output",
        region: null,
        usdPerMillion: 2.4,
      },
      expect.objectContaining({
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
      }),
    );
  });

  it("carries the aliases and the day the rate starts", async () => {
    invoke.mockResolvedValue({ entry, closed: null });
    await setPriceEntryAction(at, {
      ...form,
      modelAliases: "claude-sonnet-5-20260401, anthropic/claude-sonnet-5",
      effectiveFrom: "2026-10-01",
    });
    expect(invoke).toHaveBeenCalledWith(
      costPriceEntrySet.name,
      expect.objectContaining({
        modelAliases: ["claude-sonnet-5-20260401", "anthropic/claude-sonnet-5"],
        effectiveFrom: "2026-10-01T00:00:00.000Z",
      }),
      expect.anything(),
    );
  });

  // The dialog takes ONE instant for a whole card and sends it with every
  // class, so the form must pass an instant through unchanged rather than
  // refuse it as "not a day" or widen it to a midnight it never named.
  it("passes an instant the dialog took for the whole card through unchanged", async () => {
    invoke.mockResolvedValue({ entry, closed: null });
    await setPriceEntryAction(at, {
      ...form,
      effectiveFrom: "2026-09-17T14:03:27.512Z",
    });
    expect(invoke).toHaveBeenCalledWith(
      costPriceEntrySet.name,
      expect.objectContaining({ effectiveFrom: "2026-09-17T14:03:27.512Z" }),
      expect.anything(),
    );
  });

  it("refuses an instant that is not UTC, or that names no real time (negative)", async () => {
    for (const effectiveFrom of [
      "2026-09-17T14:03:27.512+02:00",
      "2026-02-30T00:00:00.000Z",
    ]) {
      const result = await setPriceEntryAction(at, { ...form, effectiveFrom });
      expect(result).toMatchObject({
        ok: false,
        reason: "invalid",
        field: "effectiveFrom",
      });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  // The dialog stopped collecting a region: nothing on the pricing path reads
  // `PriceEntry.region`, so a regional row would be a candidate everywhere and
  // `set_price_entry` refuses one. The form shape keeps the optional field for
  // when resolution can honour it, and omitting it must still mean "any".
  it("states the region-agnostic row when the form names no region", async () => {
    invoke.mockResolvedValue({ entry, closed: null });
    const { region: _region, ...withoutRegion } = form;
    await setPriceEntryAction(at, withoutRegion);
    expect(invoke).toHaveBeenCalledWith(
      costPriceEntrySet.name,
      expect.objectContaining({ region: null }),
      expect.anything(),
    );
  });

  it("sends no alias list where the person typed none, so the stored names are kept rather than replaced", async () => {
    invoke.mockResolvedValue({ entry, closed: null });
    await setPriceEntryAction(at, form);
    const [, input] = invoke.mock.calls[0] ?? [];
    expect(input).not.toHaveProperty("modelAliases");
    expect(input).not.toHaveProperty("effectiveFrom");
  });
});

describe("removePriceEntryAction", () => {
  const key = {
    provider: "anthropic",
    model: "claude-sonnet-5",
    region: "",
    tokenClass: "output",
  };

  it("preserves the selected scheduled entry through the form and kernel write", async () => {
    invoke.mockResolvedValue({
      at: "2026-09-15T00:00:00Z",
      closed: null,
      fallbackPriced: true,
    });
    const result = await removePriceEntryAction(at, {
      provider: "anthropic",
      model: "claude-sonnet-5",
      region: "",
      tokenClass: "output",
      cancellationToken: entry.id,
    });
    expect(result.ok).toBe(true);
    expect(invoke).toHaveBeenCalledWith(
      costPriceEntryRemove.name,
      expect.objectContaining({ cancellationToken: entry.id }),
      expect.anything(),
    );
  });

  it("refuses a class the book does not price, ending nothing (negative)", async () => {
    expect(
      await removePriceEntryAction(at, { ...key, tokenClass: "thinking" }),
    ).toEqual({
      ok: false,
      reason: "invalid",
      code: "tokenClassInvalid",
      field: "tokenClass",
    });
    expect(requireViewer).toHaveBeenCalledWith("acme", "core-platform");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("returns the handler's role refusal as denied (negative)", async () => {
    invoke.mockRejectedValue(forbidden());
    expect(await removePriceEntryAction(at, key)).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });

  it("ends the negotiated row by its key through remove_price_entry", async () => {
    invoke.mockResolvedValue({
      at: "2026-09-17T12:00:00.000Z",
      closed: { ...entry, effectiveTo: "2026-09-17T12:00:00.000Z" },
      fallbackPriced: true,
    });
    expect(await removePriceEntryAction(at, key)).toEqual({
      ok: true,
      value: { fallbackPriced: true },
    });
    expect(invoke).toHaveBeenCalledWith(
      costPriceEntryRemove.name,
      {
        provider: "anthropic",
        model: "claude-sonnet-5",
        tokenClass: "output",
        region: null,
      },
      expect.objectContaining({ workspaceId: ctx.workspaceId }),
    );
  });

  // The class this row priced has no list or override fallback: the action
  // must carry that through rather than defaulting to the usual claim.
  it("carries fallbackPriced: false through when the class has no fallback price", async () => {
    invoke.mockResolvedValue({
      at: "2026-09-17T12:00:00.000Z",
      closed: { ...entry, effectiveTo: "2026-09-17T12:00:00.000Z" },
      fallbackPriced: false,
    });
    expect(await removePriceEntryAction(at, key)).toEqual({
      ok: true,
      value: { fallbackPriced: false },
    });
  });

  it("answers a class this organization had already ended without failing, since the retry is a no-op", async () => {
    invoke.mockResolvedValue({
      at: "2026-09-17T12:00:00.000Z",
      closed: null,
      fallbackPriced: true,
    });
    expect(await removePriceEntryAction(at, key)).toEqual({
      ok: true,
      value: { fallbackPriced: true },
    });
  });

  // The handler refuses a close that would leave the class unpriced unless
  // the caller states it. The action is a plain relay of that refusal.
  it("relays the handler's refusal to close an unfallbacked rate as conflict", async () => {
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "conflict",
        reason: "price_entry_close_would_unprice",
      }),
    );
    expect(await removePriceEntryAction(at, key)).toEqual({
      ok: false,
      reason: "conflict",
      code: "price_entry_close_would_unprice",
    });
  });

  it("carries confirmUnpriced through to the handler once the person confirms", async () => {
    invoke.mockResolvedValue({
      at: "2026-09-17T12:00:00.000Z",
      closed: { ...entry, effectiveTo: "2026-09-17T12:00:00.000Z" },
      fallbackPriced: false,
    });
    await removePriceEntryAction(at, { ...key, confirmUnpriced: true });
    expect(invoke).toHaveBeenCalledWith(
      costPriceEntryRemove.name,
      expect.objectContaining({ confirmUnpriced: true }),
      expect.anything(),
    );
  });
});

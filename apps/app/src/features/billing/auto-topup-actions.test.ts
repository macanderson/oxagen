// The auto top-up action through the real viewer and kernel seams: the session,
// the organization lookups and the kernel's invoke() are the only fakes, so
// each case shows what the person gets back and whether set_auto_topup ran.
//
// It sits beside actions.test.ts rather than inside it because the two suites
// stub the same seams differently — this one holds `systemLookups` as vi.fn()
// spies it reconfigures per case, and the purchase suite pins them to literals.
// One file would have to give one of them up; two files keep both harnesses as
// their authors wrote them, and vitest runs each against the same module.
import { billingAutoTopupSet } from "@oxagen/oxagen/contracts/billing.auto_topup.set";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgRole } from "@/data/contracts/common";

const { invoke, getSession, lookups, nav } = vi.hoisted(() => ({
  invoke: vi.fn<typeof import("@oxagen/oxagen").invoke>(),
  getSession: vi.fn(),
  lookups: {
    orgBySlug: vi.fn(),
    orgBySlugHistory: vi.fn(() => Promise.resolve(null)),
    orgRole: vi.fn<() => Promise<string | null>>(),
    mfaPolicy: vi.fn(() => Promise.resolve(null)),
    ssoPolicy: vi.fn(() => Promise.resolve(null)),
    twoFactorEnabled: vi.fn(() => Promise.resolve(false)),
  },
  nav: {
    redirect: vi.fn((url: string) => {
      throw new Error(`NEXT_REDIRECT ${url}`);
    }),
    // `./actions` now also carries purchaseGau, which pulls in
    // @/shared/navigation; that module imports permanentRedirect at module
    // scope, so the mock has to export it or the import throws.
    permanentRedirect: vi.fn((url: string) => {
      throw new Error(`NEXT_REDIRECT ${url}`);
    }),
    notFound: vi.fn(() => {
      throw new Error("NEXT_NOT_FOUND");
    }),
  },
}));
vi.mock("@oxagen/oxagen", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@oxagen/oxagen")>()),
  invoke,
}));
vi.mock("@oxagen/telemetry", () => ({ captureError: vi.fn() }));
vi.mock("@oxagen/handlers/register", () => ({}));
vi.mock("@oxagen/agent/register", () => ({}));
vi.mock("next/navigation", () => nav);
// requireViewer defers its clock read behind connection(), which needs a request scope.
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  connection: () => Promise.resolve(),
}));
vi.mock("@/server/session", () => ({ getSession }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: lookups }));

const kernel =
  await vi.importActual<typeof import("@oxagen/oxagen")>("@oxagen/oxagen");
const { setAutoTopup } = await import("./actions");

const ACME = {
  id: "7a000000-0000-4000-8000-0000000000a1",
  publicId: "org_acme",
  slug: "acme",
  name: "Acme Robotics",
};
const ORG_ONLY_WS = "00000000-0000-0000-0000-000000000000";

function signedInAs(role: OrgRole) {
  lookups.orgRole.mockResolvedValue(role);
}

beforeEach(() => {
  invoke.mockReset();
  getSession.mockResolvedValue({
    user: { id: "u-marcus", email: "marcus@acme.example" },
    session: { createdAt: new Date("2026-09-15T08:00:00Z") },
  });
  lookups.orgBySlug.mockImplementation((slug: string) =>
    Promise.resolve(slug === ACME.slug ? ACME : null),
  );
  signedInAs("owner");
});

describe("setAutoTopup", () => {
  it("sends a signed-out visitor to log in, writing nothing (negative)", async () => {
    getSession.mockResolvedValue(null);
    await expect(
      setAutoTopup("acme", { enabled: true, blocks: 2 }),
    ).rejects.toThrow("NEXT_REDIRECT /login");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("treats an organization the person does not belong to as not found, writing nothing (negative)", async () => {
    lookups.orgRole.mockResolvedValue(null);
    await expect(
      setAutoTopup("acme", { enabled: true, blocks: 2 }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each([0, 101, 2.5, Number.NaN, -1])(
    "refuses %s blocks on the blocks field, writing nothing (negative)",
    async (blocks) => {
      expect(await setAutoTopup("acme", { enabled: true, blocks })).toEqual({
        ok: false,
        reason: "invalid",
        code: "invalid_input",
        field: "blocks",
      });
      expect(invoke).not.toHaveBeenCalled();
    },
  );

  it("returns the handler's refusal of a Member as denied (negative)", async () => {
    signedInAs("member");
    invoke.mockRejectedValue(
      new kernel.HandlerError({
        code: "forbidden",
        reason: "org_role_required",
      }),
    );
    expect(await setAutoTopup("acme", { enabled: false, blocks: 1 })).toEqual({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
  });

  it.each(["owner", "admin"] as const)(
    "saves the setting for an %s in the organization it resolved and returns the values as stored",
    async (role) => {
      signedInAs(role);
      invoke.mockResolvedValue({ enabled: true, blocks: 3 });
      expect(
        await setAutoTopup("acme", { enabled: false, blocks: 100 }),
      ).toEqual({ ok: true, value: { enabled: true, blocks: 3 } });
      expect(invoke).toHaveBeenCalledOnce();
      expect(invoke).toHaveBeenCalledWith(
        billingAutoTopupSet.name,
        { enabled: false, blocks: 100 },
        expect.objectContaining({
          userId: "u-marcus",
          orgId: ACME.id,
          workspaceId: ORG_ONLY_WS,
          surface: "app",
        }),
      );
    },
  );
});

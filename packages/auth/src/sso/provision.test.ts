import { describe, expect, it, vi } from "vitest";
import { createSsoProvisioner, type SsoProvisioningStore } from "./provision";

const ORG = "org-1";
const provider = { providerId: "acme", organizationId: ORG };
const user = { id: "u1", email: "a@acme.com" };

function setup(opts: {
  current?: string | null;
  mappings?: {
    group: string;
    role: "admin" | "compliance" | "billing" | "member";
  }[];
  failApply?: boolean;
  entitled?: boolean;
  scimSuspended?: boolean;
}) {
  const store: SsoProvisioningStore = {
    entitled: vi.fn(async () => opts.entitled ?? true),
    groupRoles: vi.fn(async () => opts.mappings ?? []),
    currentRole: vi.fn(async () => opts.current ?? null),
    applyRole: vi.fn(async () => {
      if (opts.failApply) throw new Error("db down");
      return opts.scimSuspended
        ? ("scim_suspended" as const)
        : ("applied" as const);
    }),
  };
  const emit = vi.fn();
  return { store, emit, provision: createSsoProvisioner({ store, emit }) };
}

describe("createSsoProvisioner", () => {
  it("refuses a sign-in into an organisation whose plan lacks SSO", async () => {
    const { store, emit, provision } = setup({
      entitled: false,
      current: "admin",
      mappings: [{ group: "a", role: "admin" }],
    });
    await expect(
      provision({ user, provider, userInfo: { groups: ["a"] } }),
    ).rejects.toThrow(/Enterprise plan/);
    expect(store.currentRole).not.toHaveBeenCalled();
    expect(store.applyRole).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "sso.sign_in",
        outcome: "deny",
        detail: expect.objectContaining({ reason: "not_entitled" }),
      }),
    );
  });

  it("grants the highest-ranked mapped role", async () => {
    const { store, emit, provision } = setup({
      mappings: [
        { group: "all", role: "member" },
        { group: "fin", role: "billing" },
      ],
    });
    const out = await provision({
      user,
      provider,
      userInfo: { groups: ["all", "fin"] },
    });
    expect(out).toEqual({
      grantedRole: "billing",
      previousRole: null,
      reason: "mapped",
    });
    expect(store.applyRole).toHaveBeenCalledWith({
      orgId: ORG,
      userId: "u1",
      role: "billing",
      providerId: "acme",
    });
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "sso.sign_in", outcome: "success" }),
    );
  });

  it("does not write when the role is unchanged", async () => {
    const { store, provision } = setup({
      current: "admin",
      mappings: [{ group: "a", role: "admin" }],
    });
    await provision({ user, provider, userInfo: { groups: ["a"] } });
    expect(store.applyRole).not.toHaveBeenCalled();
  });

  it("denies by default and does not write for a non-member", async () => {
    const { store, emit, provision } = setup({
      mappings: [{ group: "a", role: "admin" }],
    });
    const out = await provision({
      user,
      provider,
      userInfo: { groups: "b, c" },
    });
    expect(out.reason).toBe("no_mapped_group");
    expect(store.applyRole).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "deny",
        detail: expect.objectContaining({ groups: ["b", "c"] }),
      }),
    );
  });

  it("removes the role of a member whose groups no longer map", async () => {
    const { store, provision } = setup({ current: "billing", mappings: [] });
    await provision({ user, provider, userInfo: {} });
    expect(store.applyRole).toHaveBeenCalledWith(
      expect.objectContaining({ role: null }),
    );
  });

  it("does not admit a person a SCIM deprovision suspended, and records why", async () => {
    const { emit, provision } = setup({
      mappings: [{ group: "a", role: "admin" }],
      scimSuspended: true,
    });
    const out = await provision({
      user,
      provider,
      userInfo: { groups: ["a"] },
    });
    expect(out).toEqual({
      grantedRole: null,
      previousRole: null,
      reason: "scim_deprovisioned",
    });
    expect(emit).toHaveBeenCalledOnce();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "deny",
        detail: expect.objectContaining({
          grantedRole: null,
          reason: "scim_deprovisioned",
        }),
      }),
    );
  });

  it("never touches an Owner", async () => {
    const { store, emit, provision } = setup({ current: "owner" });
    const out = await provision({ user, provider, userInfo: { groups: [] } });
    expect(out.reason).toBe("owner_unmanaged");
    expect(store.groupRoles).not.toHaveBeenCalled();
    expect(store.applyRole).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: expect.objectContaining({ reason: "owner_unmanaged" }),
      }),
    );
  });

  it("fails closed and records the error when the write fails", async () => {
    const { emit, provision } = setup({
      mappings: [{ group: "a", role: "admin" }],
      failApply: true,
    });
    await expect(
      provision({ user, provider, userInfo: { groups: ["a"] } }),
    ).rejects.toThrow("db down");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "error",
        detail: expect.objectContaining({ reason: "provision_failed" }),
      }),
    );
  });

  it("refuses a provider with no organisation", async () => {
    const { provision } = setup({});
    await expect(
      provision({ user, provider: { providerId: "x" }, userInfo: {} }),
    ).rejects.toThrow(/no organization/);
  });

  it("caps the groups kept on the audit row", async () => {
    const { emit, provision } = setup({});
    const groups = Array.from({ length: 80 }, (_, i) => `g${i}`);
    await provision({ user, provider, userInfo: { groups } });
    expect(emit.mock.calls[0]![0].detail.groups).toHaveLength(50);
  });
});
